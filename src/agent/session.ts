import { randomUUID } from 'node:crypto';
import type { OwuiClient, RetryInfo } from '../owui/client';
import { HttpError, MissingApiKeyError, isAbortError } from '../owui/errors';
import type { ResolvedModel } from '../owui/models';
import { stripThinkTags } from '../owui/reasoning';
import type { StreamDelta } from '../owui/streamAssembler';
import { CHARS_PER_TOKEN, checkTruncation, measurePrompt, outputReserve, preflight, tokensFor } from '../owui/tokens';
import type { AssistantTurn, ContentPart, ToolDefinition, Usage, WireMessage } from '../owui/types';
import type { CheckpointManager, PlannedChange, RewindResult } from '../checkpoints/checkpoints';
import { describeSkills, type Skill } from '../skills/discovery';
import type { SessionRecord } from '../storage/history';
import { COMPACTION_PROMPT, compact } from './compaction';
import type { DiffStore } from '../diff/diffStore';
import type {
  AgentMode,
  ApprovalDecision,
  AskUserQuestion,
  ReviewFile,
  RewindScope,
  TodoItem,
  ToolCardUpdate,
  TranscriptItem,
  UsageView,
} from '../shared/protocol';
import type { BrowserSession } from '../browser/session';
import type { OwuiWeb } from '../owui/web';
import { allowedInMode, type ToolRegistry } from '../tools/registry';
import { truncateMiddle } from '../tools/shell/output';
import type { ProcessManager } from '../tools/shell/processManager';
import type { ShellRegistry } from '../tools/shell/shells';
import { isPrepared, type ImageAttachment, type Tool, type ToolContext, type ToolResult, type ToolSettings } from '../tools/types';
import { coerceArgs, parseArguments, validateArgs } from '../tools/validate';
import { realPath, type PathGuard } from '../workspace/paths';
import { decide } from './permissions';
import { modeNote } from './systemPrompt';
import { describeError, log } from '../log';

type AssistantItem = Extract<TranscriptItem, { kind: 'assistant' }>;
type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;
type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>;

export interface SessionEvents {
  changed(): void;
  delta(id: string, delta: StreamDelta): void;
  toolUpdate(id: string, patch: ToolCardUpdate): void;
  usage(model: ResolvedModel, usage: Usage | null): void;
}

export interface AgentEnv {
  client: OwuiClient;
  tools: ToolRegistry;
  shells: ShellRegistry;
  paths: PathGuard;
  processes: ProcessManager;
  scratchpad: string;
  ripgrep: string | undefined;
  checkpoints: CheckpointManager;
  diffs: DiffStore;
  web: OwuiWeb;
  browser: () => BrowserSession;
  closeBrowser: () => Promise<void>;
}

export interface RunContext {
  model: ResolvedModel;
  /** The agent's instructions, including the sections for enabled features such as web access. */
  systemPrompt(): string;
  mode(): AgentMode;
  allowlist(): string[];
  toolSettings: ToolSettings;
  maxIterations: number;
  warnOnce(key: string, text: string): void;
  addAllowlistEntry(entry: string): Promise<void>;
  loadContext(): Promise<{ sections: string[]; skills: Skill[] }>;
  onWorkspaceDirCreated(dir: string): void;
  toolEnabled(name: string): boolean;
  autoApproveSearches(): boolean;
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

/** The system message and tools for a session. Rebuilt only when the model or tool set changes, so every
 * request in between starts with byte-identical text and Ollama can reuse its prompt cache. */
interface FrozenPrompt {
  key: string;
  system: string;
  tools: Tool[];
  defs: ToolDefinition[];
}

const USAGE_HELP =
  'Open WebUI did not report token usage for this model, so prompt-truncation detection is unavailable. ' +
  'To enable it: Admin Panel → Settings → Models → edit the model → Capabilities → enable "Usage", then Save.';

const REPEAT_LIMIT = 3;
/** Compact when the conversation would fill this much of its budget. */
const COMPACT_AT = 0.8;
/** Bounds for the correction of the character-based estimate; outside them the server's count is not plausible. */
const MIN_CORRECTION = 0.5;
const MAX_CORRECTION = 3;
/** Smaller prompts give a noisy ratio, dominated by the chat template's own tokens. */
const MIN_SAMPLE_TOKENS = 500;

export class AgentSession {
  readonly transcript: TranscriptItem[] = [];
  todos: TodoItem[] = [];
  usage: UsageView | undefined;
  private readonly wire: WireMessage[] = [];
  private controller: AbortController | undefined;
  private readonly approvals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly questions = new Map<string, (answers: string[][] | undefined) => void>();
  private readonly turnStarts = new Map<string, { wire: number; transcript: number }>();
  private runCheckpoint: string | undefined;
  private contextSections: string[] = [];
  private skills: Skill[] = [];
  private contextLoaded = false;
  private frozen: FrozenPrompt | undefined;
  /** The server's token count for the last request divided by the character-based estimate for it. Every estimate
   * is scaled by it, so planning uses the model's real tokenizer instead of a fixed ratio. */
  private correction = 1;
  private announcedMode: AgentMode | undefined;
  /** What the user did that the model must hear about (a code-only rewind, files reverted during review). Sent at the
   * start of the next user message, so the model is never shown a reply it did not write. */
  private pendingNotes: string[] = [];
  created: number = Date.now();
  private lastCallKey = '';
  private repeatCount = 0;

