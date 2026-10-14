import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ApiKeyStore } from '../config/secrets';
import { readSettings, updateModelOverride } from '../config/settings';
import { isInsecureRemote, parseBaseUrl } from '../net/egress';
import type { OwuiClient } from '../owui/client';
import { HttpError, MissingApiKeyError } from '../owui/errors';
import { resolveModel, type ResolvedModel, type ServerModel } from '../owui/models';
import type { StreamDelta } from '../owui/streamAssembler';
import { TokenCalibrator, type CalibrationState } from '../owui/tokens';
import type { Usage } from '../owui/types';
import type { ConnectionView, ModelView, SovereigntyLevel, ViewState } from '../shared/protocol';
import { ChatSession, type RunContext } from './session';
import { renderSystemPrompt } from './systemPrompt';

const STATE_NOTICE = 'owuiAgent.sovereigntyNoticeAcknowledged';
const STATE_MODEL = 'owuiAgent.selectedModel';
const STATE_CALIBRATION = 'owuiAgent.tokenCalibration';
const STATE_WARNED = 'owuiAgent.warnedOnce';
const STATE_TOTALS = 'owuiAgent.tokenTotals';

export interface TokenTotals {
  prompt: number;
  completion: number;
  requests: number;
}

export interface ControllerListener {
  state(state: ViewState): void;
  delta(id: string, delta: StreamDelta): void;
}

export class ChatController {
  private serverModels: ServerModel[] = [];
  private connection: ConnectionView;
  private session: ChatSession;
  private readonly calibrator: TokenCalibrator;
  private listener: ControllerListener | undefined;
  private refreshSeq = 0;
  private readonly idle = new Set<() => void>();

  constructor(
    private readonly client: OwuiClient,
    private readonly keys: ApiKeyStore,
    private readonly globalState: vscode.Memento,
  ) {
    this.calibrator = new TokenCalibrator(globalState.get<Record<string, CalibrationState>>(STATE_CALIBRATION, {}));
    this.connection = { baseUrl: '', insecure: false, hasKey: false, status: 'unknown' };
    this.session = this.newChatSession();
  }

  setListener(listener: ControllerListener | undefined): void {
    this.listener = listener;
  }

  get currentSession(): ChatSession {
    return this.session;
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const settings = readSettings();
    const conn: ConnectionView = { baseUrl: settings.baseUrl, insecure: false, hasKey: !!(await this.keys.get()), status: 'connecting' };
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
      const [version, models] = await Promise.all([this.client.version().catch(() => undefined), this.client.listModels()]);
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
    await this.globalState.update(STATE_MODEL, id);
    this.emitState();
  }

  async setModelLocal(id: string, local: boolean): Promise<void> {
    await updateModelOverride(id, { local });
    this.emitState();
  }

  async acknowledgeNotice(): Promise<void> {
    await this.globalState.update(STATE_NOTICE, true);
    this.emitState();
  }

  async resetNotice(): Promise<void> {
    await this.globalState.update(STATE_NOTICE, false);
    this.emitState();
  }

  newSession(): void {
    this.session.stop();
    this.session = this.newChatSession();
    this.emitState();
  }

  stop(): void {
    this.session.stop();
  }

  async send(text: string): Promise<void> {
    const ctx = this.runContext();
    if (!ctx) return;
    await this.session.send(text, ctx);
    this.notifyIdle();
  }

  async retry(): Promise<void> {
    const ctx = this.runContext();
    if (!ctx) return;
    await this.session.retry(ctx);
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
      contextSize: m.contextSize,
      contextSource: m.contextSource,
    }));
    const state: ViewState = {
      connection: this.connection,
      models,
      busy: this.session.busy,
      transcript: this.session.transcript,
      sovereignty: sovereignty(selected),
      noticeAcknowledged: this.globalState.get<boolean>(STATE_NOTICE, false),
    };
    if (selected) state.selectedModel = selected.id;
    const usage = this.session.usage ?? (selected ? { promptTokens: 0, contextSize: selected.contextSize, contextSource: selected.contextSource, estimated: true } : undefined);
    if (usage) state.usage = usage;
    return state;
  }

  emitState(): void {
    this.listener?.state(this.viewState());
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
    const folder = vscode.workspace.workspaceFolders?.[0];
    return {
      model,
      systemPrompt: renderSystemPrompt({
        os: `${os.type()} ${os.release()} (${process.platform})`,
        date: new Date().toISOString().slice(0, 10),
        workspace: folder ? folder.uri.fsPath : '(no folder open)',
      }),
      calibrator: this.calibrator,
      warnOnce: (key, text) => this.warnOnce(key, text),
    };
  }

  private warnOnce(key: string, text: string): void {
    const persistent = key.startsWith('usage:');
    const warned = this.globalState.get<string[]>(STATE_WARNED, []);
    if (persistent && warned.includes(key)) return;
    if (!persistent && this.session.transcript.some((t) => t.kind === 'warning' && t.id === key)) return;
    this.session.transcript.push({ id: persistent ? randomUUID() : key, kind: 'warning', text, ts: Date.now() });
    if (persistent) void this.globalState.update(STATE_WARNED, [...warned, key]);
  }

  private newChatSession(): ChatSession {
    return new ChatSession(this.client, {
      changed: () => this.emitState(),
      delta: (id, d) => this.listener?.delta(id, d),
      usage: (model, usage) => this.recordTotals(model, usage),
    });
  }

  private recordTotals(model: ResolvedModel, usage: Usage | null): void {
    void this.globalState.update(STATE_CALIBRATION, this.calibrator.snapshot());
    if (!usage) return;
    const totals = this.globalState.get<Record<string, TokenTotals>>(STATE_TOTALS, {});
    const cur = totals[model.id] ?? { prompt: 0, completion: 0, requests: 0 };
    totals[model.id] = { prompt: cur.prompt + usage.promptTokens, completion: cur.completion + usage.completionTokens, requests: cur.requests + 1 };
    void this.globalState.update(STATE_TOTALS, totals);
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
    const id = this.globalState.get<string>(STATE_MODEL);
    return models.find((m) => m.id === id) ?? models.find((m) => m.id === readSettings().defaultModel) ?? models[0];
  }

  private ensureSelection(): void {
    const id = this.globalState.get<string>(STATE_MODEL);
    if (id && this.serverModels.some((m) => m.id === id)) return;
    const fallback = this.selectedModel();
    if (fallback) void this.globalState.update(STATE_MODEL, fallback.id);
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
