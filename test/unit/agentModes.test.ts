import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WireMessage } from '../../src/owui/types';
import { createHarness, tools, type Harness, type HarnessOptions } from '../helpers/agent';
import { MockOwui, sseChunks } from '../mock-owui/server';

const KEY = 'sk-modes';
const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
let mock: MockOwui;
let h: Harness | undefined;

beforeEach(async () => {
  mock = new MockOwui({ apiKey: KEY });
  await mock.start();
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await mock.stop();
});

async function harness(opts: Partial<HarnessOptions> = {}): Promise<Harness> {
  h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, ...opts });
  return h;
}

function body(i: number): { messages: WireMessage[]; tools?: { function: { name: string } }[] } {
  return mock.chatRequests()[i]!.body as never;
}

const toolNames = (i: number) => (body(i).tools ?? []).map((d) => d.function.name);
const say = (content: string) => ({ kind: 'sse' as const, chunks: sseChunks({ content }) });
const call = (content: string, ...calls: { name: string; arguments: object }[]) => ({ kind: 'sse' as const, chunks: sseChunks({ content, toolCalls: calls }) });
const read = (t: Harness, f: string) => readFile(path.join(t.workspace, f), 'utf8');

describe('plan mode', () => {
  it('offers the same tools as other modes but refuses edits, and announces the mode in the user message', async () => {
    const t = await harness({ mode: 'plan' });
    mock.enqueue(call('Trying to write.', { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }), say('Plan:\n1. Use Postgres'));
    await t.session.send('plan a todo app', t.ctx);
    expect(toolNames(0)).toEqual(expect.arrayContaining(['read_file', 'grep', 'ask_user', 'todo_write', 'write_file', 'run_command']));
    expect(toolNames(0)).not.toContain('exit_plan_mode');
    expect(String(body(0).messages[0]!.content)).not.toContain('read-only');
    expect(String(body(0).messages.at(-1)!.content)).toMatch(/^\[Permission mode: plan \(read-only\)/);
    expect(String(body(1).messages.at(-1)!.content)).toMatch(/not available in plan mode/);
    await expect(read(t, 'x.txt')).rejects.toThrow();
  });

  it('keeps the system prompt and tools byte-identical across turns, mode changes and task-list updates', async () => {
    const t = await harness({ mode: 'plan' });
    mock.enqueue(call('', { name: 'todo_write', arguments: { todos: [{ content: 'Write x', status: 'in_progress' }] } }), say('Plan: write x.txt'));
    await t.session.send('plan it', t.ctx);
    t.setMode('auto');
    mock.enqueue(call('Implementing.', { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }), say('Done.'));
    await t.session.send('go ahead', t.ctx);
    const requests = mock.chatRequests().length;
    expect(requests).toBe(4);
    for (let i = 1; i < requests; i++) {
      expect(body(i).messages[0], `system message of request ${i}`).toEqual(body(0).messages[0]);
      expect(body(i).tools, `tools of request ${i}`).toEqual(body(0).tools);
    }
    expect(String(body(1).messages.at(-1)!.content)).toContain('- [~] Write x');
    const goAhead = body(2).messages.find((m) => m.role === 'user' && String(m.content).includes('go ahead'));
    expect(String(goAhead?.content)).toMatch(/^\[Permission mode: auto-accept edits/);
    expect(body(3).messages.filter((m) => m.role === 'user' && String(m.content).startsWith('[Permission mode:'))).toHaveLength(2);
    expect(t.approvalsSeen).toEqual([]);
    expect(await read(t, 'x.txt')).toBe('x');
  });
});

describe('review at end', () => {
  it('applies edits immediately, then lets the user keep or revert each file', async () => {
    const t = await harness({ mode: 'review' });
    await writeFile(path.join(t.workspace, 'keep.txt'), 'old keep');
    await writeFile(path.join(t.workspace, 'revert.txt'), 'old revert');
    mock.enqueue(
      call(
        '',
        { name: 'write_file', arguments: { path: 'keep.txt', content: 'new keep' } },
        { name: 'write_file', arguments: { path: 'revert.txt', content: 'new revert' } },
        { name: 'write_file', arguments: { path: 'added.txt', content: 'added' } },
      ),
      say('Finished.'),
    );
    await t.session.send('change files', t.ctx);
    expect(t.approvalsSeen).toEqual([]);
    const review = t.session.transcript.find((x) => x.kind === 'review');
    expect(review?.kind === 'review' && review.files.map((f) => [f.display, f.action, !!f.diffId])).toEqual([
      ['keep.txt', 'modified', true],
      ['revert.txt', 'modified', true],
      ['added.txt', 'added', true],
    ]);
    await t.session.reviewDecision(review!.id, path.join(t.workspace, 'keep.txt'), 'keep');
    await t.session.reviewDecision(review!.id, path.join(t.workspace, 'revert.txt'), 'revert');
    await t.session.reviewDecision(review!.id, undefined, 'revert');
    expect(await read(t, 'keep.txt')).toBe('new keep');
    expect(await read(t, 'revert.txt')).toBe('old revert');
    await expect(read(t, 'added.txt')).rejects.toThrow();
    expect(review).toMatchObject({ status: 'done' });
    expect(String(t.session.wireMessages().at(-2)!.content)).toMatch(/reverted these files.*revert\.txt, added\.txt/);
  });

  it('does not show a review in other modes', async () => {
    const t = await harness({ mode: 'auto' });
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'a.txt', content: 'a' } }), say('ok'));
    await t.session.send('write', t.ctx);
    expect(t.session.transcript.some((x) => x.kind === 'review')).toBe(false);
  });
});