  constructor(
    private readonly env: AgentEnv,
    private readonly events: SessionEvents,
    readonly id: string = randomUUID(),
  ) {}

  get scratchpad(): string {
    return this.env.scratchpad;
  }

  get busy(): boolean {
    return this.controller !== undefined;
  }

  wireMessages(): readonly WireMessage[] {
    return this.wire;
  }

  stop(): void {
    this.controller?.abort();
  }

  resolveApproval(itemId: string, decision: ApprovalDecision): void {
    this.approvals.get(itemId)?.(decision);
  }

  resolveQuestion(itemId: string, answers: string[][]): void {
    this.questions.get(itemId)?.(answers);
  }

  async rewindPreview(userItemId: string): Promise<PlannedChange[] | undefined> {
    const item = this.transcript.find((t) => t.id === userItemId);
    if (!item || item.kind !== 'user' || !item.checkpoint) return undefined;
    return this.env.checkpoints.plan(item.checkpoint);
  }

  async rewind(userItemId: string, scope: RewindScope): Promise<{ text: string; result?: RewindResult } | undefined> {
    if (this.busy) return undefined;
    const index = this.transcript.findIndex((t) => t.id === userItemId);
    const item = this.transcript[index];
    if (!item || item.kind !== 'user') return undefined;
    let result: RewindResult | undefined;
    if (scope !== 'conversation' && item.checkpoint) {
      result = await this.env.checkpoints.rewind(item.checkpoint);
      const display = (files: string[]) => files.map((f) => this.env.paths.classify(f).display).join(', ');
      if (result.skipped.length) this.pushWarning(`Not restored because they were not backed up (larger than 20 MB, or not regular files): ${display(result.skipped)}.`);
      if (result.failed.length) this.pushWarning(`Could not restore: ${display(result.failed)}. Check whether another program has them open.`);
    }
    if (scope !== 'code' && !this.turnStarts.has(userItemId)) {
      this.pushWarning(
        result
          ? 'The code was rewound, but the conversation before that message was compacted into a summary, so it could not be rewound. Start a new session if the model should forget it.'
          : 'The conversation before that message was compacted into a summary, so it cannot be rewound. Start a new session if the model should forget it.',
      );
      this.events.changed();
      return result ? { text: '', result } : undefined;
    }
    if (scope !== 'code') {
      const start = this.turnStarts.get(userItemId);
      if (start) {
        this.wire.splice(start.wire);
        this.transcript.splice(start.transcript);
        this.announcedMode = undefined;
        this.pendingNotes = [];
        for (const id of [...this.turnStarts.keys()]) if (!this.transcript.some((t) => t.id === id)) this.turnStarts.delete(id);
      }
    } else if (result) {
      this.pushWarning(
        `Restored the code to before "${truncateLabel(item.text)}": ${result.restored.length} file(s) restored, ${result.deleted.length} deleted. The conversation was kept; tell the agent what changed.`,
      );
      this.pendingNotes.push(`[The user rewound the workspace files to the state before the message "${truncateLabel(item.text)}". Changes made after that point are gone; re-read files before relying on them.]`);
    }
    this.events.changed();
    return { text: item.text, ...(result ? { result } : {}) };
  }

  async reviewDecision(itemId: string, absolute: string | undefined, decision: 'keep' | 'revert'): Promise<void> {
    const item = this.transcript.find((t) => t.id === itemId);
    if (!item || item.kind !== 'review' || this.busy) return;
    for (const f of item.files) {
      if (f.decision || (absolute && f.absolute !== absolute)) continue;
      if (decision === 'revert' && !(await this.env.checkpoints.revertFile(item.checkpoint, f.absolute).catch(() => false))) {
        this.pushWarning(`Could not revert ${f.display}.`);
        f.decision = 'kept';
        continue;
      }
      f.decision = decision === 'revert' ? 'reverted' : 'kept';
    }
    if (item.files.every((f) => f.decision)) {
      item.status = 'done';
      const reverted = item.files.filter((f) => f.decision === 'reverted').map((f) => f.display);
      if (reverted.length) this.pendingNotes.push(`[During review the user reverted these files to their earlier state: ${reverted.join(', ')}.]`);
    }
    this.events.changed();
  }

