import * as assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { TranscriptItem } from '../../../src/shared/protocol';
import { DIFF_SCHEME } from '../../../src/ui/diffView';
import { MockOwui, sseChunks } from '../../mock-owui/server';

const KEY = 'sk-modes-int';
let mock: MockOwui;
let api: TestApi;
let ws: string;
let poller: ReturnType<typeof setInterval> | undefined;

type Item<K extends TranscriptItem['kind']> = Extract<TranscriptItem, { kind: K }>;

function items<K extends TranscriptItem['kind']>(kind: K): Item<K>[] {
  return api.controller.viewState().transcript.filter((t): t is Item<K> => t.kind === kind);
}

const call = (content: string, ...calls: { name: string; arguments: object }[]) => ({ kind: 'sse' as const, chunks: sseChunks({ content, toolCalls: calls }) });
const say = (content: string) => ({ kind: 'sse' as const, chunks: sseChunks({ content }) });

describe('OWUI Agent plan mode, diffs and rewind (integration)', () => {
  before(async () => {
    mock = new MockOwui({ apiKey: KEY, models: { data: [{ id: 'modes-model', name: 'Modes Model', info: { params: { num_ctx: 32768 } } }] } });
    await mock.start();
    api = (await vscode.extensions.getExtension<TestApi>('local.owui-agent')!.activate())!;
    const c = vscode.workspace.getConfiguration('owuiAgent');
    await c.update('baseUrl', mock.baseUrl, vscode.ConfigurationTarget.Global);
    await c.update('models', {}, vscode.ConfigurationTarget.Global);
    await api.keys.set(KEY);
    await api.controller.refresh();
    ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  });

  after(async () => {
    if (poller) clearInterval(poller);
    await api.controller.setMode('ask');
    await api?.keys.clear();
    await mock?.stop();
  });

  beforeEach(() => {
    api.controller.newSession();
    mock.requests.length = 0;
  });

  afterEach(() => {
    if (poller) clearInterval(poller);
    poller = undefined;
  });

  it('plans read-only, then implements after the user switches mode, with an unchanged prompt and tool list', async () => {
    await api.controller.setMode('plan');
    mock.enqueue(
      call('Looking around.', { name: 'read_file', arguments: { path: '.' } }),
      call('Trying early.', { name: 'write_file', arguments: { path: 'planned.txt', content: 'too early\n' } }),
      say('Plan:\n1. Create `planned.txt`'),
    );
    await api.controller.send('Plan how to create planned.txt');
    await assert.rejects(readFile(path.join(ws, 'planned.txt'), 'utf8'));
    await api.controller.setMode('auto');
    mock.enqueue(call('Implementing.', { name: 'write_file', arguments: { path: 'planned.txt', content: 'from the plan\n' } }), say('Done. Tested: nothing to test.'));
    const finished = await Promise.race([api.controller.send('Go ahead').then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 40_000))]);
    assert.ok(
      finished,
      `send did not finish: mode=${api.controller.mode} toolOutputs=${JSON.stringify(items('tool').map((t) => t.output ?? ''))} busy=${api.controller.viewState().busy} key=${!!(await api.keys.get())} requests=${mock.chatRequests().length} pending=${mock.pending()} ${JSON.stringify(
        api.controller.viewState().transcript.map((t) => [t.kind, 'text' in t ? t.text.slice(0, 160) : 'title' in t ? `${t.title} ${t.status}` : 'status' in t ? t.status : '']),
      )}`,
    );
    assert.equal(await readFile(path.join(ws, 'planned.txt'), 'utf8'), 'from the plan\n');
    const bodies = mock.chatRequests().map((r) => r.body as { messages: { content: unknown }[]; tools: unknown[] });
    assert.equal(bodies.length, 5);
    assert.match(String(bodies[2]!.messages.at(-1)?.content ?? ''), /not available in plan mode/);
    for (const b of bodies) {
      assert.deepEqual(b.messages[0], bodies[0]!.messages[0]);
      assert.deepEqual(b.tools, bodies[0]!.tools);
    }
  });

  it('opens the native diff editor for an edit', async () => {
    await api.controller.setMode('auto');
    await writeFile(path.join(ws, 'diffme.txt'), 'alpha\n');
    mock.enqueue(call('', { name: 'edit_file', arguments: { path: 'diffme.txt', old_string: 'alpha', new_string: 'beta' } }), say('ok'));
    await api.controller.send('edit diffme');
    const card = items('tool')[0]!;
    assert.ok(card?.diffId, JSON.stringify(api.controller.viewState().transcript.map((t) => [t.kind, 'text' in t ? t.text.slice(0, 160) : 'title' in t ? `${t.title} ${t.status} ${t.output ?? ''}`.slice(0, 300) : ''])));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await api.provider['onMessage']({ type: 'openDiff', diffId: card.diffId });
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'expected a diff editor');
    const input = tab.input as vscode.TabInputTextDiff;
    assert.equal(input.original.scheme, DIFF_SCHEME);
    assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), 'alpha\n');
    assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), 'beta\n');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('rewinds code and conversation after confirmation', async () => {
    await api.controller.setMode('auto');
    await writeFile(path.join(ws, 'rewind.txt'), 'original\n');
    let confirmed: string | undefined;
    api.setConfirm(async (message, detail) => {
      confirmed = `${message}\n${detail}`;
      return true;
    });
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'rewind.txt', content: 'changed by agent\n' } }), say('changed'));
    await api.controller.send('change rewind.txt');
    assert.equal(await readFile(path.join(ws, 'rewind.txt'), 'utf8'), 'changed by agent\n');
    const user = items('user')[0]!;
    assert.ok(user.checkpoint);
    const text = await api.controller.rewind(user.id, 'both');
    assert.equal(text, 'change rewind.txt');
    assert.match(confirmed ?? '', /Restore rewind\.txt/);
    assert.equal(await readFile(path.join(ws, 'rewind.txt'), 'utf8'), 'original\n');
    assert.equal(items('user').length, 0);
  });

  it('cancelling the confirmation leaves files untouched', async () => {
    await api.controller.setMode('auto');
    api.setConfirm(async () => false);
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'kept.txt', content: 'stays\n' } }), say('done'));
    await api.controller.send('write kept.txt');
    await api.controller.rewind(items('user')[0]!.id, 'code');
    assert.equal(await readFile(path.join(ws, 'kept.txt'), 'utf8'), 'stays\n');
  });
});
