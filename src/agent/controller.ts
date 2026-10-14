import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CheckpointManager } from '../checkpoints/checkpoints';
import { ShadowGit } from '../checkpoints/shadowGit';
import type { ApiKeyStore } from '../config/secrets';
import { addAllowlistEntry, readSettings, updateModelOverride } from '../config/settings';
import { DiffStore } from '../diff/diffStore';
import { isInsecureRemote, parseBaseUrl } from '../net/egress';
import type { OwuiClient } from '../owui/client';
import { HttpError, MissingApiKeyError } from '../owui/errors';
import { resolveModel, type ResolvedModel, type ServerModel } from '../owui/models';
import type { StreamDelta } from '../owui/streamAssembler';
import { TokenCalibrator, type CalibrationState } from '../owui/tokens';
import type { Usage } from '../owui/types';
import type { AgentMode, ApprovalDecision, ConnectionView, ModelView, PlanAnswer, RewindScope, SovereigntyLevel, ToolCardUpdate, ViewState } from '../shared/protocol';
import { scratchRoot } from '../storage/scratchpad';
import type { ToolRegistry } from '../tools/registry';
import { ProcessManager } from '../tools/shell/processManager';
import type { ShellRegistry } from '../tools/shell/shells';
import type { PathGuard } from '../workspace/paths';
import { AgentSession, type RunContext } from './session';
import { MODE_TEXT, renderSystemPrompt } from './systemPrompt';

const STATE_NOTICE = 'owuiAgent.sovereigntyNoticeAcknowledged';
const STATE_MODEL = 'owuiAgent.selectedModel';
const STATE_MODE = 'owuiAgent.mode';
const STATE_CALIBRATION = 'owuiAgent.tokenCalibration';
const STATE_WARNED = 'owuiAgent.warnedOnce';
const STATE_TOTALS = 'owuiAgent.tokenTotals';
const STATE_TEXT_MODE = 'owuiAgent.textToolModels';

export interface TokenTotals {
  prompt: number;
  completion: number;
  requests: number;
}

export interface ControllerListener {
  state(state: ViewState): void;
  delta(id: string, delta: StreamDelta): void;
  toolUpdate(id: string, patch: ToolCardUpdate): void;
}

export interface ControllerDeps {
  client: OwuiClient;
  keys: ApiKeyStore;
  globalState: vscode.Memento;
  globalStorage: string;
  tools: ToolRegistry;
  shells: ShellRegistry;
  paths: (scratchpad: string) => PathGuard;
  ripgrep: string | undefined;
  workspaceStorage: string | undefined;
  checkpointsEnabled: () => boolean;
  confirm(message: string, detail: string, action: string): Promise<boolean>;
}

export class AgentController implements vscode.Disposable {
  private serverModels: ServerModel[] = [];
  private connection: ConnectionView;
  private session: AgentSession;
  private readonly calibrator: TokenCalibrator;
  private listener: ControllerListener | undefined;
  private refreshSeq = 0;
  private readonly idle = new Set<() => void>();
  readonly diffs = new DiffStore();
  private shadow: ShadowGit | undefined;

  constructor(private readonly deps: ControllerDeps) {
    this.calibrator = new TokenCalibrator(deps.globalState.get<Record<string, CalibrationState>>(STATE_CALIBRATION, {}));
    this.connection = { baseUrl: '', insecure: false, hasKey: false, status: 'unknown' };
    this.session = this.newAgentSession();
  }

  setListener(listener: ControllerListener | undefined): void {
    this.listener = listener;
  }

  get currentSession(): AgentSession {
    return this.session;
  }

  get mode(): AgentMode {
    return this.deps.globalState.get<AgentMode>(STATE_MODE, 'ask');
  }

