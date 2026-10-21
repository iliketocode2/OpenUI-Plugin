import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathGuard, isSensitivePath } from '../../src/workspace/paths';

let base: string;
let ws: string;
let scratch: string;
let guard: PathGuard;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'owui paths '));
  ws = path.join(base, 'my workspace');
  scratch = path.join(base, 'scratch pad');
  await mkdir(path.join(ws, 'src'), { recursive: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(path.join(ws, 'src', 'a.ts'), '');
  guard = new PathGuard(() => [ws], scratch);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('PathGuard', () => {
  it('resolves relative paths against the workspace root, including paths with spaces', () => {
    const r = guard.resolve('src/a.ts');
    expect(r.zone).toBe('workspace');
    expect(r.absolute).toBe(path.join(ws, 'src', 'a.ts'));
    expect(r.display).toBe('src/a.ts');
    expect(guard.resolve('./new folder/file.txt').zone).toBe('workspace');
  });

  it('classifies the scratchpad and the outside world', () => {
    expect(guard.resolve(path.join(scratch, 'x.js')).zone).toBe('scratchpad');
    expect(guard.resolve('../outside.txt').zone).toBe('outside');
    expect(guard.resolve(path.join(base, 'my workspace-evil', 'x')).zone).toBe('outside');
  });

  it('detects traversal out of the workspace', () => {
    expect(guard.resolve('src/../../my workspace/src/a.ts').zone).toBe('workspace');
    expect(guard.resolve('src/../../../etc/passwd').zone).toBe('outside');
  });

  it.runIf(process.platform === 'win32')('compares case-insensitively on Windows', () => {
    expect(guard.resolve(path.join(ws.toUpperCase(), 'SRC', 'A.TS')).zone).toBe('workspace');
  });

  it('follows symlinks that point outside the workspace', async () => {
    const outside = path.join(base, 'secret');
    await mkdir(outside, { recursive: true });
    const link = path.join(ws, 'link');
    try {
      await symlink(outside, link, 'junction');
    } catch {
      return;
    }
    expect(guard.resolve('link/file.txt').zone).toBe('outside');
  });

  it.runIf(process.platform === 'win32')('rejects NTFS alternate data streams', () => {
    expect(() => guard.resolve('.env::$DATA')).toThrow(/":"/);
    expect(() => guard.resolve('notes.txt:hidden')).toThrow(/":"/);
    expect(guard.resolve(path.join(ws, 'src', 'a.ts')).zone).toBe('workspace');
    expect(guard.resolve(`\\\\?\\${path.join(ws, 'src', 'a.ts')}`).zone).toBe('workspace');
  });

  it('marks Git and VS Code configuration as control paths', () => {
    for (const f of ['.git/config', '.git/hooks/pre-commit', '.vscode/settings.json', 'sub/.git/config']) expect(guard.resolve(f).control, f).toBe(true);
    for (const f of ['.gitignore', '.github/workflows/ci.yml', 'src/a.ts', 'docs/.vscodeignore']) expect(guard.resolve(f).control, f).toBe(false);
  });

  it('treats a link to a sensitive file as sensitive', async () => {
    await writeFile(path.join(ws, '.env'), 'SECRET=1');
    const link = path.join(ws, 'notes.txt');
    try {
      await symlink(path.join(ws, '.env'), link, 'file');
    } catch {
      return; // creating file symlinks needs Developer Mode or admin rights on Windows
    }
    expect(guard.resolve('notes.txt').sensitive).toBe(true);
  });

  it('flags sensitive files', () => {
    for (const f of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'cert.pem', 'server.key', '.npmrc', 'home/.ssh/config', 'credentials']) {
      expect(isSensitivePath(f), f).toBe(true);
    }
    for (const f of ['env.ts', 'src/environment.ts', 'keys.ts', 'README.md']) expect(isSensitivePath(f), f).toBe(false);
  });
});
