import * as vscode from 'vscode';
import type { AgentController } from '../agent/controller';
import type { StreamDelta } from '../owui/streamAssembler';
import type { FromWebview, ToWebview, ToolCardUpdate } from '../shared/protocol';
import { openDiff } from './diffView';
import { createNonce, renderHtml } from './html';

const FLUSH_MS = 40;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'owuiAgent.chat';
  private view: vscode.WebviewView | undefined;
  private readonly pendingDeltas = new Map<string, { id: string; kind: StreamDelta['kind']; text: string }>();
  private readonly pendingTools = new Map<string, ToolCardUpdate>();
  /** Whether the page has said it is listening. VS Code discards a hidden view's page and loads it again when the view
   * is shown, so this goes false whenever the view hides. */
  private ready = false;
  /** Messages for the page that arrived while it was not listening; sent on the next `ready`. */
  private readonly queued: ToWebview[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private viewDisposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: AgentController,
    private readonly commands: { setApiKey(): Promise<void>; openSettings(): Promise<void> },
  ) {
    controller.setListener({
      state: (state) => {
        this.flush();
        this.post({ type: 'state', state: structuredClone(state) });
      },
      delta: (id, d) => {
        const key = `${id}:${d.kind}`;
        const cur = this.pendingDeltas.get(key);
        if (cur) cur.text += d.text;
        else this.pendingDeltas.set(key, { id, kind: d.kind, text: d.text });
        this.schedule();
      },
      toolUpdate: (id, patch) => {
        this.pendingTools.set(id, { ...this.pendingTools.get(id), ...patch });
        this.schedule();
      },
      history: (entries, query) => this.postWhenReady({ type: 'history', entries, query }),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [root] };
    view.webview.html = renderHtml({
      cspSource: view.webview.cspSource,
      nonce: createNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'styles.css')).toString(),
    });
    for (const d of this.viewDisposables) d.dispose();
    this.viewDisposables = [
      view.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => {
        if (!view.visible) this.ready = false;
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.ready = false;
        for (const d of this.viewDisposables) d.dispose();
        this.viewDisposables = [];
      }),
    ];
  }

  async showHistory(): Promise<void> {
    this.postWhenReady({ type: 'showHistory' });
    await this.reveal();
    await this.controller.listHistory();
  }

  async insertText(text: string): Promise<void> {
    this.postWhenReady({ type: 'insertText', text });
    await this.reveal();
  }

  private async reveal(): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** For messages that must reach the page, such as text to insert: they wait while the page is (re)loading. */
  private postWhenReady(msg: ToWebview): void {
    if (this.view && this.ready) this.post(msg);
    else this.queued.push(msg);
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.controller.emitState();
        for (const msg of this.queued.splice(0)) this.post(msg);
        void this.controller.ensureConnected();
        return;
      case 'send':
        await this.controller.send(m.text);
        return;
      case 'stop':
        this.controller.stop();
        return;
      case 'retry':
      case 'continue':
        await this.controller.resume();
        return;
      case 'approve':
        this.controller.approve(m.id, m.decision);
        return;
      case 'answer':
        this.controller.answer(m.id, m.answers);
        return;
      case 'selectModel':
        await this.controller.selectModel(m.id);
        return;
      case 'setModelLocal':
        await this.controller.setModelLocal(m.id, m.local);
        return;
      case 'setContextSize':
        await this.controller.setContextSize(m.id);
        return;
      case 'setModelThinking':
        await this.controller.setModelThinking(m.id, m.thinking);
        return;
      case 'setMode':
        await this.controller.setMode(m.mode);
        return;
      case 'setApiKey':
        await this.commands.setApiKey();
        return;
      case 'openSettings':
        await this.commands.openSettings();
        return;
      case 'refreshModels':
        await this.controller.refresh();
        return;
      case 'acknowledgeNotice':
        await this.controller.acknowledgeNotice();
        return;
      case 'openFile':
        await openFile(m.path);
        return;
      case 'listHistory':
        await this.controller.listHistory(m.query);
        return;
      case 'resumeSession':
        await this.controller.resumeSession(m.id);
        return;
      case 'renameSession':
        await this.controller.renameSession(m.id);
        return;
      case 'deleteSession':
        await this.controller.deleteSession(m.id);
        return;
      case 'exportSession':
        await this.controller.exportSession(m.id);
        return;
      case 'openDiff':
        await openDiff(this.controller.diffs, m.diffId);
        return;
      case 'review':
        await this.controller.review(m.id, m.absolute, m.decision);
        return;
      case 'rewind': {
        const text = await this.controller.rewind(m.itemId, m.scope);
        if (text) this.post({ type: 'insertText', text });
        return;
      }
      case 'openLink':
        await openLinkWithConsent(m.href);
        return;
    }
  }

  private schedule(): void {
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const p of this.pendingDeltas.values()) this.post({ type: 'delta', id: p.id, kind: p.kind, text: p.text });
    this.pendingDeltas.clear();
    for (const [id, patch] of this.pendingTools) this.post({ type: 'toolUpdate', id, patch });
    this.pendingTools.clear();
  }

  private post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  dispose(): void {
    this.controller.setListener(undefined);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.viewDisposables) d.dispose();
  }
}

async function openFile(p: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const uri = /^([a-zA-Z]:[\\/]|\/)/.test(p) ? vscode.Uri.file(p) : folder ? vscode.Uri.joinPath(folder.uri, p) : undefined;
  if (!uri) return;
  try {
    await vscode.window.showTextDocument(uri, { preview: true });
  } catch {
    void vscode.window.showWarningMessage(`Could not open ${p}.`);
  }
}

async function openLinkWithConsent(href: string): Promise<void> {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(href, true);
  } catch {
    return;
  }
  if (uri.scheme !== 'http' && uri.scheme !== 'https') return;
  const choice = await vscode.window.showWarningMessage(
    `Open ${uri.toString(true)} in your browser? This leaves VS Code and contacts that site.`,
    { modal: true },
    'Open',
  );
  if (choice === 'Open') await vscode.env.openExternal(uri);
}
