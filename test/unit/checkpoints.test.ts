import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointManager } from '../../src/checkpoints/checkpoints';

let base: string;
let ws: string;
let m: CheckpointManager;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'owui checkpoints '));
  ws = path.join(base, 'my project');
  await mkdir(ws, { recursive: true });
  m = new CheckpointManager(path.join(base, 'backups'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const file = (rel: string) => path.join(ws, rel);

/** Does what the write tools do: back up, write, record the result. */
async function agentWrite(rel: string, content: string): Promise<void> {
  await m.recordBeforeWrite(file(rel));
  await writeFile(file(rel), content);
  await m.recordAfterWrite(file(rel));
}

describe('CheckpointManager', () => {
  it('restores and deletes only the files the agent wrote, across several checkpoints', async () => {
    await writeFile(file('a.txt'), 'v1');
    const cp1 = m.begin('one');
    await agentWrite('a.txt', 'v2');
    await agentWrite('created.txt', 'c');
    m.begin('two');
    await agentWrite('a.txt', 'v3');
    await writeFile(file('untracked-by-agent.txt'), 'u');
    expect(m.agentChangesSince(cp1.id).map((c) => [path.basename(c.absolute), c.action]).sort()).toEqual([
      ['a.txt', 'restore'],
      ['created.txt', 'delete'],
    ]);
    const r = await m.rewind(cp1.id);
    expect(r).toMatchObject({ restored: [file('a.txt')], deleted: [file('created.txt')], skipped: [], failed: [] });
    expect(await readFile(file('a.txt'), 'utf8')).toBe('v1');
    expect(existsSync(file('created.txt'))).toBe(false);
    expect(existsSync(file('untracked-by-agent.txt'))).toBe(true);
    expect(m.list()).toHaveLength(0);
  });

  it('never deletes or overwrites a file it could not back up', async () => {
    await writeFile(file('big.bin'), '');
    await truncate(file('big.bin'), 21 * 1024 * 1024);
    const cp = m.begin('big');
    await agentWrite('big.bin', 'replaced');
    const plan = await m.plan(cp.id);
    expect(plan).toEqual([{ absolute: file('big.bin'), action: 'skip' }]);
    const r = await m.rewind(cp.id);
    expect(r.skipped).toEqual([file('big.bin')]);
    expect(r.deleted).toEqual([]);
    expect(await readFile(file('big.bin'), 'utf8')).toBe('replaced');
    expect(await m.revertFile(cp.id, file('big.bin'))).toBe(false);
  });

  it('flags files changed after the agent last wrote them', async () => {
    await writeFile(file('mine.txt'), 'orig');
    const cp = m.begin('edit');
    await agentWrite('mine.txt', 'agent');
    await agentWrite('new.txt', 'agent made this');
    await agentWrite('untouched.txt', 'agent');
    expect((await m.plan(cp.id)).filter((c) => c.changedSince)).toEqual([]);
    await writeFile(file('mine.txt'), 'agent, then the user');
    await writeFile(file('new.txt'), 'user kept working here');
    const flagged = (await m.plan(cp.id)).filter((c) => c.changedSince).map((c) => path.basename(c.absolute));
    expect(flagged.sort()).toEqual(['mine.txt', 'new.txt']);
  });

  it('reports a file it could not restore instead of claiming success', async () => {
    const cp = m.begin('dir');
    await agentWrite('gone.txt', 'x');
    await rm(file('gone.txt'));
    await mkdir(file('gone.txt'));
    await writeFile(path.join(file('gone.txt'), 'inside'), 'blocks rm');
    const r = await m.rewind(cp.id);
    expect(r.deleted).toEqual([]);
    expect(r.failed).toEqual([file('gone.txt')]);
  });

  it('reverts a single file to its state before the checkpoint', async () => {
    await writeFile(file('x.txt'), 'orig');
    const cp = m.begin('r');
    await agentWrite('x.txt', 'new');
    await agentWrite('x.txt', 'newer');
    expect(await m.revertFile(cp.id, file('x.txt'))).toBe(true);
    expect(await readFile(file('x.txt'), 'utf8')).toBe('orig');
    expect(await m.revertFile(cp.id, file('never-touched.txt'))).toBe(false);
  });

  it('survives serialization, including sessions saved before change tracking existed', async () => {
    await writeFile(file('s.txt'), 'orig');
    const cp = m.begin('s');
    await agentWrite('s.txt', 'agent');
    const saved = m.serialize();
    const restored = new CheckpointManager(path.join(base, 'backups'));
    restored.restore(saved);
    await writeFile(file('s.txt'), 'user');
    expect((await restored.plan(cp.id))[0]).toMatchObject({ action: 'restore', changedSince: true });
    const legacy = new CheckpointManager(path.join(base, 'backups'));
    legacy.restore(saved.map(({ written: _omit, ...rest }) => ({ ...rest, sha: 'abc' }) as never));
    expect((await legacy.plan(cp.id))[0]).toEqual({ absolute: file('s.txt'), action: 'restore' });
  });
});
