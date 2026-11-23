import { describe, expect, it } from 'vitest';
import type { ControllerListener } from '../../src/agent/controller';
import type { FromWebview, ToWebview } from '../../src/shared/protocol';
import { ChatViewProvider } from '../../src/ui/chatViewProvider';
import { EventEmitter } from './vscode-stub';

/** A webview view whose page can be hidden and reloaded the way VS Code does it without retainContextWhenHidden. */
function fakeView() {
  const received = new EventEmitter<FromWebview>();
  const visibility = new EventEmitter<void>();
  const disposed = new EventEmitter<void>();
  const posted: ToWebview[] = [];
  const view = {
    visible: true,
    show: () => {
      view.visible = true;
      visibility.fire();
    },
    onDidChangeVisibility: visibility.event,
    onDidDispose: disposed.event,
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: unknown) => u,
      postMessage: async (m: ToWebview) => {
        posted.push(m);
        return true;
      },
      onDidReceiveMessage: received.event,
    },
  };
  return {
    view,
    posted,
    /** The page finished loading and says it is listening. */
    pageReady: () => received.fire({ type: 'ready' }),
    hide: () => {
      view.visible = false;
      visibility.fire();
    },
  };
}

function setup() {
  let listener: ControllerListener | undefined;
  const controller = {
    setListener: (l: ControllerListener | undefined) => (listener = l),
    emitState: () => undefined,
    ensureConnected: async () => undefined,
    listHistory: async () => listener?.history([], ''),
  };
  const provider = new ChatViewProvider({ path: '/ext' } as never, controller as never, { setApiKey: async () => undefined, openSettings: async () => undefined });
  const v = fakeView();
  provider.resolveWebviewView(v.view as never);
  return { provider, ...v };
}

const ofType = (posted: ToWebview[], type: ToWebview['type']) => posted.filter((m) => m.type === type);

describe('ChatViewProvider', () => {
  it('sends inserted text straight away while the page is listening', async () => {
    const t = setup();
    t.pageReady();
    await t.provider.insertText('@src/a.ts ');
    expect(ofType(t.posted, 'insertText')).toEqual([{ type: 'insertText', text: '@src/a.ts ' }]);
  });

  it('keeps text inserted while the view was hidden until its page has reloaded', async () => {
    const t = setup();
    t.pageReady();
    t.hide();
    await t.provider.insertText('@src/a.ts ');
    expect(t.view.visible).toBe(true);
    expect(ofType(t.posted, 'insertText')).toEqual([]);
    t.pageReady();
    expect(ofType(t.posted, 'insertText')).toEqual([{ type: 'insertText', text: '@src/a.ts ' }]);
    t.pageReady();
    expect(ofType(t.posted, 'insertText')).toHaveLength(1);
  });

  it('opens the history panel and delivers its entries after a reload', async () => {
    const t = setup();
    await t.provider.showHistory();
    expect(ofType(t.posted, 'showHistory')).toEqual([]);
    t.pageReady();
    expect(ofType(t.posted, 'showHistory')).toHaveLength(1);
    expect(ofType(t.posted, 'history')).toHaveLength(1);
  });
});
