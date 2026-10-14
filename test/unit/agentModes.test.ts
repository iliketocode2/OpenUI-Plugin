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
  it('offers only read-only tools plus exit_plan_mode and refuses edits', async () => {
    const t = await harness({ mode: 'plan', plan: () => ({ approved: false, feedback: 'Use SQLite instead' }) });
    mock.enqueue(
      call('Trying to write.', { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }),
      call('Here is my plan.', { name: 'exit_plan_mode', arguments: { plan: '# Plan\n1. Use Postgres' } }),
      say('I will revise the plan.'),
    );
    await t.session.send('plan a todo app', t.ctx);
    expect(toolNames(0)).toEqual(expect.arrayContaining(['exit_plan_mode', 'read_file', 'grep', 'ask_user', 'todo_write']));
    expect(toolNames(0)).not.toContain('write_file');
    expect(toolNames(0)).not.toContain('run_command');
    expect(String(body(0).messages[0]!.content)).toContain('PLAN MODE');
    expect(String(body(1).messages.at(-1)!.content)).toMatch(/not available in plan mode/);
    expect(String(body(2).messages.at(-1)!.content)).toMatch(/wants changes to the plan: Use SQLite instead/);
    expect(t.session.transcript.find((x) => x.kind === 'plan')).toMatchObject({ status: 'revise', feedback: 'Use SQLite instead' });
    expect(t.modeHistory).toEqual([]);
  });

  it('switches to the chosen mode on approval and continues with editing tools', async () => {
    const t = await harness({ mode: 'plan', plan: () => ({ approved: true, mode: 'auto' }) });
    mock.enqueue(
      call('', { name: 'exit_plan_mode', arguments: { plan: '# Plan\nWrite x.txt' } }),
      call('Implementing.', { name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }),
      say('Done.'),
    );
    await t.session.send('plan then build', t.ctx);
    expect(t.modeHistory).toEqual(['auto']);
    expect(String(body(1).messages.at(-1)!.content)).toMatch(/approved the plan/);
    expect(toolNames(1)).toContain('write_file');
    expect(toolNames(1)).not.toContain('exit_plan_mode');
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

  it('rewinds code and conversation to before a message, including command output', async () => {
    const t = await harness({ mode: 'auto', allowlist: ['*'] });
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
    expect(await read(t, 'gen.txt')).toBe('g');
    const second = t.session.transcript.filter((x) => x.kind === 'user')[1]!;
    const preview = await t.session.rewindPreview(second.id);
    expect(preview?.method).toBe('git');
    expect(preview?.changes.map((c) => path.basename(c.absolute)).sort()).toEqual(['gen.txt', 'r.txt']);
    const res = await t.session.rewind(second.id, 'both');
    expect(res?.text).toBe('second');
    expect(await read(t, 'r.txt')).toBe('v2');
    await expect(read(t, 'gen.txt')).rejects.toThrow();
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

  it('rewinds agent edits from backups when checkpoints are disabled', async () => {
    const t = await harness({ mode: 'auto', checkpoints: false });
    await writeFile(path.join(t.workspace, 'b.txt'), 'orig');
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'b.txt', content: 'changed' } }), say('done'));
    await t.session.send('change it', t.ctx);
    expect(t.warnings.join(' ')).toMatch(/snapshots are unavailable/i);
    const user = t.session.transcript.find((x) => x.kind === 'user')!;
    expect((await t.session.rewindPreview(user.id))?.method).toBe('backups');
    await t.session.rewind(user.id, 'both');
    expect(await read(t, 'b.txt')).toBe('orig');
  });
});

describe('stop during the pre-request snapshot', () => {
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
