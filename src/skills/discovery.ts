import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parseFrontmatter } from './frontmatter';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  source: 'workspace' | 'user';
}

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_DESCRIPTION = 300;

export async function discoverSkills(roots: { dir: string; source: Skill['source'] }[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(root.dir, e.name);
      const file = path.join(dir, 'SKILL.md');
      try {
        const st = await stat(file);
        if (!st.isFile() || st.size > MAX_SKILL_BYTES) continue;
        const { data } = parseFrontmatter(await readFile(file, 'utf8'));
        const name = (data.name ?? e.name).trim();
        if (!/^[\w.-]{1,64}$/.test(name) || byName.has(name)) continue;
        const description = (data.description ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);
        byName.set(name, { name, description: description || '(no description)', dir, file, source: root.source });
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()];
}

export async function listSkillFiles(dir: string, limit = 50): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const child = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') await walk(child);
      } else if (e.isFile() && child !== 'SKILL.md') out.push(path.join(dir, child));
    }
  };
  await walk('');
  return out;
}

export function describeSkills(skills: Skill[]): string {
  if (!skills.length) return '';
  return [
    '# Skills',
    'Skills are folders of instructions and scripts for specialised tasks. When a task matches a skill, call load_skill with its name before starting, then follow it.',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}
