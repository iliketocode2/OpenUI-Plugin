import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

export const OWUI_DIR = '.owui';
export const MEMORY_DIR = path.join(OWUI_DIR, 'memory');
export const MEMORY_INDEX = 'MEMORY.md';
export const INDEX_HEADER = '# Project memory\n\nDurable facts about this project, maintained by OWUI Agent. You can edit these files.\n';

const MAX_SECTION_CHARS = 8000;

async function readCapped(file: string): Promise<string | undefined> {
  try {
    const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!text) return undefined;
    return text.length > MAX_SECTION_CHARS ? `${text.slice(0, MAX_SECTION_CHARS)}\n… [truncated; read the file for the rest]` : text;
  } catch {
    return undefined;
  }
}

export async function loadProjectContext(root: string | undefined): Promise<string[]> {
  if (!root) return [];
  const sections: string[] = [];
  const agents = await readCapped(path.join(root, 'AGENTS.md'));
  if (agents) sections.push(`# Project instructions (AGENTS.md, written by the user)\n${agents}`);
  const memory = await readCapped(path.join(root, MEMORY_DIR, MEMORY_INDEX));
  sections.push(
    memory
      ? `# Project memory (${MEMORY_DIR.split(path.sep).join('/')}/${MEMORY_INDEX})\nTopic files linked below can be read with read_file. Keep memory accurate with update_memory.\n${memory}`
      : '# Project memory\nNo project memory yet. When you learn a durable fact worth keeping across sessions (build commands, conventions, architecture decisions, environment quirks), save it with update_memory.',
  );
  return sections;
}

export function upsertIndexLine(index: string, topic: string, summary: string | undefined): string {
  const line = `- [${topic}](${topic}.md)${summary ? ` — ${summary.replace(/\s+/g, ' ').trim()}` : ''}`;
  const re = new RegExp(`^- \\[${topic.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\]\\(${topic.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\.md\\).*$`, 'm');
  const base = index.trim() ? index : INDEX_HEADER;
  if (re.test(base)) return base.replace(re, () => line);
  return `${base.replace(/\s*$/, '')}\n${line}\n`;
}

const SECRET_PATTERNS = [
  /(api[_-]?key|secret|passw(or)?d|token|credential)["']?\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\bpassword\s+(is\s+)?\S{6,}/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

export function removeIndexLine(index: string, topic: string): string {
  return index
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(`- [${topic}](${topic}.md)`))
    .join('\n');
}