  canResume(): boolean {
    const last = this.wire[this.wire.length - 1];
    return !this.busy && !!last && last.role !== 'assistant';
  }

  async send(text: string, ctx: RunContext): Promise<void> {
    if (this.busy) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = randomUUID();
    this.turnStarts.set(id, { wire: this.wire.length, transcript: this.transcript.length });
    const user: Extract<TranscriptItem, { kind: 'user' }> = { id, kind: 'user', text: trimmed, ts: Date.now() };
    this.transcript.push(user);
    this.controller = new AbortController();
    this.events.changed();
    const cp = this.env.checkpoints.begin(trimmed);
    user.checkpoint = cp.id;
    this.runCheckpoint = cp.id;
    this.wire.push({ role: 'user', content: this.withNotes(trimmed, ctx.mode()) });
    this.lastCallKey = '';
    this.repeatCount = 0;
    await this.run(ctx);
  }

  async resume(ctx: RunContext): Promise<void> {
    if (!this.canResume()) return;
    if (ctx.mode() !== this.announcedMode || this.pendingNotes.length) this.wire.push({ role: 'user', content: this.withNotes('Continue.', ctx.mode()) });
    await this.run(ctx);
  }

  /** Puts the pending notes, and the permission mode when it changed, in front of a user message. They go in the
   * conversation rather than the system prompt, so a change appends text instead of invalidating the cached prefix. */
  private withNotes(text: string, mode: AgentMode): string {
    const notes = mode === this.announcedMode ? [] : [modeNote(mode)];
    this.announcedMode = mode;
    notes.push(...this.pendingNotes);
    this.pendingNotes = [];
    return notes.length ? `${notes.join('\n')}\n\n${text}` : text;
  }

  async dispose(): Promise<void> {
    this.stop();
    await Promise.all([this.env.processes.stopAll(), this.env.closeBrowser()]);
  }

  async compactNow(ctx: RunContext): Promise<void> {
    if (this.busy) return;
    if (this.wire.length < 3) {
      this.pushNotice('Nothing to compact yet.');
      this.events.changed();
      return;
    }
    this.controller = new AbortController();
    this.events.changed();
    try {
      await this.maybeCompact(ctx, this.controller.signal, true);
    } finally {
      this.controller = undefined;
      this.events.changed();
    }
  }

  toRecord(title: string, model: string | undefined, mode: AgentMode): SessionRecord {
    const record: SessionRecord = {
      version: 1,
      id: this.id,
      title,
      created: this.created,
      updated: Date.now(),
      mode,
      transcript: this.transcript,
      wire: this.wire,
      todos: this.todos,
      checkpoints: this.env.checkpoints.serialize(),
      scratchpad: this.env.scratchpad,
      turns: [...this.turnStarts],
    };
    if (model) record.model = model;
    if (this.pendingNotes.length) record.notes = [...this.pendingNotes];
    return record;
  }

