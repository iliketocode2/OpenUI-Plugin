import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INDEX_HEADER, loadProjectContext, removeIndexLine, upsertIndexLine } from '../../src/memory/projectMemory';
import { describeSkills, discoverSkills, listSkillFiles } from '../../src/skills/discovery';
import { parseFrontmatter } from '../../src/skills/frontmatter';
import { loadSkillTool, updateMemoryTool } from '../../src/tools/knowledge';
import { createToolEnv, type TestEnv } from '../helpers/toolContext';

describe('parseFrontmatter', () => {
  it('reads simple, quoted and block values and returns the body', () => {
    const r = parseFrontmatter('﻿---\r\nname: data-viz\r\ndescription: "Charts: colours, \\"palettes\\""\r\nnotes: |\r\n  line one\r\n  line two\r\nfolded: >\r\n  a\r\n  b\r\nother: plain # comment\r\n---\r\n# Body\r\n');
    expect(r.data).toEqual({ name: 'data-viz', description: 'Charts: colours, "palettes"', notes: 'line one\nline two', folded: 'a b', other: 'plain' });
    expect(r.body).toBe('# Body\r\n');
  });

  it('returns no data when there is no frontmatter', () => {
    expect(parseFrontmatter('# Just markdown').data).toEqual({});
    expect(parseFrontmatter("---\nname: 'it''s'\n---").data.name).toBe("it's");
  });
});

describe('skills', () => {
  let base: string;
  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'owui skills '));
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function skill(root: string, folder: string, frontmatter: string, extra: Record<string, string> = {}) {
    const dir = path.join(base, root, folder);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${folder}\n`);
    for (const [f, c] of Object.entries(extra)) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), c);
    }
  }

  it('discovers workspace skills before user skills and skips invalid ones', async () => {
    await skill('ws', 'viz', 'name: dataviz\ndescription: Charts and palettes', { 'scripts/check.mjs': '', '.hidden/x': '' });
    await skill('user', 'viz-copy', 'name: dataviz\ndescription: Shadowed by the workspace one');
    await skill('user', 'deploy', 'description: Uses the folder name when name is missing');
    await skill('user', 'bad', 'name: has spaces in name\ndescription: x');
    await mkdir(path.join(base, 'user', 'no-skill-file'), { recursive: true });
    const skills = await discoverSkills([
      { dir: path.join(base, 'ws'), source: 'workspace' },
      { dir: path.join(base, 'user'), source: 'user' },
      { dir: path.join(base, 'missing'), source: 'user' },
    ]);
    expect(skills.map((s) => [s.name, s.source, s.description])).toEqual([
      ['dataviz', 'workspace', 'Charts and palettes'],
      ['deploy', 'user', 'Uses the folder name when name is missing'],
    ]);
    expect((await listSkillFiles(skills[0]!.dir)).map((f) => path.relative(skills[0]!.dir, f).split(path.sep).join('/'))).toEqual(['scripts/check.mjs']);
    expect(describeSkills(skills)).toContain('- dataviz: Charts and palettes');
    expect(describeSkills([])).toBe('');
  });
});

describe('project memory files', () => {
  it('upserts and removes index lines without touching other lines', () => {
    let idx = upsertIndexLine('', 'build-and-test', 'npm test runs vitest');
    expect(idx).toBe(`${INDEX_HEADER.trimEnd()}\n- [build-and-test](build-and-test.md) — npm test runs vitest\n`);
    idx = upsertIndexLine(idx, 'conventions', 'Prettier, 2 spaces');
    idx = upsertIndexLine(idx, 'build-and-test', 'npm test runs vitest; npm run e2e runs playwright');
    expect(idx.match(/build-and-test\.md/g)).toHaveLength(1);
    expect(idx).toContain('npm run e2e runs playwright');
    expect(removeIndexLine(idx, 'build-and-test')).not.toContain('build-and-test');
    expect(removeIndexLine(idx, 'build-and-test')).toContain('- [conventions](conventions.md)');
  });

  it('loads AGENTS.md and MEMORY.md into prompt sections, truncating long files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'owui memory '));
    try {
      expect((await loadProjectContext(root)).join('\n')).toMatch(/No project memory yet/);
      await writeFile(path.join(root, 'AGENTS.md'), 'Use pnpm.');
      await mkdir(path.join(root, '.owui', 'memory'), { recursive: true });
      await writeFile(path.join(root, '.owui', 'memory', 'MEMORY.md'), `# Project memory\n${'x'.repeat(9000)}`);
      const sections = await loadProjectContext(root);
      expect(sections[0]).toContain('Use pnpm.');
      expect(sections[1]).toMatch(/truncated; read the file/);
      expect(sections[1]!.length).toBeLessThan(8400);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('update_memory and load_skill tools', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await createToolEnv();
  });
  afterEach(async () => {
    await env.cleanup();
  });

  it('writes the topic and index, reports .owui creation once, and can delete', async () => {
    const r = await env.run(updateMemoryTool, { topic: 'build-and-test', content: '# Build\n`npm test`', summary: 'How to test' });
    expect(r.isError).toBeFalsy();
    expect(r.access).toBe('write');
    const dir = path.join(env.workspace, '.owui', 'memory');
    expect(await readFile(path.join(dir, 'build-and-test.md'), 'utf8')).toBe('# Build\n`npm test`\n');
    expect(await readFile(path.join(dir, 'MEMORY.md'), 'utf8')).toContain('- [build-and-test](build-and-test.md) — How to test');
    expect(env.createdDirs).toEqual([path.join(env.workspace, '.owui')]);
    await env.run(updateMemoryTool, { topic: 'conventions', content: 'Tabs', summary: 'Style' });
    expect(env.createdDirs).toHaveLength(1);
    await env.run(updateMemoryTool, { topic: 'build-and-test', delete: true });
    expect(await readFile(path.join(dir, 'MEMORY.md'), 'utf8')).not.toContain('build-and-test');
    expect((await env.run(updateMemoryTool, { topic: 'build-and-test', delete: true })).content).toMatch(/no memory topic/i);
  });

  it('rejects bad topic names, missing content and secrets', async () => {
    expect((await env.run(updateMemoryTool, { topic: '../escape', content: 'x' })).content).toMatch(/kebab-case/);
    expect((await env.run(updateMemoryTool, { topic: 'memory', content: 'x' })).content).toMatch(/kebab-case/);
    expect((await env.run(updateMemoryTool, { topic: 'ok' })).content).toMatch(/content is required/);
    expect((await env.run(updateMemoryTool, { topic: 'keys', content: 'OPENAI_API_KEY=sk-abcdefghijklmnop' })).content).toMatch(/secret/);
  });

  it('loads a discovered skill with its file list', async () => {
    const dir = path.join(env.scratchpad, 'skills', 'viz');
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: viz\ndescription: d\n---\nUse the script.');
    await writeFile(path.join(dir, 'scripts', 'run.mjs'), '');
    env.ctx.skills = await discoverSkills([{ dir: path.join(env.scratchpad, 'skills'), source: 'user' }]);
    const r = await env.run(loadSkillTool, { name: 'VIZ' });
    expect(r.access).toBe('none');
    expect(r.content).toContain('Use the script.');
    expect(r.content).toContain(path.join(dir, 'scripts', 'run.mjs'));
    expect((await env.run(loadSkillTool, { name: 'nope' })).content).toMatch(/Available: viz/);
  });
});
