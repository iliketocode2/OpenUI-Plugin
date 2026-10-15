import { randomUUID } from 'node:crypto';
import type { OwuiClient, RetryInfo } from '../owui/client';
import { HttpError, MissingApiKeyError, isAbortError } from '../owui/errors';
import type { ResolvedModel } from '../owui/models';
import { stripThinkTags } from '../owui/reasoning';
import type { StreamDelta } from '../owui/streamAssembler';
import { RESULT_TAG, TextToolParser, describeToolsForText, extractCallsIgnoringFences, formatToolResults } from '../owui/textToolProtocol';
import { checkTruncation, measurePrompt, outputReserve, preflight, type TokenCalibrator } from '../owui/tokens';
import type { AssistantTurn, ContentPart, Usage, WireMessage } from '../owui/types';
import type { CheckpointManager, PlannedChange, RewindResult } from '../checkpoints/checkpoints';
import { describeSkills, type Skill } from '../skills/discovery';
import type { SessionRecord } from '../storage/history';
import { COMPACTION_PROMPT, compact } from './compaction';
import type { DiffStore } from '../diff/diffStore';
import type {
  AgentMode,
  ApprovalDecision,
  AskUserQuestion,
  PlanAnswer,
  ReviewFile,
  RewindScope,
  TodoItem,
  ToolCardUpdate,
  TranscriptItem,
  UsageView,
} from '../shared/protocol';
import type { BrowserSession } from '../browser/session';
import type { OwuiWeb } from '../owui/web';
import { toolsForMode, type ToolRegistry } from '../tools/registry';
import { truncateMiddle } from '../tools/shell/output';
import type { ProcessManager } from '../tools/shell/processManager';
import type { ShellRegistry } from '../tools/shell/shells';
import { isPrepared, type ImageAttachment, type Tool, type ToolContext, type ToolResult, type ToolSettings } from '../tools/types';
import { coerceArgs, parseArguments, validateArgs } from '../tools/validate';
import type { PathGuard } from '../workspace/paths';
import { decide } from './permissions';

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
  toolMode: 'native' | 'text';
  systemPrompt(mode: AgentMode): string;
  calibrator: TokenCalibrator;
  mode(): AgentMode;
  allowlist(): string[];
  toolSettings: ToolSettings;
  maxIterations: number;
  warnOnce(key: string, text: string): void;
  onToolsUnsupported(): void;
  addAllowlistEntry(entry: string): Promise<void>;
  setMode(mode: AgentMode): Promise<void>;
  loadContext(): Promise<{ sections: string[]; skills: Skill[] }>;
  onWorkspaceDirCreated(dir: string): void;
  toolEnabled(name: string): boolean;
  extraPromptSections(): string[];
  autoApproveSearches(): boolean;
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
  parseError?: string;
}

interface CallOutcome {
  call: PendingCall;
  result: ToolResult;
}

const USAGE_HELP =
  'Open WebUI did not report token usage for this model, so prompt-truncation detection is unavailable. ' +
  'To enable it: Admin Panel → Settings → Models → edit the model → Capabilities → enable "Usage", then Save.';

const REPEAT_LIMIT = 3;

export class AgentSession {
  readonly transcript: TranscriptItem[] = [];
  todos: TodoItem[] = [];
  usage: UsageView | undefined;
  private readonly wire: WireMessage[] = [];
  private controller: AbortController | undefined;
  private readonly approvals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly questions = new Map<string, (answers: string[][] | undefined) => void>();
  private readonly plans = new Map<string, (answer: PlanAnswer | undefined) => void>();
  private readonly turnStarts = new Map<string, { wire: number; transcript: number }>();
  private runCheckpoint: string | undefined;
  private contextSections: string[] = [];
  private skills: Skill[] = [];
  approvedPlan: string | undefined;
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

  resolvePlan(itemId: string, answer: PlanAnswer): void {
    this.plans.get(itemId)?.(answer);
  }