  restore(record: SessionRecord): void {
    this.created = record.created;
    this.transcript.splice(0, this.transcript.length, ...record.transcript);
    this.wire.splice(0, this.wire.length, ...record.wire);
    this.todos = record.todos ?? [];
    this.pendingNotes = [...(record.notes ?? [])];
    this.announcedMode = undefined;
    this.env.checkpoints.restore(record.checkpoints ?? []);
    this.turnStarts.clear();
    for (const [id, start] of record.turns ?? []) this.turnStarts.set(id, start);
    for (const t of this.transcript) {
      if (t.kind === 'tool' && (t.status === 'awaiting-approval' || t.status === 'running' || t.status === 'pending')) {
        t.status = 'cancelled';
        t.approval = undefined;
      }
      if (t.kind === 'question' && t.status === 'open') t.status = 'cancelled';
      if (t.kind === 'assistant' && t.streaming) {
        t.streaming = false;
        t.stopped = true;
      }
    }
    const answered = new Set(this.wire.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
    for (let i = 0; i < this.wire.length; i++) {
      const m = this.wire[i]!;
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
      const missing = m.tool_calls.filter((c) => !answered.has(c.id));
      if (!missing.length) continue;
      let at = i + 1;
      while (at < this.wire.length && this.wire[at]!.role === 'tool') at++;
      this.wire.splice(at, 0, ...missing.map((c) => ({ role: 'tool' as const, tool_call_id: c.id, content: 'Not run: the session was closed before this tool finished.' })));
      for (const [id, start] of this.turnStarts) if (start.wire >= at) this.turnStarts.set(id, { ...start, wire: start.wire + missing.length });
    }
  }

  /** Project instructions, memory and skills are read once per session; a memory change made with update_memory is
   * already in the conversation as that tool's result. */
  private async loadContextOnce(ctx: RunContext): Promise<void> {
    if (this.contextLoaded) return;
    this.contextLoaded = true;
    try {
      const loaded = await ctx.loadContext();
      this.contextSections = loaded.sections;
      this.skills = loaded.skills;
    } catch (e) {
      log.warn(`Could not load AGENTS.md, project memory or skills: ${describeError(e)}`);
      this.contextSections = [];
      this.skills = [];
    }
  }

  private async prompt(ctx: RunContext): Promise<FrozenPrompt> {
    await this.loadContextOnce(ctx);
    const tools = this.env.tools.select({ vision: ctx.model.vision, hasSkills: this.skills.length > 0, enabled: (name) => ctx.toolEnabled(name) });
    const key = [ctx.model.id, ...tools.map((t) => t.name)].join('|');
    if (this.frozen?.key === key) return this.frozen;
    const defs = this.env.tools.definitions(tools, { shells: this.env.shells.available().map((s) => s.id) });
    const parts = [ctx.systemPrompt(), ...this.contextSections];
    const skills = describeSkills(this.skills);
    if (skills) parts.push(skills);
    this.frozen = { key, system: parts.join('\n\n'), tools, defs };
    return this.frozen;
  }

  private async maybeCompact(ctx: RunContext, signal: AbortSignal, force = false): Promise<void> {
    const { system, defs } = await this.prompt(ctx);
    // The budget is what the conversation may use: the context minus room for the answer, instructions and tools.
    const estimate = (msgs: WireMessage[]) => this.estimate(msgs);
    const budget = Math.max(1, ctx.model.contextSize - outputReserve(ctx.model.contextSize) - this.estimate([{ role: 'system', content: system }], defs));
    if (!force && estimate(this.wire) < budget * COMPACT_AT) return;
    const summarize = async (transcript: string, previous: string | undefined): Promise<string> => {
      const content = previous ? `Previous summary:\n${previous}\n\nNext part of the transcript:\n${transcript}` : transcript;
      const turn = await this.env.client.chat(
        {
          model: ctx.model.id,
          messages: [
            { role: 'system', content: COMPACTION_PROMPT },
            { role: 'user', content },
          ],
          ...(ctx.model.thinking !== undefined ? { think: ctx.model.thinking } : {}),
          numCtx: ctx.model.contextSize,
          maxTokens: outputReserve(ctx.model.contextSize),
        },
        {},
        signal,
      );
      const text = stripThinkTags(turn.content).trim();
      if (!text) throw new Error('the model returned an empty summary');
      return text;
    };
    const notice: Extract<TranscriptItem, { kind: 'notice' }> = { id: randomUUID(), kind: 'notice', ts: Date.now(), text: 'Compacting the conversation to fit the context window…' };
    this.transcript.push(notice);
    this.events.changed();
    const startLength = this.wire.length;
    let result;
    try {
      result = await compact(
        this.wire,
        { estimate, summarize },
        { budget, threshold: 0, target: force ? 0.3 : 0.5, keepRecent: 6, maxChunkChars: Math.max(4000, Math.floor((budget * CHARS_PER_TOKEN * 0.5) / this.correction)), force },
      );
    } catch (e) {
      notice.text = signal.aborted ? 'Compaction cancelled.' : `Compaction failed: ${(e as Error).message}. The conversation was left unchanged.`;
      if (!signal.aborted) log.warn(`Compaction failed: ${describeError(e)}`);
      this.events.changed();
      return;
    }
    if (result.stage === 'none') {
      notice.text = 'Compaction found nothing to shrink.';
      this.events.changed();
      return;
    }
    const appended = this.wire.slice(startLength);
    if (result.stage === 'summarized') {
      this.announcedMode = undefined;
      const headLength = result.wire.length - (startLength - result.summarizedMessages);
      for (const [id, start] of [...this.turnStarts]) {
        if (start.wire < result.summarizedMessages) this.turnStarts.delete(id);
        else this.turnStarts.set(id, { ...start, wire: start.wire - result.summarizedMessages + headLength });
      }
    }
    this.wire.splice(0, this.wire.length, ...result.wire, ...appended);
    notice.text =
      result.stage === 'summarized'
        ? `Compacted the conversation: summarized ${result.summarizedMessages} earlier messages (about ${result.before} → ${result.after} tokens). They stay visible here, but the model now sees a summary.`
        : `Shortened old tool output to save context (about ${result.before} → ${result.after} tokens).`;
    this.events.changed();
  }


  private async run(ctx: RunContext): Promise<void> {
    this.controller ??= new AbortController();
    const signal = this.controller.signal;
    this.events.changed();
    try {
      for (let iteration = 0; ; iteration++) {
        if (signal.aborted) break;
        if (iteration >= ctx.maxIterations) {
          this.pushError(`Paused after ${ctx.maxIterations} steps. Continue if the agent is making progress, or give it new instructions.`, 'continue');
          break;
        }
        const turn = await this.modelTurn(ctx, signal);
        if (!turn || !turn.calls.length) break;
        const proceed = await this.executeCalls(turn.calls, ctx, signal);
        if (!proceed) break;
      }
    } finally {
      for (const resolve of this.approvals.values()) resolve({ decision: 'deny' });
      for (const resolve of this.questions.values()) resolve(undefined);
      this.controller = undefined;
      if (ctx.mode() === 'review') this.pushReview();
      this.events.changed();
    }
  }

  private pushReview(): void {
    const cpId = this.runCheckpoint;
    if (!cpId) return;
    const reviewed = new Set(this.transcript.flatMap((t) => (t.kind === 'review' && t.checkpoint === cpId ? t.files.map((f) => f.absolute) : [])));
    const changes = this.env.checkpoints.agentChangesSince(cpId).filter((c) => c.action !== 'skip' && !reviewed.has(c.absolute));
    if (!changes.length) return;
    const files: ReviewFile[] = changes.map((c) => {
      const resolved = this.env.paths.classify(c.absolute);
      const diffId = this.lastDiffFor(c.absolute);
      return { absolute: c.absolute, display: resolved.display, action: c.action === 'delete' ? 'added' : 'modified', ...(diffId ? { diffId } : {}) };
    });
    this.transcript.push({ id: randomUUID(), kind: 'review', ts: Date.now(), checkpoint: cpId, files, status: 'open' });
  }

  private lastDiffFor(absolute: string): string | undefined {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const t = this.transcript[i]!;
      if (t.kind !== 'tool' || !t.diffId || t.status !== 'done') continue;
      const diff = this.env.diffs.get(t.diffId);
      if (diff && realPath(diff.absolute) === absolute) return t.diffId;
    }
    return undefined;
  }

