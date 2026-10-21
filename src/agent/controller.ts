import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CheckpointManager } from '../checkpoints/checkpoints';
import type { ApiKeyStore } from '../config/secrets';
import { addAllowlistEntry, readSettings, updateModelOverride } from '../config/settings';
import { BrowserSession } from '../browser/session';
import { DiffStore } from '../diff/diffStore';
import webPrompt from '../../prompts/web-untrusted.md';
import type { OwuiWeb } from '../owui/web';
import { BROWSER_TOOLS, WEB_TOOLS } from '../tools/registry';
import { OWUI_DIR, loadProjectContext } from '../memory/projectMemory';
import { discoverSkills } from '../skills/discovery';
import { sanitizeForStorage, toMarkdown, titleFrom, type HistoryStore, type SessionRecord } from '../storage/history';
import { isInsecureRemote, parseBaseUrl } from '../net/egress';
import type { OwuiClient } from '../owui/client';
import { HttpError, MissingApiKeyError } from '../owui/errors';
import { resolveModel, type ResolvedModel, type ServerModel } from '../owui/models';
import type { StreamDelta } from '../owui/streamAssembler';
import { TokenCalibrator, type CalibrationState } from '../owui/tokens';
import type { Usage } from '../owui/types';
import type { AgentMode, ApprovalDecision, ConnectionView, HistoryEntry, ModelView, RewindScope, SovereigntyLevel, ToolCardUpdate, ViewState, WebStatusView } from '../shared/protocol';
import { scratchRoot } from '../storage/scratchpad';
import type { ToolRegistry } from '../tools/registry';
import { ProcessManager } from '../tools/shell/processManager';
import type { ShellRegistry } from '../tools/shell/shells';
import type { PathGuard } from '../workspace/paths';
import { AgentSession, type RunContext } from './session';
import { renderSystemPrompt } from './systemPrompt';
import { describeError, log } from '../log';

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
  history(entries: HistoryEntry[], query: string): void;
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
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  history: HistoryStore;
  backupsRoot: string;
  web: OwuiWeb;
  workspaceState: vscode.Memento;
  userSkillsDir: () => string;
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
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  private webStatus: WebStatusView = { enabled: false, verification: 'unverified' };
  private firstUnsavedChange = 0;
  private readonly deletedSessions = new Set<string>();

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
      const versionRequest = this.deps.client.version().catch((e: unknown) => {
        log.warn(`Could not read the Open WebUI version: ${describeError(e)}`);
        return undefined;
      });
      const [version, models] = await Promise.all([versionRequest, this.deps.client.listModels()]);
      if (seq !== this.refreshSeq) return;
      this.serverModels = models;
      this.connection = { ...conn, status: 'ok' };
      await this.refreshWebStatus();
      if (version) this.connection.serverVersion = version;
      this.ensureSelection();
      log.info(`Connected to Open WebUI ${version ?? '(unknown version)'} at ${conn.baseUrl}: ${models.length} model(s).`);
    } catch (e) {
      if (seq !== this.refreshSeq) return;
      this.connection = { ...conn, status: 'error', error: connectionMessage(e) };
      log.error(`Could not connect to Open WebUI at ${conn.baseUrl}: ${describeError(e)}`);
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

  async setContextSize(id: string): Promise<void> {
    const model = id ? this.resolvedModels().find((m) => m.id === id) : this.selectedModel();
    if (!model) return;
    const max = model.maxContext;
    const suggestion = model.contextSize;
    const value = await vscode.window.showInputBox({
      title: `Context size for ${model.name}`,
      prompt:
        'Tokens the model can see at once. This must match what the server runs: the extension sends it to Ollama as num_ctx, so Ollama uses it too. Larger values need more memory.' +
        (max ? ` The model supports up to ${max.toLocaleString()}.` : ''),
      value: String(suggestion),
      ignoreFocusOut: true,
      validateInput: (v) => {
        const n = Number(v.replace(/[_,\s]/g, ''));
        if (!Number.isInteger(n) || n < 2048) return 'Enter a whole number of at least 2048.';
        if (max && n > max) return `This model supports at most ${max.toLocaleString()} tokens.`;
        return undefined;
      },
    });
    if (value === undefined) return;
    await updateModelOverride(id, { contextSize: Number(value.replace(/[_,\s]/g, '')) });
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
    void this.saveNow();
    void this.session.dispose();
    this.session = this.newAgentSession();
    this.titleOverride = undefined;
    this.emitState();
  }

  stop(): void {
    this.session.stop();
  }

  approve(itemId: string, decision: ApprovalDecision): void {
    this.session.resolveApproval(itemId, decision);
  }

  async review(itemId: string, absolute: string | undefined, decision: 'keep' | 'revert'): Promise<void> {
    if (this.session.busy) {
      void vscode.window.showWarningMessage('Wait until the agent has finished, or stop it, before reviewing changes.');
      return;
    }
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
      if (preview.length) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const verb = { restore: 'Restore', delete: 'Delete', skip: 'Cannot restore (not backed up)' } as const;
        const lines = preview.slice(0, 15).map((c) => `${verb[c.action]} ${path.relative(root, c.absolute) || c.absolute}${c.changedSince ? ' (changed after the agent edited it)' : ''}`);
        const more = preview.length > 15 ? `\n…and ${preview.length - 15} more` : '';
        const changed = preview.filter((c) => c.changedSince && c.action !== 'skip').length;
        const notes = ["This undoes the agent's file edits, not changes made by shell commands."];
        if (changed) notes.push(`${changed} file(s) changed after the agent's last edit; rewinding discards those later changes too.`);
        const ok = await this.deps.confirm(`Rewind ${preview.length} file(s)?`, `${lines.join('\n')}${more}\n\n${notes.join(' ')}`, 'Rewind');
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
    if (text.trim() === '/compact') {
      await this.compact();
      return;
    }
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

  async compact(): Promise<void> {
    const ctx = this.runContext();
    if (!ctx) return;
    await this.session.compactNow(ctx);
  }

  async listHistory(query = ''): Promise<void> {
    const sessions = query.trim() ? await this.deps.history.search(query) : await this.deps.history.list();
    const entries: HistoryEntry[] = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updated: s.updated,
      messages: s.messages,
      preview: s.preview,
      ...(s.match ? { match: s.match } : {}),
    }));
    this.listener?.history(entries, query);
  }

  async resumeSession(id: string): Promise<void> {
    if (this.session.busy) {
      void vscode.window.showWarningMessage('Stop the agent before switching sessions.');
      return;
    }
    if (id === this.session.id) return;
    const record = await this.deps.history.load(id);
    if (!record) {
      void vscode.window.showErrorMessage('That session could not be loaded.');
      await this.listHistory();
      return;
    }
    await this.saveNow();
    void this.session.dispose();
    this.session = this.newAgentSession(record);
    this.titleOverride = record.title;
    this.dirty = false;
    this.emitState();
  }

  async renameSession(id: string): Promise<void> {
    const record = id === this.session.id ? undefined : await this.deps.history.load(id);
    const current = record?.title ?? this.titleOverride ?? titleFrom(this.session.transcript);
    const title = await vscode.window.showInputBox({ title: 'Rename session', value: current, validateInput: (v) => (v.trim() ? undefined : 'The name cannot be empty.') });
    if (!title?.trim()) return;
    if (id === this.session.id) {
      this.titleOverride = title.trim();
      this.markDirty();
      await this.saveNow();
    } else {
      await this.deps.history.rename(id, title);
    }
    await this.listHistory();
  }

  async deleteSession(id: string): Promise<void> {
    const ok = await this.deps.confirm('Delete this session?', 'Its conversation history and saved file backups are removed from this machine. This cannot be undone.', 'Delete');
    if (!ok) return;
    this.deletedSessions.add(id);
    if (id === this.session.id) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.dirty = false;
      void this.session.dispose();
      this.session = this.newAgentSession();
      this.titleOverride = undefined;
      this.emitState();
    }
    await this.saving;
    await this.deps.history.delete(id);
    await rm(this.backupDir(id), { recursive: true, force: true }).catch(() => undefined);
    await this.listHistory();
  }

  async exportSession(id: string): Promise<void> {
    const record = id === this.session.id ? this.currentRecord() : await this.deps.history.load(id);
    if (!record) return;
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Markdown', description: 'Readable transcript', ext: 'md' },
        { label: 'JSON', description: 'Complete session data', ext: 'json' },
      ],
      { title: 'Export session as' },
    );
    if (!pick) return;
    const base = record.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      title: 'Export session',
      ...(folder ? { defaultUri: vscode.Uri.joinPath(folder, `${base}.${pick.ext}`) } : {}),
      filters: pick.ext === 'md' ? { Markdown: ['md'] } : { JSON: ['json'] },
    });
    if (!target) return;
    const content = pick.ext === 'md' ? toMarkdown(record) : JSON.stringify(sanitizeForStorage(record), null, 2);
    await writeFile(target.fsPath, content, 'utf8');
    void vscode.window.showInformationMessage(`Exported to ${target.fsPath}`);
  }

  async pruneOrphanBackups(maxAgeMs = 2 * 24 * 60 * 60 * 1000): Promise<void> {
    const dir = this.deps.backupsRoot;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const profiles = path.join(this.deps.globalStorage, 'browser-profiles');
    for (const name of await readdir(profiles).catch(() => [] as string[])) {
      if (name === this.session.id) continue;
      const full = path.join(profiles, name);
      const st = await stat(full).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > 6 * 60 * 60 * 1000) await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
    const known = new Set((await this.deps.history.list()).map((s) => s.id));
    for (const name of names) {
      if (known.has(name) || name === this.session.id) continue;
      const full = path.join(dir, name);
      const st = await stat(full).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > maxAgeMs) await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async refreshWebStatus(): Promise<void> {
    const s = readSettings();
    if (!s.webEnabled) {
      this.webStatus = { enabled: false, verification: 'unverified' };
      return;
    }
    const info = await this.deps.web.engineInfo().catch((e: Error) => ({ status: 'error' as const, message: e.message }));
    if (info.status === 'ok') {
      if (!info.enabled) this.webStatus = { enabled: true, engine: info.engine, verification: 'disabled-on-server', detail: 'Web search is turned off in Open WebUI (Admin Panel → Settings → Web Search).' };
      else if (info.engine.toLowerCase() === 'searxng') this.webStatus = { enabled: true, engine: 'searxng', verification: 'verified' };
      else this.webStatus = { enabled: true, engine: info.engine, verification: 'other-engine', detail: `Open WebUI uses "${info.engine}" for web search, a third-party service. Use a self-hosted SearXNG to keep searches under your control.` };
      return;
    }
    if (info.status === 'missing') {
      this.webStatus = { enabled: true, verification: 'unavailable', detail: 'This Open WebUI version has no web search endpoints.' };
      return;
    }
    this.webStatus = {
      enabled: true,
      verification: 'unverified',
      detail:
        info.status === 'forbidden'
          ? 'The web search engine could not be read (this needs an admin API key that may use /api/v1/retrieval/config). Confirm the engine in the owuiAgent.web.confirmedEngine setting.'
          : `The web search configuration could not be read: ${info.message}`,
    };
  }

  private currentWebStatus(): WebStatusView {
    const s = readSettings();
    if (!s.webEnabled) return { enabled: false, verification: 'unverified' };
    if (this.webStatus.verification === 'unverified' && s.webConfirmedEngine.trim()) {
      const engine = s.webConfirmedEngine.trim().toLowerCase();
      return engine === 'searxng'
        ? { enabled: true, engine, verification: 'confirmed', detail: 'You confirmed in settings that Open WebUI uses SearXNG; the extension could not verify it.' }
        : { enabled: true, engine, verification: 'other-engine', detail: `You set the engine to "${engine}", a third-party service.` };
    }
    return { ...this.webStatus, enabled: true };
  }

  workspaceDirCreated(dir: string): void {
    void this.offerGitignore(dir);
  }

  private titleOverride: string | undefined;

  private currentRecord(): SessionRecord | undefined {
    if (!this.session.transcript.some((t) => t.kind === 'user')) return undefined;
    return this.session.toRecord(this.titleOverride ?? titleFrom(this.session.transcript), this.selectedModel()?.id, this.mode);
  }

  private markDirty(): void {
    if (!this.dirty) this.firstUnsavedChange = Date.now();
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.dirty) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const overdue = Date.now() - this.firstUnsavedChange > 10_000;
    this.saveTimer = setTimeout(() => void this.saveNow(), overdue ? 0 : 1500);
  }

  saveNow(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    if (!this.dirty) return this.saving;
    const live = this.currentRecord();
    if (!live || this.deletedSessions.has(live.id)) return this.saving;
    const record = structuredClone(live);
    this.dirty = false;
    this.saving = this.saving
      .then(() => (this.deletedSessions.has(record.id) ? undefined : this.deps.history.save(record)))
      .catch((e: unknown) => {
        log.error(`Could not save the session; retrying in 30 s: ${describeError(e)}`);
        this.dirty = true;
        this.saveTimer ??= setTimeout(() => void this.saveNow(), 30_000);
      });
    return this.saving;
  }

  async flush(): Promise<void> {
    await this.saveNow();
    await this.saving;
  }

  private async offerGitignore(owuiDir: string): Promise<void> {
    const key = 'owuiAgent.gitignoreOffer';
    if (this.deps.workspaceState.get<string>(key) === 'never') return;
    const root = path.dirname(owuiDir);
    const gitignore = path.join(root, '.gitignore');
    const existing = await readFile(gitignore, 'utf8').catch(() => '');
    if (/^\/?\.owui\/?\s*$/m.test(existing)) return;
    if (!existing && !existsSync(path.join(root, '.git'))) return;
    const choice = await vscode.window.showInformationMessage(
      'OWUI Agent created a .owui folder for project memory and skills. Add it to .gitignore? Keep it out if it is personal; commit it if your team should share the memory.',
      'Add to .gitignore',
      'Not now',
      'Never for this workspace',
    );
    if (choice === 'Never for this workspace') await this.deps.workspaceState.update(key, 'never');
    if (choice !== 'Add to .gitignore') return;
    await appendFile(gitignore, `${existing && !existing.endsWith('\n') ? '\n' : ''}.owui/\n`, 'utf8');
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
      ...(m.maxContext ? { maxContext: m.maxContext } : {}),
    }));
    const state: ViewState = {
      sessionId: this.session.id,
      connection: this.connection,
      models,
      busy: this.session.busy,
      mode: this.mode,
      transcript: this.session.transcript,
      todos: this.session.todos,
      sovereignty: sovereignty(selected),
      noticeAcknowledged: this.deps.globalState.get<boolean>(STATE_NOTICE, false),
      web: this.currentWebStatus(),
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
    void this.flush();
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
      systemPrompt: () =>
        renderSystemPrompt({
          os: `${os.type()} ${os.release()} (${process.platform})`,
          shell: `${shell.label} (${shell.id})`,
          shells: this.deps.shells.available().map((s) => `${s.label} (${s.id})`).join(', '),
          date: new Date().toISOString().slice(0, 10),
          workspace: folder ? folder.uri.fsPath : '(no folder open; work in the scratchpad)',
          scratchpad,
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
      loadContext: async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const roots: { dir: string; source: 'workspace' | 'user' }[] = [];
        if (root) roots.push({ dir: path.join(root, OWUI_DIR, 'skills'), source: 'workspace' });
        roots.push({ dir: this.deps.userSkillsDir(), source: 'user' });
        const [sections, skills] = await Promise.all([loadProjectContext(root), discoverSkills(roots)]);
        return { sections, skills };
      },
      onWorkspaceDirCreated: (dir) => this.workspaceDirCreated(dir),
      toolEnabled: (name) => {
        const s = readSettings();
        if (WEB_TOOLS.has(name)) return s.webEnabled;
        if (BROWSER_TOOLS.has(name)) return s.browserEnabled;
        return true;
      },
      extraPromptSections: () => (readSettings().webEnabled ? [webPrompt.replace(/^<!--[^\n]*-->\s*\n/, '').trim()] : []),
      autoApproveSearches: () => readSettings().webAutoApproveSearches,
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

  private newAgentSession(record?: SessionRecord): AgentSession {
    const id = record?.id ?? randomUUID();
    let browser: BrowserSession | undefined;
    const scratchpad = record?.scratchpad ?? path.join(scratchRoot(this.deps.globalStorage), `${new Date().toISOString().slice(0, 10)}-${id.slice(0, 8)}`);
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
        checkpoints: new CheckpointManager(this.backupDir(id)),
        diffs: this.diffs,
        web: this.deps.web,
        browser: () => {
          if (!browser) {
            const s = readSettings();
            browser = new BrowserSession({
              profileDir: path.join(this.deps.globalStorage, 'browser-profiles', id),
              channel: s.browserChannel,
              allowExternal: s.browserAllowExternal,
              extraHosts: s.browserExtraHosts,
            });
          }
          return browser;
        },
        closeBrowser: async () => {
          await browser?.close();
          browser = undefined;
        },
      },
      {
        changed: () => {
          if (this.session === session) this.markDirty();
          this.emitState();
        },
        delta: (itemId, d) => {
          if (this.session === session) this.markDirty();
          this.listener?.delta(itemId, d);
        },
        toolUpdate: (itemId, patch) => {
          if (this.session === session) this.markDirty();
          this.listener?.toolUpdate(itemId, patch);
        },
        usage: (model, usage) => this.recordTotals(model, usage),
      },
      id,
    );
    if (record) session.restore(record);
    return session;
  }

  private backupDir(id: string): string {
    return path.join(this.deps.backupsRoot, id);
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