  async rewindPreview(userItemId: string): Promise<{ changes: PlannedChange[]; method: 'git' | 'backups' } | undefined> {
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
    if (scope !== 'conversation' && item.checkpoint) result = await this.env.checkpoints.rewind(item.checkpoint);
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
        for (const id of [...this.turnStarts.keys()]) if (!this.transcript.some((t) => t.id === id)) this.turnStarts.delete(id);
      }
    } else if (result) {
      this.pushWarning(
        `Restored the code to before "${truncateLabel(item.text)}": ${result.restored.length} file(s) restored, ${result.deleted.length} deleted. The conversation was kept; tell the agent what changed.`,
      );
      this.wire.push({ role: 'user', content: `[The user rewound the workspace files to the state before the message "${truncateLabel(item.text)}". Changes made after that point are gone.]` });
      this.wire.push({ role: 'assistant', content: 'Understood. I will re-read files before relying on them.' });
    }
    this.events.changed();
    return { text: item.text, ...(result ? { result } : {}) };
  }

  async reviewDecision(itemId: string, absolute: string | undefined, decision: 'keep' | 'revert'): Promise<void> {
    const item = this.transcript.find((t) => t.id === itemId);
    if (!item || item.kind !== 'review' || this.busy) return;
    for (const f of item.files) {
      if (f.decision || (absolute && f.absolute !== absolute)) continue;
      if (decision === 'revert') await this.env.checkpoints.revertFile(item.checkpoint, f.absolute);
      f.decision = decision === 'revert' ? 'reverted' : 'kept';
    }
    if (item.files.every((f) => f.decision)) {
      item.status = 'done';
      const reverted = item.files.filter((f) => f.decision === 'reverted').map((f) => f.display);
      if (reverted.length) this.wire.push({ role: 'user', content: `[During review the user reverted these files to their earlier state: ${reverted.join(', ')}.]` }, { role: 'assistant', content: 'Noted.' });
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
    const cp = await this.env.checkpoints.begin(trimmed);
    user.checkpoint = cp.id;
    this.runCheckpoint = cp.id;
    if (cp.snapshotError) ctx.warnOnce(`checkpoint:${this.id}`, `Workspace snapshots are unavailable (${cp.snapshotError}). Rewind will only undo files the agent edited, not changes made by commands.`);
    this.wire.push({ role: 'user', content: trimmed });
    await this.refreshContext(ctx);
    if (this.controller.signal.aborted) {
      this.controller = undefined;
      this.events.changed();
      return;
    }
    this.lastCallKey = '';
    this.repeatCount = 0;
    await this.run(ctx);
  }

  async resume(ctx: RunContext): Promise<void> {
    if (!this.canResume()) return;
    if (!this.contextSections.length) await this.refreshContext(ctx);
    await this.run(ctx);
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
      if (!this.contextSections.length) await this.refreshContext(ctx);
      await this.maybeCompact(ctx, ctx.mode(), ctx.toolMode, this.controller.signal, true);
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
    if (this.approvedPlan) record.approvedPlan = this.approvedPlan;
    return record;
  }

  restore(record: SessionRecord): void {
    this.created = record.created;
    this.transcript.splice(0, this.transcript.length, ...record.transcript);
    this.wire.splice(0, this.wire.length, ...record.wire);
    this.todos = record.todos ?? [];
    this.approvedPlan = record.approvedPlan;
    this.env.checkpoints.restore(record.checkpoints ?? []);
    this.turnStarts.clear();
    for (const [id, start] of record.turns ?? []) this.turnStarts.set(id, start);
    for (const t of this.transcript) {
      if (t.kind === 'tool' && (t.status === 'awaiting-approval' || t.status === 'running' || t.status === 'pending')) {
        t.status = 'cancelled';
        t.approval = undefined;
      }
      if ((t.kind === 'question' || t.kind === 'plan') && t.status === 'open') t.status = 'cancelled';
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

  private availableTools(ctx: RunContext, mode: AgentMode) {
    return toolsForMode(this.env.tools.list(), mode).filter((t) => ctx.toolEnabled(t.name));
  }

  private async refreshContext(ctx: RunContext): Promise<void> {
    try {
      const loaded = await ctx.loadContext();
      this.contextSections = loaded.sections;
      this.skills = loaded.skills;
    } catch {
      this.contextSections = [];
      this.skills = [];
    }
  }

  private systemMessage(ctx: RunContext, mode: AgentMode, toolMode: 'native' | 'text', defs: ReturnType<ToolRegistry['definitions']>): string {
    const parts = [ctx.systemPrompt(mode), ...this.contextSections, ...ctx.extraPromptSections()];
    const skills = describeSkills(this.skills);
    if (skills) parts.push(skills);
    if (this.approvedPlan) parts.push(`# Approved plan\nThe user approved this plan. Follow it, and tell the user about any deviation.\n\n${this.approvedPlan}`);
    if (this.todos.length) {
      const mark = (s: TodoItem['status']) => (s === 'completed' ? 'x' : s === 'in_progress' ? '~' : ' ');
      parts.push(`# Current task list\n${this.todos.map((t) => `- [${mark(t.status)}] ${t.content}`).join('\n')}`);
    }
    if (toolMode === 'text') parts.push(describeToolsForText(defs));
    return parts.join('\n\n');
  }

  private async maybeCompact(ctx: RunContext, mode: AgentMode, toolMode: 'native' | 'text', signal: AbortSignal, force = false): Promise<void> {
    const defs = this.env.tools.definitions(this.availableTools(ctx, mode));
    const fixed = measurePrompt([{ role: 'system', content: this.systemMessage(ctx, mode, toolMode, defs) }], toolMode === 'native' ? defs : undefined);
    const fixedTokens = ctx.calibrator.estimate(ctx.model.id, fixed);
    const budget = Math.max(1, ctx.model.contextSize - outputReserve(ctx.model.contextSize) - fixedTokens);
    const estimate = (msgs: WireMessage[]) => ctx.calibrator.estimate(ctx.model.id, measurePrompt(msgs));
    if (!force && estimate(this.wire) < budget * 0.8) return;
    const cpt = ctx.calibrator.charsPerToken(ctx.model.id);
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
          ...(ctx.model.contextSource === 'setting' ? { numCtx: ctx.model.contextSize } : {}),
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
        { budget, threshold: 0.8, target: force ? 0.3 : 0.5, keepRecent: 6, maxChunkChars: Math.max(4000, Math.floor(budget * cpt * 0.5)), force },
      );
    } catch (e) {
      notice.text = signal.aborted ? 'Compaction cancelled.' : `Compaction failed: ${(e as Error).message}. The conversation was left unchanged.`;
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
    let toolMode = ctx.toolMode;
    this.events.changed();
    try {
      for (let iteration = 0; ; iteration++) {
        if (signal.aborted) break;
        if (iteration >= ctx.maxIterations) {
          this.pushError(`Paused after ${ctx.maxIterations} steps. Continue if the agent is making progress, or give it new instructions.`, 'continue');
          break;
        }
        const turn = await this.modelTurn(ctx, toolMode, signal);
        if (turn === 'switch-to-text') {
          toolMode = 'text';
          ctx.onToolsUnsupported();
          ctx.warnOnce(`textmode:${ctx.model.id}`, `${ctx.model.name} does not support native tool calling through Open WebUI, so the agent switched to the text-based tool protocol for this model.`);
          iteration--;
          continue;
        }
        if (!turn || !turn.calls.length) break;
        const proceed = await this.executeCalls(turn.calls, toolMode, ctx, signal);
        if (!proceed) break;
      }
    } finally {
      for (const resolve of this.approvals.values()) resolve({ decision: 'deny' });
      for (const resolve of this.questions.values()) resolve(undefined);
      for (const resolve of this.plans.values()) resolve(undefined);
      this.controller = undefined;
      if (ctx.mode() === 'review') this.pushReview();
      this.events.changed();
    }
  }

  private pushReview(): void {
    const cpId = this.runCheckpoint;
    if (!cpId) return;
    const reviewed = new Set(this.transcript.flatMap((t) => (t.kind === 'review' && t.checkpoint === cpId ? t.files.map((f) => f.absolute) : [])));
    const changes = this.env.checkpoints.agentChangesSince(cpId).filter((c) => !reviewed.has(c.absolute));
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
      if (t.kind === 'tool' && t.diffId && t.status === 'done' && this.env.diffs.get(t.diffId)?.absolute === absolute) return t.diffId;
    }
    return undefined;
  }

  private async modelTurn(ctx: RunContext, toolMode: 'native' | 'text', signal: AbortSignal): Promise<{ calls: PendingCall[] } | 'switch-to-text' | undefined> {
    const mode = ctx.mode();
    await this.maybeCompact(ctx, mode, toolMode, signal);
    if (signal.aborted) return undefined;
    const defs = this.env.tools.definitions(this.availableTools(ctx, mode));
    const system = this.systemMessage(ctx, mode, toolMode, defs);
    const messages: WireMessage[] = [{ role: 'system', content: system }, ...this.wire];
    const size = measurePrompt(messages, toolMode === 'native' ? defs : undefined);
    const estimate = ctx.calibrator.estimate(ctx.model.id, size);
    const verdict = preflight(estimate, ctx.model.contextSize, outputReserve(ctx.model.contextSize));
    this.usage = { promptTokens: estimate, contextSize: ctx.model.contextSize, contextSource: ctx.model.contextSource, estimated: true };
    if (verdict.kind === 'over') {
      this.pushError(
        `The next request (about ${estimate} tokens including the agent's instructions and tool definitions) does not fit in ${ctx.model.name}'s context window ` +
          `(${ctx.model.contextSize} tokens${ctx.model.contextSource === 'assumed' ? ', assumed because Open WebUI does not report it' : ''}). ` +
          (ctx.model.contextSource === 'assumed'
            ? 'If your server already runs this model with a larger context, set the size with the button below (it is also sent to Ollama as num_ctx), or start a new session.'
            : 'Raise the context size with the button below (it is also sent to Ollama as num_ctx), or start a new session.'),
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
    let parser = new TextToolParser();

    let turn: AssistantTurn;
    try {
      turn = await this.env.client.chat(
        {
          model: ctx.model.id,
          messages,
          ...(toolMode === 'native' ? { tools: defs } : { stop: [RESULT_TAG] }),
          ...(ctx.model.thinking !== undefined ? { think: ctx.model.thinking } : {}),
          ...(ctx.model.contextSource === 'setting' ? { numCtx: ctx.model.contextSize } : {}),
        },
        {
          onDelta: (d) => {
            item.interrupted = undefined;
            if (d.kind === 'reasoning') {
              item.reasoning += d.text;
              this.events.delta(item.id, d);
              return;
            }
            const text = toolMode === 'text' ? parser.push(d.text).display : d.text;
            if (!text) return;
            item.text += text;
            this.events.delta(item.id, { kind: 'content', text });
          },
          onRetry: (info) => {
            parser = new TextToolParser();
            this.onRetry(item, info);
          },
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
      if (e instanceof HttpError && e.toolsUnsupported && toolMode === 'native' && ctx.model.toolMode === 'auto') {
        this.removeItem(item);
        return 'switch-to-text';
      }
      if (!item.text && !item.reasoning) this.removeItem(item);
      else item.interrupted = 'The response was interrupted.';
      this.pushError(describe(e), actionFor(e));
      return undefined;
    }

    item.streaming = false;
    item.interrupted = undefined;
    item.reasoning = turn.reasoning;
    let calls: PendingCall[];
    const content = stripThinkTags(turn.content);
    if (toolMode === 'text') {
      const tail = parser.flush();
      if (tail.display) item.text += tail.display;
      let parsed = parser.calls;
      if (!parsed.length && /<agent_tool>[\s\S]*?<\/agent_tool>/.test(content)) parsed = extractCallsIgnoringFences(content);
      calls = parsed.map((c, i) => {
        const call: PendingCall = { id: `t${Date.now().toString(36)}${i}`, name: c.name ?? 'unknown', arguments: c.arguments ?? '{}' };
        if (c.error) call.parseError = c.error;
        return call;
      });
      const resultAt = content.indexOf(RESULT_TAG);
      this.wire.push({ role: 'assistant', content: resultAt === -1 ? content : content.slice(0, resultAt).trimEnd() });
    } else {
      item.text = turn.content;
      calls = turn.toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }));
      const msg: WireMessage = { role: 'assistant', content: content || null };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      this.wire.push(msg);
    }
    item.text = item.text.trim() ? item.text : '';
    if (!item.text && !item.reasoning) this.removeItem(item);
    this.recordUsage(ctx, size, estimate, turn.usage);
    if (!calls.length && turn.finishReason === 'length') {
      this.pushWarning('The model stopped because it reached its output limit. Ask it to continue, or raise the limit in Open WebUI.');
    }
    this.events.changed();
    return { calls };
  }

  private async executeCalls(calls: PendingCall[], toolMode: 'native' | 'text', ctx: RunContext, signal: AbortSignal): Promise<boolean> {
    const outcomes: CallOutcome[] = [];
    const images: ImageAttachment[] = [];
    let proceed = true;
    for (const call of calls) {
      if (signal.aborted || !proceed) {
        outcomes.push({ call, result: { content: signal.aborted ? 'Cancelled by the user.' : 'Not run because the user denied the previous action.', isError: true } });
        continue;
      }
      const { result, stop } = await this.executeOne(call, ctx, signal);
      outcomes.push({ call, result });
      if (result.images) images.push(...result.images);
      if (stop) proceed = false;
    }
    const limit = Math.max(4000, Math.min(60_000, Math.round(ctx.model.contextSize * ctx.calibrator.charsPerToken(ctx.model.id) * 0.3)));
    const clipped = outcomes.map((o) => ({ ...o, content: truncateMiddle(o.result.content, limit).text }));
    if (toolMode === 'native') {
      for (const o of clipped) this.wire.push({ role: 'tool', tool_call_id: o.call.id, content: o.content });
    }
    const imageParts: ContentPart[] = images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } }));
    if (toolMode === 'text') {
      const text = formatToolResults(clipped.map((o) => ({ name: o.call.name, id: o.call.id, content: o.content, isError: !!o.result.isError })));
      this.wire.push({ role: 'user', content: imageParts.length ? [{ type: 'text', text }, ...imageParts] : text });
    } else if (imageParts.length) {
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
      this.events.changed();
      return { result, ...extra };
    };
    if (call.parseError) return finish('error', { content: call.parseError, isError: true });
    if (!tool) {
      const names = this.env.tools.list().map((t) => t.name).join(', ');
      return finish('error', { content: `Unknown tool "${call.name}". Available tools: ${names}.`, isError: true });
    }
    const parsed = parseArguments(call.arguments);
    if (parsed.error || !parsed.value) return finish('error', { content: parsed.error ?? 'Invalid arguments.', isError: true });
    const args = coerceArgs(tool.parameters, parsed.value);
    const errors = validateArgs(tool.parameters, args);
    card.title = safeTitle(tool, args);
    if (!ctx.toolEnabled(tool.name)) {
      return finish('error', { content: `${tool.name} is turned off in the OWUI Agent settings.`, isError: true });
    }
    if (!toolsForMode([tool], ctx.mode()).length) {
      return finish('error', {
        content:
          ctx.mode() === 'plan'
            ? `${tool.name} is not available in plan mode. Investigate with read-only tools, then call exit_plan_mode with your plan.`
            : `${tool.name} is only available in plan mode.`,
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
      skills: this.skills,
      workspaceDirCreated: (dir) => ctx.onWorkspaceDirCreated(dir),
      browser: this.env.browser,
      web: this.env.web,
      presentPlan: (plan) => this.presentPlan(plan, ctx, signal),
      setTodos: (todos) => {
        this.todos = todos;
        this.events.changed();
      },
    };
  }

  private async presentPlan(plan: string, ctx: RunContext, signal: AbortSignal): Promise<PlanAnswer> {
    const item: Extract<TranscriptItem, { kind: 'plan' }> = { id: randomUUID(), kind: 'plan', ts: Date.now(), plan, status: 'open' };
    this.transcript.push(item);
    this.events.changed();
    const answer = await waitFor<PlanAnswer | undefined>(signal, undefined, (resolve) => this.plans.set(item.id, resolve));
    this.plans.delete(item.id);
    if (!answer) {
      item.status = 'cancelled';
      this.events.changed();
      throw new Error('The user did not respond to the plan.');
    }
    if (answer.approved) {
      item.status = 'approved';
      this.approvedPlan = plan;
      item.approvedMode = answer.mode;
      await ctx.setMode(answer.mode);
    } else {
      item.status = 'revise';
      item.feedback = answer.feedback;
    }
    this.events.changed();
    return answer;
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

  private recordUsage(ctx: RunContext, size: ReturnType<typeof measurePrompt>, estimate: number, usage: Usage | null): void {
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
  const one = text.replace(/s+/g, ' ').trim();
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

