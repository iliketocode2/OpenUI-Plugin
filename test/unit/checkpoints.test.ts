import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointManager } from '../../src/checkpoints/checkpoints';
import { ShadowGit } from '../../src/checkpoints/shadowGit';

let base: string;
let ws: string;
let gitDir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'owui checkpoints '));
  ws = path.join(base, 'my project');
  gitDir = path.join(base, 'storage', 'shadow git');
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const file = (rel: string) => path.join(ws, rel);

describe('ShadowGit', () => {
  it('snapshots, lists changes and restores byte-for-byte (CRLF, spaces in paths)', async () => {
    const g = new ShadowGit({ gitDir, workTree: ws });
    await mkdir(file('src dir'), { recursive: true });
    await writeFile(file('src dir/a.txt'), 'one\r\ntwo\r\n');
    await writeFile(file('b.txt'), 'b');
    const first = await g.snapshot('first');
    await writeFile(file('src dir/a.txt'), 'changed\n');
    await rm(file('b.txt'));
    await writeFile(file('new file.txt'), 'new');
    const second = await g.snapshot('second');
    const changes = await g.changes(first, second);
    expect(changes.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { status: 'D', path: 'b.txt' },
      { status: 'A', path: 'new file.txt' },
      { status: 'M', path: 'src dir/a.txt' },
    ]);
    await g.restoreFiles(first, ['src dir/a.txt', 'b.txt']);
    expect(await readFile(file('src dir/a.txt'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect(await readFile(file('b.txt'), 'utf8')).toBe('b');
    expect(await g.fileAt(first, 'src dir/a.txt')).toBe('one\r\ntwo\r\n');
  });

  it('skips heavy folders such as node_modules', async () => {
    const g = new ShadowGit({ gitDir, workTree: ws });
    await mkdir(file('node_modules/pkg'), { recursive: true });
    await writeFile(file('node_modules/pkg/index.js'), 'x');
    await writeFile(file('keep.txt'), 'k');
    await g.snapshot('s');
    const tracked = (await g.run(['ls-files'])).split('\n').filter(Boolean);
    expect(tracked).toEqual(['keep.txt']);
  });

  it('never touches the user repository and never runs network commands', async () => {
    execFileSync('git', ['init', '--quiet'], { cwd: ws });
    execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@x', 'commit', '--quiet', '--allow-empty', '-m', 'user commit'], { cwd: ws });
    await writeFile(file('work.txt'), 'w');
    const g = new ShadowGit({ gitDir, workTree: ws });
    await g.snapshot('s');
    const log = execFileSync('git', ['log', '--oneline'], { cwd: ws, encoding: 'utf8' }).trim().split('\n');
    expect(log).toHaveLength(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' })).toContain('?? work.txt');
    expect(existsSync(path.join(gitDir, 'HEAD'))).toBe(true);
    for (const sub of ['push', 'fetch', 'pull', 'clone', 'remote', 'submodule', 'ls-remote']) {
      await expect(g.run([sub])).rejects.toThrow(/not allowed/);
    }
    const tracked = (await g.run(['ls-files'])).split('\n').filter(Boolean);
    expect(tracked).toEqual(['work.txt']);
  });
});

describe('CheckpointManager', () => {
  it('rewinds everything since a checkpoint with git, including command-made changes', async () => {
    const m = new CheckpointManager(new ShadowGit({ gitDir, workTree: ws }), path.join(base, 'backups'));
    await writeFile(file('a.txt'), 'v1');
    const cp = await m.begin('first request');
    expect(cp.sha).toMatch(/^[0-9a-f]{40}$/);
    await m.recordBeforeWrite(file('a.txt'));
    await writeFile(file('a.txt'), 'v2');
    await writeFile(file('generated.txt'), 'made by a command');
    const plan = await m.plan(cp.id);
    expect(plan.method).toBe('git');
    expect(plan.changes.map((c) => [path.basename(c.absolute), c.action]).sort()).toEqual([
      ['a.txt', 'restore'],
      ['generated.txt', 'delete'],
    ]);
    const result = await m.rewind(cp.id);
    expect(result.method).toBe('git');
    expect(await readFile(file('a.txt'), 'utf8')).toBe('v1');
    expect(existsSync(file('generated.txt'))).toBe(false);
    expect(m.list()).toHaveLength(0);
  });

  it('falls back to backups of agent-edited files when git is unavailable', async () => {
    const m = new CheckpointManager(new ShadowGit({ gitDir, workTree: ws, git: 'definitely-not-git' }), path.join(base, 'backups'));
    await writeFile(file('a.txt'), 'v1');
    const cp1 = await m.begin('one');
    expect(cp1.snapshotError).toMatch(/git is not available/);
    await m.recordBeforeWrite(file('a.txt'));
    await writeFile(file('a.txt'), 'v2');
    await m.recordBeforeWrite(file('created.txt'));
    await writeFile(file('created.txt'), 'c');
    await m.begin('two');
    await m.recordBeforeWrite(file('a.txt'));
    await writeFile(file('a.txt'), 'v3');
    await writeFile(file('untracked-by-agent.txt'), 'u');
    expect(m.agentChangesSince(cp1.id).map((c) => [path.basename(c.absolute), c.action]).sort()).toEqual([
      ['a.txt', 'restore'],
      ['created.txt', 'delete'],
    ]);
    const r = await m.rewind(cp1.id);
    expect(r.method).toBe('backups');
    expect(await readFile(file('a.txt'), 'utf8')).toBe('v1');
    expect(existsSync(file('created.txt'))).toBe(false);
    expect(existsSync(file('untracked-by-agent.txt'))).toBe(true);
  });

  it('reverts a single file to its state before the checkpoint', async () => {
    const m = new CheckpointManager(undefined, path.join(base, 'backups'));
    await writeFile(file('x.txt'), 'orig');
    const cp = await m.begin('r');
    await m.recordBeforeWrite(file('x.txt'));
    await writeFile(file('x.txt'), 'new');
    await m.recordBeforeWrite(file('x.txt'));
    await writeFile(file('x.txt'), 'newer');
    expect(await m.revertFile(cp.id, file('x.txt'))).toBe(true);
    expect(await readFile(file('x.txt'), 'utf8')).toBe('orig');
    expect(await m.revertFile(cp.id, file('never-touched.txt'))).toBe(false);
  });
});
