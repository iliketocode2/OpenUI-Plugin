import { randomUUID } from 'node:crypto';
import type { OwuiClient, RetryInfo } from '../owui/client';
import { HttpError, MissingApiKeyError, isAbortError } from '../owui/errors';
import type { ResolvedModel } from '../owui/models';
import { stripThinkTags } from '../owui/reasoning';
import type { StreamDelta } from '../owui/streamAssembler';
import { checkTruncation, measurePrompt, outputReserve, preflight, type TokenCalibrator } from '../owui/tokens';
import type { AssistantTurn, Usage, WireMessage } from '../owui/types';
import type { TranscriptItem, UsageView } from '../shared/protocol';

type AssistantItem = Extract<TranscriptItem, { kind: 'assistant' }>;

export interface SessionEvents {
  changed(): void;
  delta(id: string, delta: StreamDelta): void;
  usage(model: ResolvedModel, usage: Usage | null): void;
}

export interface RunContext {
  model: ResolvedModel;
  systemPrompt: string;
  calibrator: TokenCalibrator;
  warnOnce(key: string, text: string): void;
}

const USAGE_HELP =
  'Open WebUI did not report token usage for this model, so prompt-truncation detection is unavailable. ' +
  'To enable it: Admin Panel → Settings → Models → edit the model → Capabilities → enable "Usage", then Save.';

export class ChatSession {
  readonly id = randomUUID();
  readonly transcript: TranscriptItem[] = [];
  private readonly wire: WireMessage[] = [];
  private controller: AbortController | undefined;
  private lastUserText: string | undefined;
  usage: UsageView | undefined;

  constructor(
    private readonly client: OwuiClient,
    private readonly events: SessionEvents,
  ) {}

  get busy(): boolean {
    return this.controller !== undefined;
  }

  wireMessages(): readonly WireMessage[] {
    return this.wire;
  }

  stop(): void {
    this.controller?.abort();
  }

  canRetry(): boolean {
    return !this.busy && this.lastUserText !== undefined && this.wire[this.wire.length - 1]?.role === 'user';
  }

  async retry(ctx: RunContext): Promise<void> {
    if (!this.canRetry()) return;
    await this.complete(ctx);
  }

  async send(text: string, ctx: RunContext): Promise<void> {
    if (this.busy) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    this.lastUserText = trimmed;
    this.transcript.push({ id: randomUUID(), kind: 'user', text: trimmed, ts: Date.now() });
    this.wire.push({ role: 'user', content: trimmed });
    await this.complete(ctx);
  }

  private async complete(ctx: RunContext): Promise<void> {
    const messages: WireMessage[] = [{ role: 'system', content: ctx.systemPrompt }, ...this.wire];
    const size = measurePrompt(messages);
    const estimate = ctx.calibrator.estimate(ctx.model.id, size);
    const verdict = preflight(estimate, ctx.model.contextSize, outputReserve(ctx.model.contextSize));
    this.usage = { promptTokens: estimate, contextSize: ctx.model.contextSize, contextSource: ctx.model.contextSource, estimated: true };
    if (verdict.kind === 'over') {
      this.pushError(
        `This conversation (about ${estimate} tokens) does not fit in ${ctx.model.name}'s context window ` +
          `(${ctx.model.contextSize} tokens${ctx.model.contextSource === 'assumed' ? ', assumed because Open WebUI does not report it' : ''}). ` +
          'Start a new session, or raise the context length for this model in Open WebUI (Advanced Params → Context Length) ' +
          'or in the owuiAgent.models setting.',
        'openSettings',
      );
      this.events.changed();
      return;
    }
    if (verdict.kind === 'near') {
      ctx.warnOnce(
        `near:${this.id}`,
        `The conversation is using about ${Math.round(verdict.fraction * 100)}% of the usable context window. Consider starting a new session soon.`,
      );
    }

    const item: AssistantItem = { id: randomUUID(), kind: 'assistant', text: '', reasoning: '', ts: Date.now(), streaming: true };
    this.transcript.push(item);
    this.controller = new AbortController();
    this.events.changed();

    let turn: AssistantTurn | undefined;
    try {
      turn = await this.client.chat(
        { model: ctx.model.id, messages },
        {
          onDelta: (d) => {
            item.interrupted = undefined;
            if (d.kind === 'content') item.text += d.text;
            else item.reasoning += d.text;
            this.events.delta(item.id, d);
          },
          onRetry: (info) => this.onRetry(item, info),
        },
        this.controller.signal,
      );
    } catch (e) {
      item.streaming = false;
      if (isAbortError(e) || this.controller.signal.aborted) {
        item.stopped = true;
        if (item.text.trim()) this.wire.push({ role: 'assistant', content: stripThinkTags(item.text) });
      } else {
        if (!item.text && !item.reasoning) this.transcript.splice(this.transcript.indexOf(item), 1);
        else item.interrupted = 'The response was interrupted.';
        this.pushError(describe(e), actionFor(e));
      }
    } finally {
      this.controller = undefined;
    }

    if (turn) {
      item.streaming = false;
      item.interrupted = undefined;
      item.text = turn.content;
      item.reasoning = turn.reasoning;
      this.wire.push({ role: 'assistant', content: stripThinkTags(turn.content) });
      this.recordUsage(ctx, size, estimate, turn.usage);
    }
    this.events.changed();
  }

  private recordUsage(ctx: RunContext, size: ReturnType<typeof measurePrompt>, estimate: number, usage: Usage | null): void {
    this.events.usage(ctx.model, usage);
    if (!usage) {
      ctx.warnOnce(`usage:${ctx.model.id}`, USAGE_HELP);
      return;
    }
    this.usage = {
      promptTokens: usage.promptTokens + usage.completionTokens,
      contextSize: ctx.model.contextSize,
      contextSource: ctx.model.contextSource,
      estimated: false,
    };
    const verdict = checkTruncation(estimate, usage.promptTokens, ctx.model.contextSize);
    if (verdict.kind === 'suspect') {
      this.transcript.push({
        id: randomUUID(),
        kind: 'warning',
        ts: Date.now(),
        text:
          `The server probably truncated the prompt: ${verdict.reason}. The model may not have seen the start of the conversation. ` +
          'If this model runs on Ollama, raise its context length in Open WebUI (Admin Panel → Settings → Models → Advanced Params → Context Length).',
      });
      return;
    }
    ctx.calibrator.observe(ctx.model.id, size, usage.promptTokens, ctx.model.contextSize);
  }

  private onRetry(item: AssistantItem, info: RetryInfo): void {
    if (info.discardedPartial) {
      item.text = '';
      item.reasoning = '';
    }
    item.interrupted = `Retrying (${info.attempt}/${info.maxRetries}) in ${Math.round(info.delayMs / 1000)}s: ${info.reason}`;
    this.events.changed();
  }

  private pushError(text: string, action?: 'setApiKey' | 'openSettings' | 'retry'): void {
    const err: TranscriptItem = { id: randomUUID(), kind: 'error', text, ts: Date.now() };
    if (action) err.action = action;
    this.transcript.push(err);
  }
}

function describe(e: unknown): string {
  if (e instanceof HttpError && e.isAuth) {
    return `Open WebUI rejected the request (${e.message}). Check the API key, that API keys are enabled for your account, and that the instance's API key endpoint restrictions allow /api/models and /api/chat/completions.`;
  }
  return e instanceof Error ? e.message : String(e);
}

function actionFor(e: unknown): 'setApiKey' | 'openSettings' | 'retry' {
  if (e instanceof MissingApiKeyError || (e instanceof HttpError && e.isAuth)) return 'setApiKey';
  return 'retry';
}