  async setMode(mode: AgentMode): Promise<void> {
    await this.deps.globalState.update(STATE_MODE, mode);
    this.emitState();
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const settings = readSettings();
    const conn: ConnectionView = { baseUrl: settings.baseUrl, insecure: false, hasKey: !!(await this.deps.keys.get()), status: 'connecting' };
    try {
      conn.insecure = isInsecureRemote(parseBaseUrl(settings.baseUrl));
    } catch (e) {
      conn.baseUrlError = (e as Error).message;
      conn.status = 'error';
    }
    this.connection = conn;
    this.emitState();
    if (conn.status === 'error') return;
    if (!conn.hasKey) {
      this.connection = { ...conn, status: 'error', error: new MissingApiKeyError().message };
      this.emitState();
      return;
    }
    try {
      const [version, models] = await Promise.all([this.deps.client.version().catch(() => undefined), this.deps.client.listModels()]);
      if (seq !== this.refreshSeq) return;
      this.serverModels = models;
      this.connection = { ...conn, status: 'ok' };
      if (version) this.connection.serverVersion = version;
      this.ensureSelection();
    } catch (e) {
      if (seq !== this.refreshSeq) return;
      this.connection = { ...conn, status: 'error', error: connectionMessage(e) };
    }
    this.emitState();
  }

  async selectModel(id: string): Promise<void> {
    if (!this.serverModels.some((m) => m.id === id)) return;
    await this.deps.globalState.update(STATE_MODEL, id);
    this.emitState();
  }

  async setModelLocal(id: string, local: boolean): Promise<void> {
    await updateModelOverride(id, { local });
    this.emitState();
  }

  async setModelThinking(id: string, thinking: boolean): Promise<void> {
    await updateModelOverride(id, { thinking });
    this.emitState();
  }

  async acknowledgeNotice(): Promise<void> {
    await this.deps.globalState.update(STATE_NOTICE, true);
    this.emitState();
  }

  async resetNotice(): Promise<void> {
    await this.deps.globalState.update(STATE_NOTICE, false);
    this.emitState();
  }

  newSession(): void {
    void this.session.dispose();
    this.session = this.newAgentSession();
    this.emitState();
  }

  stop(): void {
    this.session.stop();
  }

  approve(itemId: string, decision: ApprovalDecision): void {
    this.session.resolveApproval(itemId, decision);
  }

  planDecision(itemId: string, answer: PlanAnswer): void {
    this.session.resolvePlan(itemId, answer);
  }

  async review(itemId: string, absolute: string | undefined, decision: 'keep' | 'revert'): Promise<void> {
    await this.session.reviewDecision(itemId, absolute, decision);
  }

