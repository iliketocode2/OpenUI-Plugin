import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listDirTool, readFileTool } from '../../src/tools/fs/read';
import { globTool, grepTool } from '../../src/tools/fs/search';
import { editFileTool, writeFileTool } from '../../src/tools/fs/write';
import { todoWriteTool, viewImageTool, askUserTool } from '../../src/tools/interactive';
import { createToolEnv, testRipgrep, type TestEnv } from '../helpers/toolContext';

let env: TestEnv;

beforeEach(async () => {
  env = await createToolEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe('read_file', () => {
  it('returns numbered lines with ranges and a continuation hint', async () => {
    await writeFile(path.join(env.workspace, 'a.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
    const r = await env.run(readFileTool, { path: 'a.txt', offset: 5, limit: 3 });
    expect(r.content).toBe('5\tline 5\n6\tline 6\n7\tline 7\n[23 more lines; continue with offset=8]');
    expect(env.updates.at(-1)?.title).toBe('Read a.txt — lines 5–7 of 30');
  });

  it('handles missing, binary, image and empty files', async () => {
    expect((await env.run(readFileTool, { path: 'nope.txt' })).isError).toBe(true);
    await writeFile(path.join(env.workspace, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    expect((await env.run(readFileTool, { path: 'bin.dat' })).content).toMatch(/binary/);
    await writeFile(path.join(env.workspace, 'pic.png'), 'x');
    expect((await env.run(readFileTool, { path: 'pic.png' })).content).toMatch(/view_image/);
    await writeFile(path.join(env.workspace, 'empty.txt'), '');
    expect((await env.run(readFileTool, { path: 'empty.txt' })).content).toBe('(empty file)');
  });

  it('strips a BOM and reads CRLF files', async () => {
    await writeFile(path.join(env.workspace, 'crlf.txt'), '﻿a\r\nb\r\n');
    expect((await env.run(readFileTool, { path: 'crlf.txt' })).content).toBe('1\ta\n2\tb');
  });
});

describe('list_dir', () => {
  it('lists directories first with a trailing slash', async () => {
    await mkdir(path.join(env.workspace, 'src'));
    await writeFile(path.join(env.workspace, 'b.txt'), '');
    await writeFile(path.join(env.workspace, 'a.txt'), '');
    expect((await env.run(listDirTool, {})).content).toBe('src/\na.txt\nb.txt');
  });
});

describe('write_file', () => {
  it('creates files and parent folders, with a line-count title', async () => {
    const r = await env.run(writeFileTool, { path: 'src/components/File.tsx', content: 'a\nb\nc\n' });
    expect(r.content).toMatch(/Created src\/components\/File.tsx \(3 lines\)/);
    expect(r.card?.title).toBe('Write src/components/File.tsx — 3 lines');
    expect(await readFile(path.join(env.workspace, 'src', 'components', 'File.tsx'), 'utf8')).toBe('a\nb\nc\n');
  });

  it('keeps CRLF line endings when overwriting a CRLF file', async () => {
    await writeFile(path.join(env.workspace, 'w.txt'), 'one\r\ntwo\r\n');
    const r = await env.run(writeFileTool, { path: 'w.txt', content: 'one\nTWO\n' });
    expect(r.card?.title).toBe('Write w.txt — Added 1 line, removed 1 line');
    expect(await readFile(path.join(env.workspace, 'w.txt'), 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('reports writes outside the workspace as write access for the policy', async () => {
    const outside = path.join(env.scratchpad, '..', 'owui-outside-test.txt');
    const prepared = await writeFileTool.prepare({ path: outside, content: 'x' }, env.ctx);
    expect('access' in prepared && prepared.access.kind === 'write' && prepared.access.paths[0]!.zone).toBe('outside');
  });
});

describe('edit_file', () => {
  const file = () => path.join(env.workspace, 'e.ts');

  it('replaces a unique match and summarizes the change', async () => {
    await writeFile(file(), 'const a = 1;\nconst b = 2;\n');
    const r = await env.run(editFileTool, { path: 'e.ts', old_string: 'const b = 2;', new_string: 'const b = 3;\nconst c = 4;' });
    expect(r.isError).toBeFalsy();
    expect(r.card?.title).toBe('Edit e.ts — Added 2 lines, removed 1 line');
    expect(r.card?.diff).toContain('+const c = 4;');
    expect(await readFile(file(), 'utf8')).toBe('const a = 1;\nconst b = 3;\nconst c = 4;\n');
  });

  it('returns the current content when nothing matches', async () => {
    await writeFile(file(), 'function hello() {\n  return 1;\n}\n');
    const r = await env.run(editFileTool, { path: 'e.ts', old_string: 'return 2;', new_string: 'return 3;' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('was not found');
    expect(r.content).toContain('2\t  return 1;');
  });

  it('refuses ambiguous matches unless replace_all is set', async () => {
    await writeFile(file(), 'x();\nx();\n');
    const r = await env.run(editFileTool, { path: 'e.ts', old_string: 'x();', new_string: 'y();' });
    expect(r.content).toMatch(/occurs 2 times .*lines 1, 2/);
    const all = await env.run(editFileTool, { path: 'e.ts', old_string: 'x();', new_string: 'y();', replace_all: true });
    expect(all.content).toMatch(/2 occurrences/);
    expect(await readFile(file(), 'utf8')).toBe('y();\ny();\n');
  });

  it('matches LF old_string against a CRLF file and keeps CRLF', async () => {
    await writeFile(file(), 'a\r\nb\r\nc\r\n');
    const r = await env.run(editFileTool, { path: 'e.ts', old_string: 'a\nb', new_string: 'a\nB' });
    expect(r.isError).toBeFalsy();
    expect(await readFile(file(), 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });

  it('refuses to apply if the file changed after the edit was prepared', async () => {
    await writeFile(file(), 'v1\n');
    const prepared = await editFileTool.prepare({ path: 'e.ts', old_string: 'v1', new_string: 'v2' }, env.ctx);
    await writeFile(file(), 'v1 changed by someone\n');
    const r = await (prepared as { execute(): Promise<{ content: string; isError?: boolean }> }).execute();
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/changed on disk/);
  });

  it('rejects empty or no-op edits and missing files', async () => {
    await writeFile(file(), 'x\n');
    expect((await env.run(editFileTool, { path: 'e.ts', old_string: '', new_string: 'y' })).content).toMatch(/write_file/);
    expect((await env.run(editFileTool, { path: 'e.ts', old_string: 'x', new_string: 'x' })).content).toMatch(/identical/);
    expect((await env.run(editFileTool, { path: 'missing.ts', old_string: 'x', new_string: 'y' })).content).toMatch(/not found/);
  });
});

describe.each([
  ['ripgrep', testRipgrep()],
  ['JS fallback', undefined],
])('glob and grep (%s)', (label, rg) => {
  beforeEach(async () => {
    env.ctx.ripgrep = rg;
    await mkdir(path.join(env.workspace, 'src', 'deep dir'), { recursive: true });
    await mkdir(path.join(env.workspace, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(env.workspace, '.gitignore'), 'node_modules\n');
    await writeFile(path.join(env.workspace, 'src', 'a.ts'), 'export const needle = 1;\n');
    await writeFile(path.join(env.workspace, 'src', 'deep dir', 'b.ts'), 'const x = "Needle";\nconst needle = 2;\n');
    await writeFile(path.join(env.workspace, 'src', 'c.md'), 'needle in docs\n');
    await writeFile(path.join(env.workspace, 'node_modules', 'pkg', 'index.ts'), 'needle\n');
  });

  it.runIf(label === 'JS fallback' || !!rg)('finds files by pattern and skips ignored folders', async () => {
    const r = await env.run(globTool, { pattern: '**/*.ts' });
    expect(r.content.split('\n')).toEqual(['src/a.ts', 'src/deep dir/b.ts']);
  });

  it.runIf(label === 'JS fallback' || !!rg)('searches contents with line numbers, globs and case options', async () => {
    const content = await env.run(grepTool, { pattern: 'needle', glob: '*.ts' });
    const lines = content.content.split('\n').sort();
    expect(lines).toEqual(['src/a.ts:1:export const needle = 1;', 'src/deep dir/b.ts:2:const needle = 2;']);
    const files = await env.run(grepTool, { pattern: 'needle', output: 'files', ignore_case: true });
    expect(files.content.split('\n').sort()).toEqual(['src/a.ts', 'src/c.md', 'src/deep dir/b.ts']);
    expect((await env.run(grepTool, { pattern: 'zzz-nothing' })).content).toBe('No matches.');
  });
});

describe('interactive tools', () => {
  it('view_image attaches the image for vision models and refuses otherwise', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await writeFile(path.join(env.workspace, 'shot.png'), png);
    const r = await env.run(viewImageTool, { path: 'shot.png' });
    expect(r.images?.[0]?.mime).toBe('image/png');
    expect(env.updates.at(-1)?.image).toMatch(/^data:image\/png;base64,/);
    env.ctx.modelVision = false;
    expect((await env.run(viewImageTool, { path: 'shot.png' })).isError).toBe(true);
  });

  it('todo_write publishes the list', async () => {
    const r = await env.run(todoWriteTool, { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] });
    expect(r.content).toMatch(/1\/2/);
    expect(env.todos.at(-1)).toHaveLength(2);
  });

  it('ask_user returns the answers', async () => {
    const e = await createToolEnv({ answers: () => [['Supabase'], ['GitHub', 'Slack']] });
    try {
      const r = await e.run(askUserTool, {
        questions: [{ question: 'Backend?', options: ['Supabase', 'Firebase'] }, { question: 'Integrations?', options: ['GitHub', 'Slack'], multiSelect: true }],
      });
      expect(r.content).toBe('Q: Backend?\nA: Supabase\n\nQ: Integrations?\nA: GitHub, Slack');
    } finally {
      await e.cleanup();
    }
  });
});
