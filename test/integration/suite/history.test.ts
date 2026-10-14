import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { HistoryEntry } from '../../../src/shared/protocol';
import { MockOwui, sseChunks } from '../../mock-owui/server';

const KEY = 'sk-history-int';
let mock: MockOwui;
let api: TestApi;
let lastHistory: HistoryEntry[] = [];

async function history(query = ''): Promise<HistoryEntry[]> {
  await api.controller.flush();
  await api.controller.listHistory(query);
  return lastHistory;
}

describe('OWUI Agent history (integration)', () => {
  before(async () => {
    mock = new MockOwui({ apiKey: KEY, models: { data: [{ id: 'history-model', name: 'History Model', info: { params: { num_ctx: 32768 } } }] } });
    await mock.start();
    api = (await vscode.extensions.getExtension<TestApi>('local.owui-agent')!.activate())!;
    const c = vscode.workspace.getConfiguration('owuiAgent');
    await c.update('baseUrl', mock.baseUrl, vscode.ConfigurationTarget.Global);
    await c.update('models', {}, vscode.ConfigurationTarget.Global);
    await api.keys.set(KEY);
    await api.controller.refresh();
    await api.controller.setMode('ask');
    const original = api.provider['post'].bind(api.provider) as (m: { type: string; entries?: HistoryEntry[] }) => void;
    (api.provider as unknown as { post: (m: { type: string; entries?: HistoryEntry[] }) => void }).post = (m) => {
      if (m.type === 'history' && m.entries) lastHistory = m.entries;
      original(m);
    };
  });

  after(async () => {
    await mock?.stop();
  });

  it('saves sessions, searches them, resumes without reordering and keeps titles separate', async () => {
    api.controller.newSession();
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'Answer about Slack webhooks' }) });
    await api.controller.send('How do Slack webhooks work?');
    const first = api.controller.viewState().sessionId;
    api.setConfirm(async () => true);

    api.controller.newSession();
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'Answer about Postgres' }) });
    await api.controller.send('Set up Postgres');
    const second = api.controller.viewState().sessionId;

    let list = await history();
    assert.deepEqual(list.slice(0, 2).map((e) => e.id), [second, first]);
    assert.equal(list.find((e) => e.id === first)?.title, 'How do Slack webhooks work?');

    const hits = await history('webhooks');
    assert.deepEqual(hits.map((e) => e.id), [first]);
    assert.match(hits[0]!.match ?? '', /webhooks/i);

    await api.controller.resumeSession(first);
    assert.equal(api.controller.viewState().sessionId, first);
    assert.equal(api.controller.viewState().transcript.filter((t) => t.kind === 'user').length, 1);
    await new Promise((r) => setTimeout(r, 1800));
    list = await history();
    assert.deepEqual(list.slice(0, 2).map((e) => e.id), [second, first], 'opening a session must not move it to the top');

    api.controller.newSession();
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'third' }) });
    await api.controller.send('A third topic');
    list = await history();
    assert.equal(list[0]?.title, 'A third topic');

    await api.controller.deleteSession(second);
    list = await history();
    assert.ok(!list.some((e) => e.id === second));
  });

  it('deleting the current session does not bring it back', async () => {
    api.controller.newSession();
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'temporary' }) });
    await api.controller.send('Temporary session');
    const id = api.controller.viewState().sessionId;
    await api.controller.flush();
    await api.controller.deleteSession(id);
    await new Promise((r) => setTimeout(r, 1800));
    assert.ok(!(await history()).some((e) => e.id === id));
    assert.notEqual(api.controller.viewState().sessionId, id);
  });
});