describe('diffs and rewind', () => {
  it('stores before/after content for every edit card', async () => {
    const t = await harness({ mode: 'auto' });
    await writeFile(path.join(t.workspace, 'd.txt'), 'before\n');
    mock.enqueue(call('', { name: 'edit_file', arguments: { path: 'd.txt', old_string: 'before', new_string: 'after' } }), say('ok'));
    await t.session.send('edit', t.ctx);
    const card = tools(t.session)[0]!;
    expect(t.diffs.get(card.diffId!)).toMatchObject({ before: 'before\n', after: 'after\n', display: 'd.txt' });
  });

  it("rewinds the agent's edits and the conversation to before a message, but not command side effects", async () => {
    const t = await harness({ mode: 'auto' });
    await writeFile(path.join(t.workspace, 'r.txt'), 'v1');
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'r.txt', content: 'v2' } }), say('first done'));
    await t.session.send('first', t.ctx);
    const gen = `${node} -e "require('fs').writeFileSync('gen.txt', 'g')"`;
    mock.enqueue(
      call('', { name: 'write_file', arguments: { path: 'r.txt', content: 'v3' } }, { name: 'run_command', arguments: { command: gen, description: 'Generate a file' } }),
      say('second done'),
    );
    await t.session.send('second', t.ctx);
    expect(await read(t, 'r.txt')).toBe('v3');
    const second = t.session.transcript.filter((x) => x.kind === 'user')[1]!;
    const preview = await t.session.rewindPreview(second.id);
    expect(preview?.map((c) => path.basename(c.absolute))).toEqual(['r.txt']);
    const res = await t.session.rewind(second.id, 'both');
    expect(res?.text).toBe('second');
    expect(await read(t, 'r.txt')).toBe('v2');
    expect(await read(t, 'gen.txt')).toBe('g');
    expect(t.session.transcript.filter((x) => x.kind === 'user').map((x) => (x as { text: string }).text)).toEqual(['first']);
    expect(t.session.wireMessages().at(-1)).toMatchObject({ role: 'assistant', content: 'first done' });
  });

  it('rewinds code only and tells the model', async () => {
    const t = await harness({ mode: 'auto' });
    await writeFile(path.join(t.workspace, 'c.txt'), 'orig');
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'c.txt', content: 'changed' } }), say('done'));
    await t.session.send('change it', t.ctx);
    const user = t.session.transcript.find((x) => x.kind === 'user')!;
    await t.session.rewind(user.id, 'code');
    expect(await read(t, 'c.txt')).toBe('orig');
    expect(String(t.session.wireMessages().at(-2)!.content)).toMatch(/rewound the workspace files/);
    expect(t.session.transcript.some((x) => x.kind === 'warning' && /Restored the code/.test(x.text))).toBe(true);
  });
});

describe('stop right after sending', () => {
  it('stops cleanly before any model request is made', async () => {
    const t = await harness({ mode: 'auto' });
    const p = t.session.send('hello', t.ctx);
    t.session.stop();
    await p;
    expect(mock.chatRequests()).toHaveLength(0);
    expect(t.session.busy).toBe(false);
    expect(t.session.canResume()).toBe(true);
  });
});