  private async modelTurn(ctx: RunContext, signal: AbortSignal): Promise<{ calls: PendingCall[] } | undefined> {
    await this.maybeCompact(ctx, signal);
    if (signal.aborted) return undefined;
    const { system, defs } = await this.prompt(ctx);
    // Open WebUI 0.12 fails with HTTP 400 "'NoneType' object is not iterable" on an assistant message with neither
    // content nor tool calls. Earlier versions could save one, so skip them here to repair old sessions too.
    const messages: WireMessage[] = [{ role: 'system', content: system }, ...this.wire.filter((m) => !isEmptyAssistant(m))];
    const raw = tokensFor(measurePrompt(messages, defs));
    const estimate = Math.ceil(raw * this.correction);
    const verdict = preflight(estimate, ctx.model.contextSize, outputReserve(ctx.model.contextSize));
    this.usage = { promptTokens: estimate, contextSize: ctx.model.contextSize, contextSource: ctx.model.contextSource, estimated: true };
    if (verdict.kind === 'over') {
      this.pushError(
        `The next request (about ${estimate} tokens including the agent's instructions and tool definitions) does not fit in ${ctx.model.name}'s context window ` +
          `(${ctx.model.contextSize} tokens, sent to Ollama as num_ctx). Raise the context size with the button below if the server has the memory for it, or start a new session.`,
        'setContextSize',
      );
      return undefined;
    }
    if (verdict.kind === 'near') {
      ctx.warnOnce(`near:${this.id}`, `The conversation is using about ${Math.round(verdict.fraction * 100)}% of the usable context window. Consider starting a new session soon.`);
    }

    const item: AssistantItem = { id: randomUUID(), kind: 'assistant', text: '', reasoning: '', ts: Date.now(), streaming: true };
    this.transcript.push(item);
    this.events.changed();

    let turn: AssistantTurn;
    const started = Date.now();
    try {
      turn = await this.env.client.chat(
        {
          model: ctx.model.id,
          messages,
          tools: defs,
          ...(ctx.model.thinking !== undefined ? { think: ctx.model.thinking } : {}),
          // Always sent, and always the same value, so Ollama never silently uses a smaller default or reloads the model.
          numCtx: ctx.model.contextSize,
          // The preflight check keeps this much room free, so a model that loops cannot overflow the context or run forever.
          maxTokens: outputReserve(ctx.model.contextSize),
        },
        {
          onDelta: (d) => {
            item.interrupted = undefined;
            if (d.kind === 'reasoning') {
              item.reasoning += d.text;
              this.events.delta(item.id, d);
              return;
            }
            if (!d.text) return;
            item.text += d.text;
            this.events.delta(item.id, d);
          },
          onRetry: (info) => this.onRetry(item, info),
        },
        signal,
      );
    } catch (e) {
      item.streaming = false;
      if (isAbortError(e) || signal.aborted) {
        item.stopped = true;
        if (item.text.trim()) this.wire.push({ role: 'assistant', content: stripThinkTags(item.text) });
        return undefined;
      }
      if (e instanceof HttpError && e.toolsUnsupported) {
        this.removeItem(item);
        this.pushError(
          `${ctx.model.name} does not support tool calling through Open WebUI, so it cannot run the agent. Pick a model with tool support; docs/SETUP.md lists some that work well.`,
        );
        return undefined;
      }
      if (!item.text && !item.reasoning) this.removeItem(item);
      else item.interrupted = 'The response was interrupted.';
      log.error(`Request to ${ctx.model.id} failed: ${describeError(e)}`);
      this.pushError(describe(e), actionFor(e));
      return undefined;
    }

    item.streaming = false;
    item.interrupted = undefined;
    item.reasoning = turn.reasoning;
    let content = stripThinkTags(turn.content);
    item.text = turn.content;
    const calls: PendingCall[] = turn.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
    // Some models (qwen3.5 through Ollama) occasionally put the whole final answer in the reasoning channel.
    // Show it as the answer rather than an empty reply the user never sees.
    if (!calls.length && !content.trim() && turn.reasoning.trim()) {
      content = turn.reasoning.trim();
      item.text = content;
      item.reasoning = '';
    }
    if (calls.length) {
      this.wire.push({
        role: 'assistant',
        content: content || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
    } else if (content.trim()) {
      this.wire.push({ role: 'assistant', content });
    } else if (!calls.length) {
      this.pushWarning('The model returned an empty reply. Try asking again.');
    }
    item.text = item.text.trim() ? item.text : '';
    if (!item.text && !item.reasoning) this.removeItem(item);
    log.info(
      `${ctx.model.id}: ${((Date.now() - started) / 1000).toFixed(1)}s, ${turn.usage ? `${turn.usage.promptTokens} prompt + ${turn.usage.completionTokens} output tokens` : `~${estimate} prompt tokens (estimated)`}, ${calls.length} tool call(s), finish ${turn.finishReason ?? 'unknown'}.`,
    );
    this.recordUsage(ctx, raw, estimate, turn.usage);
    if (!calls.length && turn.finishReason === 'length') {
      this.pushWarning('The model stopped because it reached its output limit. Ask it to continue, or raise the limit in Open WebUI.');
    }
    this.events.changed();
    return { calls };
  }

  private async executeCalls(calls: PendingCall[], ctx: RunContext, signal: AbortSignal): Promise<boolean> {
    // Tools keep their own output within the budget; this catches the rest, with room for their status lines and notes.
    const limit = ctx.toolSettings.maxOutputChars + 1000;
    const images: ImageAttachment[] = [];
    // Every call gets exactly one result, in order, on the wire as soon as it is known, so a failure later in the
    // batch can never leave an assistant tool call without its answer.
    const record = (call: PendingCall, result: ToolResult) => {
      this.wire.push({ role: 'tool', tool_call_id: call.id, content: truncateMiddle(result.content, limit).text });
      if (result.images) images.push(...result.images);
    };
    let proceed = true;
    for (const call of calls) {
      if (signal.aborted || !proceed) {
        record(call, { content: signal.aborted ? 'Cancelled by the user.' : 'Not run because the user denied the previous action.', isError: true });
        continue;
      }
      const { result, stop } = await this.executeOne(call, ctx, signal);
      record(call, result);
      if (stop) proceed = false;
    }
    // Tool messages carry text only, so images from view_image follow as a user message.
    const imageParts: ContentPart[] = images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } }));
    if (imageParts.length) {
      this.wire.push({ role: 'user', content: [{ type: 'text', text: `Images requested with view_image: ${images.map((i) => i.path).join(', ')}` }, ...imageParts] });
    }
    this.events.changed();
    return proceed && !signal.aborted;
  }

  private async executeOne(call: PendingCall, ctx: RunContext, signal: AbortSignal): Promise<{ result: ToolResult; stop?: boolean }> {
    const tool = this.env.tools.get(call.name);
    const card: ToolItem = { id: randomUUID(), kind: 'tool', ts: Date.now(), tool: call.name, title: call.name, status: 'pending' };
    this.transcript.push(card);
    const finish = (status: ToolItem['status'], result: ToolResult, extra: { stop?: boolean } = {}) => {
      card.status = status;
      if (status === 'error' && !card.output) card.output = result.content.slice(0, 4000);
      // Only the first line: later lines of an error can quote file contents or command output.
      if (status === 'error') log.warn(`Tool ${call.name} failed: ${result.content.split('\n', 1)[0]!.slice(0, 200)}`);
      this.events.changed();
      return { result, ...extra };
    };
    try {
      return await this.runTool(call, tool, card, finish, ctx, signal);
    } catch (e) {
      // Anything outside the tool's own try blocks (saving an allowlist entry, applying the user's edit) still ends
      // the card and produces a result instead of escaping and leaving the call unanswered.
      if (signal.aborted) return finish('cancelled', { content: 'Cancelled by the user.', isError: true });
      return finish('error', { content: `${call.name} failed: ${(e as Error).message}`, isError: true });
    }
  }

  private async runTool(
    call: PendingCall,
    tool: Tool | undefined,
    card: ToolItem,
    finish: (status: ToolItem['status'], result: ToolResult, extra?: { stop?: boolean }) => { result: ToolResult; stop?: boolean },
    ctx: RunContext,
    signal: AbortSignal,
  ): Promise<{ result: ToolResult; stop?: boolean }> {
    if (tool && !ctx.toolEnabled(tool.name)) {
      return finish('error', { content: `${tool.name} is turned off in the OWUI Agent settings.`, isError: true });
    }
    const offered = this.frozen?.tools ?? [];
    if (!tool || !offered.includes(tool)) {
      const names = offered.map((t) => t.name).join(', ');
      return finish('error', { content: `Unknown tool "${call.name}". Available tools: ${names}.`, isError: true });
    }
    const parsed = parseArguments(call.arguments);
    if (parsed.error || !parsed.value) return finish('error', { content: parsed.error ?? 'Invalid arguments.', isError: true });
    const args = coerceArgs(tool.parameters, parsed.value);
    const errors = validateArgs(tool.parameters, args);
    card.title = safeTitle(tool, args);
    if (!allowedInMode(tool, ctx.mode())) {
      return finish('error', {
        content: `${tool.name} is not available in plan mode, which is read-only. Finish investigating, then reply with your plan; the user switches mode to implement it.`,
        isError: true,
      });
    }
    if (errors.length) return finish('error', { content: `Invalid arguments for ${tool.name}: ${errors.join('; ')}.`, isError: true });

    const key = `${tool.name}:${JSON.stringify(args)}`;
    this.repeatCount = key === this.lastCallKey ? this.repeatCount + 1 : 1;
    this.lastCallKey = key;
    if (this.repeatCount >= REPEAT_LIMIT && tool.category !== 'interactive') {
      return finish('error', {
        content: `You have called ${tool.name} with identical arguments ${this.repeatCount} times in a row. It will not run again; change your approach or explain what is blocking you.`,
        isError: true,
      });
    }

    const toolCtx = this.toolContext(card, ctx, signal);
    let prepared;
    try {
      prepared = await tool.prepare(args, toolCtx);
    } catch (e) {
      return finish('error', { content: `${tool.name} failed: ${(e as Error).message}`, isError: true });
    }
    if (!isPrepared(prepared)) return finish(prepared.isError ? 'error' : 'done', prepared);
    Object.assign(card, prepared.card ?? {});
    if (prepared.preview) {
      this.env.diffs.put({ id: card.id, ...prepared.preview });
      card.diffId = card.id;
    }
    const decision = decide({ mode: ctx.mode(), access: prepared.access, allowlist: ctx.allowlist(), autoApproveSearches: ctx.autoApproveSearches() });
    if (decision.kind === 'ask') {
      card.status = 'awaiting-approval';
      card.approval = decision.request;
      this.events.changed();
      const answer = await waitFor<ApprovalDecision>(signal, { decision: 'deny' }, (resolve) => this.approvals.set(card.id, resolve));
      this.approvals.delete(card.id);
      card.approval = undefined;
      if (signal.aborted) return finish('cancelled', { content: 'Cancelled by the user.', isError: true });
      if (answer.decision === 'deny') {
        const feedback = answer.feedback?.trim();
        return finish(
          'denied',
          { content: feedback ? `The user denied this action and said: ${feedback}` : 'The user denied this action. Wait for further instructions.', isError: true },
          { stop: !feedback },
        );
      }
      if (answer.decision === 'allowAlways' && decision.request.allowAlways) await ctx.addAllowlistEntry(decision.request.allowAlways);
      if (answer.edited !== undefined && prepared.applyEdit && answer.edited !== decision.request.editable?.value) {
        const editError = prepared.applyEdit(answer.edited);
        if (editError) return finish('error', { content: `The user's edit was rejected: ${editError}`, isError: true });
      }
    }
    card.status = 'running';
    this.events.changed();
    try {
      const result = await prepared.execute();
      if (signal.aborted) return finish('cancelled', { ...result, isError: true });
      return finish(result.isError ? 'error' : 'done', result);
    } catch (e) {
      if (signal.aborted) return finish('cancelled', { content: 'Cancelled by the user.', isError: true });
      return finish('error', { content: `${tool.name} failed: ${(e as Error).message}`, isError: true });
    }
  }

  private toolContext(card: ToolItem, ctx: RunContext, signal: AbortSignal): ToolContext {
    return {
      signal,
      callId: card.id.slice(0, 8),
      paths: this.env.paths,
      shells: this.env.shells,
      processes: this.env.processes,
      scratchpad: this.env.scratchpad,
      ripgrep: this.env.ripgrep,
      settings: ctx.toolSettings,
      modelVision: ctx.model.vision,
      update: (patch) => {
        Object.assign(card, patch);
        this.events.toolUpdate(card.id, patch);
      },
      ask: (questions) => this.ask(questions, signal),
      beforeWrite: (absolute) => this.env.checkpoints.recordBeforeWrite(absolute),
      afterWrite: (absolute) => this.env.checkpoints.recordAfterWrite(absolute),
      skills: this.skills,
      workspaceDirCreated: (dir) => ctx.onWorkspaceDirCreated(dir),
      browser: this.env.browser,
      web: this.env.web,
      setTodos: (todos) => {
        this.todos = todos;
        this.events.changed();
      },
    };
  }

  private async ask(questions: AskUserQuestion[], signal: AbortSignal): Promise<string[][]> {
    const item: QuestionItem = { id: randomUUID(), kind: 'question', ts: Date.now(), questions, status: 'open' };
    this.transcript.push(item);
    this.events.changed();
    const answers = await waitFor<string[][] | undefined>(signal, undefined, (resolve) => this.questions.set(item.id, resolve));
    this.questions.delete(item.id);
    if (!answers) {
      item.status = 'cancelled';
      this.events.changed();
      throw new Error('The user did not answer.');
    }
    item.answers = answers;
    item.status = 'answered';
    this.events.changed();
    return answers;
  }

  private estimate(messages: WireMessage[], defs?: ToolDefinition[]): number {
    return Math.ceil(tokensFor(measurePrompt(messages, defs)) * this.correction);
  }

  private recordUsage(ctx: RunContext, raw: number, estimate: number, usage: Usage | null): void {
    this.events.usage(ctx.model, usage);
    if (!usage) {
      ctx.warnOnce(`usage:${ctx.model.id}`, USAGE_HELP);
      return;
    }
    this.usage = { promptTokens: usage.promptTokens + usage.completionTokens, contextSize: ctx.model.contextSize, contextSource: ctx.model.contextSource, estimated: false };
    const verdict = checkTruncation(estimate, usage.promptTokens, ctx.model.contextSize);
    if (verdict.kind === 'suspect') {
      this.pushWarning(
        `The server probably truncated the prompt: ${verdict.reason}. The model may not have seen the start of the conversation or its instructions. ` +
          'If this model runs on Ollama, raise its context length in Open WebUI (Admin Panel → Settings → Models → Advanced Params → Context Length).',
      );
      return;
    }
    if (raw >= MIN_SAMPLE_TOKENS) this.correction = Math.min(MAX_CORRECTION, Math.max(MIN_CORRECTION, usage.promptTokens / raw));
  }

  private onRetry(item: AssistantItem, info: RetryInfo): void {
    log.warn(`Retrying request (${info.attempt}/${info.maxRetries}) in ${Math.round(info.delayMs / 1000)}s: ${info.reason}`);
    if (info.discardedPartial) {
      item.text = '';
      item.reasoning = '';
    }
    item.interrupted = `Retrying (${info.attempt}/${info.maxRetries}) in ${Math.round(info.delayMs / 1000)}s: ${info.reason}`;
    this.events.changed();
  }

  private removeItem(item: TranscriptItem): void {
    const i = this.transcript.indexOf(item);
    if (i !== -1) this.transcript.splice(i, 1);
  }

  private pushNotice(text: string): void {
    this.transcript.push({ id: randomUUID(), kind: 'notice', text, ts: Date.now() });
  }

  private pushWarning(text: string): void {
    this.transcript.push({ id: randomUUID(), kind: 'warning', text, ts: Date.now() });
  }

  private pushError(text: string, action?: 'setApiKey' | 'openSettings' | 'retry' | 'continue' | 'setContextSize'): void {
    const err: TranscriptItem = { id: randomUUID(), kind: 'error', text, ts: Date.now() };
    if (action) err.action = action;
    this.transcript.push(err);
  }
}

function isEmptyAssistant(m: WireMessage): boolean {
  if (m.role !== 'assistant' || m.tool_calls?.length) return false;
  return typeof m.content === 'string' ? !m.content.trim() : !m.content?.length;
}

function waitFor<T>(signal: AbortSignal, onAbort: T, register: (resolve: (value: T) => void) => void): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort);
  return new Promise<T>((resolve) => {
    const abort = () => resolve(onAbort);
    signal.addEventListener('abort', abort, { once: true });
    register((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}

function truncateLabel(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

function safeTitle(tool: Tool, args: Record<string, unknown>): string {
  try {
    return tool.title(args);
  } catch {
    return tool.name;
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

