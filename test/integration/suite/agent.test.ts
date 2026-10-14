import * as assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../../src/extension';
import type { TranscriptItem } from '../../../src/shared/protocol';
import { locateRipgrep } from '../../../src/workspace/ripgrep';
import { MockOwui, sseChunks } from '../../mock-owui/server';

const KEY = 'sk-agent-int';
let mock: MockOwui;
let api: TestApi;
let approver: ReturnType<typeof setInterval> | undefined;
const decided = new Set<string>();

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

function autoApprove(decide: (item: ToolItem) => 'allow' | 'deny' = () => 'allow'): void {
  approver = setInterval(() => {
    for (const item of api.controller.viewState().transcript) {
      if (item.kind === 'tool' && item.status === 'awaiting-approval' && !decided.has(item.id)) {
        decided.add(item.id);
        api.controller.approve(item.id, { decision: decide(item) });
      }
    }
  }, 20);
}

const node = 'node';
const call = (content: string, ...calls: { name: string; arguments: object }[]) => ({ kind: 'sse' as const, chunks: sseChunks({ content, toolCalls: calls }) });

describe('OWUI Agent tools and agent loop (integration)', () => {
  before(async () => {
    mock = new MockOwui({ apiKey: KEY, models: { data: [{ id: 'mock-model', name: 'Mock Model', info: { params: { num_ctx: 32768 } } }] } });
    await mock.start();
    const ext = vscode.extensions.getExtension<TestApi>('local.owui-agent')!;
    api = (await ext.activate())!;
    const c = vscode.workspace.getConfiguration('owuiAgent');
    await c.update('baseUrl', mock.baseUrl, vscode.ConfigurationTarget.Global);
    await c.update('models', {}, vscode.ConfigurationTarget.Global);
    await api.keys.set(KEY);
    await api.controller.refresh();
    await api.controller.setMode('ask');
  });

  after(async () => {
    if (approver) clearInterval(approver);
    await mock?.stop();
  });

  beforeEach(() => {
    api.controller.newSession();
    mock.requests.length = 0;
  });

  afterEach(() => {
    if (approver) clearInterval(approver);
    approver = undefined;
  });

  it('finds ripgrep inside the running VS Code', () => {
    assert.ok(locateRipgrep(vscode.env.appRoot), `no ripgrep under ${vscode.env.appRoot}`);
  });

  it('writes a test, runs it, sees it fail, fixes the code and re-runs', async () => {
    autoApprove();
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    mock.enqueue(
      call('Planning.', { name: 'todo_write', arguments: { todos: [{ content: 'Write sum', status: 'in_progress' }, { content: 'Test', status: 'pending' }] } }),
      call('Writing the module and a test.', { name: 'write_file', arguments: { path: 'lib/sum.js', content: 'module.exports = (a, b) => a - b;\n' } }),
      call('', { name: 'write_file', arguments: { path: 'lib/sum.test.js', content: "const sum = require('./sum');\nif (sum(2, 3) !== 5) { console.error('FAIL: expected 5, got ' + sum(2, 3)); process.exit(1); }\nconsole.log('PASS');\n" } }),
      call('Running the test.', { name: 'run_command', arguments: { command: `${node} lib/sum.test.js`, description: 'Run the sum test' } }),
      call('The test failed: I wrote subtraction by mistake. Fixing it.', { name: 'edit_file', arguments: { path: 'lib/sum.js', old_string: 'a - b', new_string: 'a + b' } }),
      call('Re-running.', { name: 'run_command', arguments: { command: `${node} lib/sum.test.js`, description: 'Re-run the sum test' } }),
      { kind: 'sse', chunks: sseChunks({ content: 'Built lib/sum.js. Tested: lib/sum.test.js passes. Not tested: nothing else. Shall I commit?' }) },
    );
    await api.controller.send('Create a sum function with a test');
    const state = api.controller.viewState();
    const cards = state.transcript.filter((t): t is ToolItem => t.kind === 'tool');
    assert.deepEqual(
      cards.map((c) => [c.tool, c.status]),
      [
        ['todo_write', 'done'],
        ['write_file', 'done'],
        ['write_file', 'done'],
        ['run_command', 'error'],
        ['edit_file', 'done'],
        ['run_command', 'done'],
      ],
    );
    assert.match(cards[1]!.title, /^Write lib\/sum\.js — 1 line$/);
    assert.match(cards[4]!.title, /^Edit lib\/sum\.js — Added 1 line, removed 1 line$/);
    assert.match(cards[3]!.output ?? '', /FAIL: expected 5, got -1/);
    assert.match(cards[5]!.output ?? '', /PASS/);
    assert.equal(cards[5]!.input, `${node} lib/sum.test.js`);
    assert.equal(cards[5]!.description, 'Re-run the sum test');
    assert.equal(await readFile(path.join(ws, 'lib', 'sum.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
    assert.deepEqual(state.todos.map((t) => t.content), ['Write sum', 'Test']);
    assert.equal(state.busy, false);
  });

  it('honours a denial and keeps the workspace unchanged', async () => {
    autoApprove(() => 'deny');
    const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'denied.txt', content: 'nope' } }));
    await api.controller.send('write something');
    await assert.rejects(readFile(path.join(ws, 'denied.txt')));
    const card = api.controller.viewState().transcript.find((t): t is ToolItem => t.kind === 'tool');
    assert.equal(card?.status, 'denied');
    assert.equal(mock.chatRequests().length, 1);
  });

  it('stops a long command from the Stop command', async () => {
    autoApprove();
    mock.enqueue(call('', { name: 'run_command', arguments: { command: `${node} -e "setInterval(() => {}, 1000)"`, description: 'Hang forever' } }));
    const done = api.controller.send('hang');
    const running = () => api.controller.viewState().transcript.some((t) => t.kind === 'tool' && t.status === 'running');
    for (let waited = 0; !running() && waited < 20_000; waited += 25) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 500));
    await vscode.commands.executeCommand('owuiAgent.stop');
    await done;
    const card = api.controller.viewState().transcript.find((t): t is ToolItem => t.kind === 'tool');
    assert.equal(card?.status, 'cancelled');
  });
});
