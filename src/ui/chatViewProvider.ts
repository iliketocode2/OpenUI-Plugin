import * as vscode from 'vscode';
import type { ChatController } from '../agent/controller';
import type { StreamDelta } from '../owui/streamAssembler';
import type { FromWebview, ToWebview } from '../shared/protocol';
import { createNonce, renderHtml } from './html';

const DELTA_FLUSH_MS = 40;

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'owuiAgent.chat';
  private view: vscode.WebviewView | undefined;
  private pending = new Map<string, { id: string; kind: StreamDelta['kind']; text: string }>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController,
    private readonly commands: { setApiKey(): Promise<void>; openSettings(): Promise<void> },
  ) {
    controller.setListener({
      state: (state) => {
        this.flushDeltas();
        this.post({ type: 'state', state: structuredClone(state) });
      },
      delta: (id, d) => this.queueDelta(id, d),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, enableCommandUris: false, localResourceRoots: [root] };
    view.webview.html = renderHtml({
      cspSource: view.webview.cspSource,
      nonce: createNonce(),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'main.js')).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'styles.css')).toString(),
    });
    this.disposables.push(
      view.webview.onDidReceiveMessage((m: FromWebview) => void this.onMessage(m)),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );
  }

  focusInput(): void {
    this.post({ type: 'focusInput' });
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.controller.emitState();
        void this.controller.refresh();
        return;
      case 'send':
        await this.controller.send(m.text);
        return;
      case 'stop':
        this.controller.stop();
        return;
      case 'retry':
        await this.controller.retry();
        return;
      case 'selectModel':
        await this.controller.selectModel(m.id);
        return;
      case 'setModelLocal':
        await this.controller.setModelLocal(m.id, m.local);
        return;
      case 'newSession':
        this.controller.newSession();
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
      case 'openLink':
        await openLinkWithConsent(m.href);
        return;
    }
  }

  private queueDelta(id: string, d: StreamDelta): void {
    const key = `${id}:${d.kind}`;
    const cur = this.pending.get(key);
    if (cur) cur.text += d.text;
    else this.pending.set(key, { id, kind: d.kind, text: d.text });
    this.flushTimer ??= setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS);
  }

  private flushDeltas(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    for (const p of this.pending.values()) this.post({ type: 'delta', id: p.id, kind: p.kind, text: p.text });
    this.pending.clear();
  }

  private post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  dispose(): void {
    this.controller.setListener(undefined);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const d of this.disposables) d.dispose();
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