  async rewind(userItemId: string, scope: RewindScope): Promise<string | undefined> {
    if (this.session.busy) {
      void vscode.window.showWarningMessage('Stop the agent before rewinding.');
      return undefined;
    }
    if (scope !== 'conversation') {
      const preview = await this.session.rewindPreview(userItemId).catch((e: Error) => e);
      if (preview instanceof Error) {
        void vscode.window.showErrorMessage(`Could not prepare the rewind: ${preview.message}`);
        return undefined;
      }
      if (!preview) {
        void vscode.window.showWarningMessage('No checkpoint exists for that message.');
        return undefined;
      }
      if (preview.changes.length) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const lines = preview.changes.slice(0, 15).map((c) => `${c.action === 'delete' ? 'Delete' : 'Restore'} ${path.relative(root, c.absolute) || c.absolute}`);
        const more = preview.changes.length > 15 ? `\n…and ${preview.changes.length - 15} more` : '';
        const note =
          preview.method === 'git'
            ? 'This restores every change in the workspace since that message, including changes you made yourself. Ignored folders such as node_modules are not restored.'
            : 'Snapshots were unavailable, so only files the agent edited are restored.';
        const ok = await this.deps.confirm(`Rewind ${preview.changes.length} file(s)?`, `${lines.join('\n')}${more}\n\n${note}`, 'Rewind');
        if (!ok) return undefined;
      }
    }
    const result = await this.session.rewind(userItemId, scope).catch((e: Error) => {
      void vscode.window.showErrorMessage(`Rewind failed: ${e.message}`);
      return undefined;
    });
    this.emitState();
    return result && scope !== 'code' ? result.text : undefined;
  }

  answer(itemId: string, answers: string[][]): void {
    this.session.resolveQuestion(itemId, answers);
  }

  async send(text: string): Promise<void> {
    const ctx = this.runContext();
    if (!ctx) return;
    await this.session.send(text, ctx);
    this.notifyIdle();
  }

  async resume(): Promise<void> {
    const ctx = this.runContext();
    if (!ctx) return;
    await this.session.resume(ctx);
    this.notifyIdle();
  }

  whenIdle(): Promise<void> {
    if (!this.session.busy) return Promise.resolve();
    return new Promise((resolve) => this.idle.add(resolve));
  }

  viewState(): ViewState {
    const selected = this.selectedModel();
    const models: ModelView[] = this.resolvedModels().map((m) => ({
      id: m.id,
      name: m.name,
      local: m.local,
      vision: m.vision,
      thinking: m.thinking ?? true,
      contextSize: m.contextSize,
      contextSource: m.contextSource,
    }));
    const state: ViewState = {
      connection: this.connection,
      models,
      busy: this.session.busy,
      mode: this.mode,
      transcript: this.session.transcript,
      todos: this.session.todos,
      sovereignty: sovereignty(selected),
      noticeAcknowledged: this.deps.globalState.get<boolean>(STATE_NOTICE, false),
    };
    if (selected) state.selectedModel = selected.id;
    const usage = this.session.usage ?? (selected ? { promptTokens: 0, contextSize: selected.contextSize, contextSource: selected.contextSource, estimated: true } : undefined);
    if (usage) state.usage = usage;
    return state;
  }

  emitState(): void {
    this.listener?.state(this.viewState());
  }

  dispose(): void {
    void this.session.dispose();
  }

  private runContext(): RunContext | undefined {
    const model = this.selectedModel();
    if (!model) {
      this.session.transcript.push({
        id: randomUUID(),
        kind: 'error',
        ts: Date.now(),
        text: this.connection.status === 'ok' ? 'No model is available. Check the model list in Open WebUI.' : this.connection.error ?? 'Not connected to Open WebUI.',
        action: this.connection.hasKey ? 'openSettings' : 'setApiKey',
      });
      this.emitState();
      return undefined;
    }
    const settings = readSettings();
    const shellPref = process.platform === 'win32' ? settings.windowsShell : settings.posixShell;
    const shell = this.deps.shells.pick(shellPref === 'auto' ? undefined : shellPref);
    const folder = vscode.workspace.workspaceFolders?.[0];
    const textModels = this.deps.globalState.get<string[]>(STATE_TEXT_MODE, []);
    const toolMode = model.toolMode === 'text' || (model.toolMode === 'auto' && textModels.includes(model.id)) ? 'text' : 'native';
    const scratchpad = this.session.scratchpad;
    return {
      model,
      toolMode,
      systemPrompt: (mode) =>
        renderSystemPrompt({
          os: `${os.type()} ${os.release()} (${process.platform})`,
          shell: `${shell.label} (${shell.id})`,
          shells: this.deps.shells.available().map((s) => `${s.label} (${s.id})`).join(', '),
          date: new Date().toISOString().slice(0, 10),
          workspace: folder ? folder.uri.fsPath : '(no folder open; work in the scratchpad)',
          scratchpad,
          mode: MODE_TEXT[mode] ?? mode,
        }),
      calibrator: this.calibrator,
      mode: () => this.mode,
      allowlist: () => readSettings().commandAllowlist,
      toolSettings: {
        commandTimeoutSeconds: settings.commandTimeoutSeconds,
        maxOutputChars: Math.max(4000, Math.min(30_000, Math.round(model.contextSize * 0.6))),
        defaultShell: shell.id,
      },
      maxIterations: settings.maxIterations,
      warnOnce: (key, text) => this.warnOnce(key, text),
      onToolsUnsupported: () => {
        if (!textModels.includes(model.id)) void this.deps.globalState.update(STATE_TEXT_MODE, [...textModels, model.id]);
      },
      addAllowlistEntry: (entry) => addAllowlistEntry(entry),
      setMode: (mode) => this.setMode(mode),
    };
  }

  private warnOnce(key: string, text: string): void {
    const persistent = key.startsWith('usage:') || key.startsWith('textmode:');
    const warned = this.deps.globalState.get<string[]>(STATE_WARNED, []);
    if (persistent && warned.includes(key)) return;
    if (!persistent && this.session.transcript.some((t) => t.kind === 'warning' && t.id === key)) return;
    this.session.transcript.push({ id: persistent ? randomUUID() : key, kind: 'warning', text, ts: Date.now() });
    if (persistent) void this.deps.globalState.update(STATE_WARNED, [...warned, key]);
  }

  private newAgentSession(): AgentSession {
    const id = randomUUID();
    const scratchpad = path.join(scratchRoot(this.deps.globalStorage), `${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`);
    void mkdir(scratchpad, { recursive: true }).catch(() => undefined);
    const session = new AgentSession(
      {
        client: this.deps.client,
        tools: this.deps.tools,
        shells: this.deps.shells,
        paths: this.deps.paths(scratchpad),
        processes: new ProcessManager(),
        scratchpad,
        ripgrep: this.deps.ripgrep,
        checkpoints: new CheckpointManager(this.shadowGit(), path.join(this.deps.globalStorage, 'backups', id)),
        diffs: this.diffs,
      },
      {
        changed: () => this.emitState(),
        delta: (itemId, d) => this.listener?.delta(itemId, d),
        toolUpdate: (itemId, patch) => this.listener?.toolUpdate(itemId, patch),
        usage: (model, usage) => this.recordTotals(model, usage),
      },
      id,
    );
    return session;
  }

  private shadowGit(): ShadowGit | undefined {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || !this.deps.workspaceStorage || !this.deps.checkpointsEnabled()) return undefined;
    if (this.shadow?.workTree !== root) this.shadow = new ShadowGit({ gitDir: path.join(this.deps.workspaceStorage, 'checkpoints', 'git'), workTree: root });
    return this.shadow;
  }

  private recordTotals(model: ResolvedModel, usage: Usage | null): void {
    void this.deps.globalState.update(STATE_CALIBRATION, this.calibrator.snapshot());
    if (!usage) return;
    const totals = this.deps.globalState.get<Record<string, TokenTotals>>(STATE_TOTALS, {});
    const cur = totals[model.id] ?? { prompt: 0, completion: 0, requests: 0 };
    totals[model.id] = { prompt: cur.prompt + usage.promptTokens, completion: cur.completion + usage.completionTokens, requests: cur.requests + 1 };
    void this.deps.globalState.update(STATE_TOTALS, totals);
  }

  private notifyIdle(): void {
    if (this.session.busy) return;
    for (const resolve of this.idle) resolve();
    this.idle.clear();
  }

  private resolvedModels(): ResolvedModel[] {
    const overrides = readSettings().models;
    return this.serverModels.map((m) => resolveModel(m, overrides[m.id]));
  }

  private selectedModel(): ResolvedModel | undefined {
    const models = this.resolvedModels();
    const id = this.deps.globalState.get<string>(STATE_MODEL);
    return models.find((m) => m.id === id) ?? models.find((m) => m.id === readSettings().defaultModel) ?? models[0];
  }

  private ensureSelection(): void {
    const id = this.deps.globalState.get<string>(STATE_MODEL);
    if (id && this.serverModels.some((m) => m.id === id)) return;
    const fallback = this.selectedModel();
    if (fallback) void this.deps.globalState.update(STATE_MODEL, fallback.id);
  }
}

function sovereignty(model: ResolvedModel | undefined): SovereigntyLevel {
  if (!model) return 'none';
  return model.local ? 'local' : 'unverified';
}

function connectionMessage(e: unknown): string {
  if (e instanceof HttpError && e.isAuth) {
    return `Open WebUI rejected the API key (${e.message}). Check that the key is valid and that API keys are enabled for your account.`;
  }
  if (e instanceof HttpError) return `Open WebUI returned an error: ${e.message}`;
  const cause = (e as { cause?: { code?: string } }).cause?.code;
  if (cause === 'ECONNREFUSED') return 'Could not connect to Open WebUI: connection refused. Is it running at the configured base URL?';
  if (cause === 'ENOTFOUND') return 'Could not connect to Open WebUI: host not found. Check the base URL.';
  return `Could not connect to Open WebUI: ${e instanceof Error ? e.message : String(e)}`;
}
