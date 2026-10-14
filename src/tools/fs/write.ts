import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fail, ok, type Tool } from '../types';
import { changeSummary, computeDiff, countLines, plural } from './diffing';

async function readExisting(file: string): Promise<string | undefined> {
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error(`${file} is not a file`);
    return (await readFile(file)).toString('utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function usesCrlf(text: string): boolean {
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
}

function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

interface WriteArgs {
  path: string;
  content: string;
}

export const writeFileTool: Tool<WriteArgs> = {
  name: 'write_file',
  category: 'edit',
  description: 'Create a file or overwrite it completely. Parent directories are created. Prefer edit_file for small changes to existing files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root or absolute.' },
      content: { type: 'string', description: 'The complete file content.' },
    },
    required: ['path', 'content'],
  },
  title: (a) => `Write ${a.path}`,
  async prepare(args, ctx) {
    const target = ctx.paths.resolve(args.path);
    const before = await readExisting(target.absolute).catch((e: Error) => e);
    if (before instanceof Error) return fail(before.message);
    const content = before !== undefined && usesCrlf(before) && !args.content.includes('\r\n') ? toCrlf(args.content) : args.content;
    const lines = countLines(content);
    const diff = before === undefined ? computeDiff('', content) : computeDiff(before, content);
    const title = before === undefined ? `Write ${target.display} — ${plural(lines, 'line')}` : `Write ${target.display} — ${changeSummary(diff)}`;
    return {
      access: { kind: 'write', paths: [target] },
      card: { title, diff: diff.unified, summary: before === undefined ? 'New file' : changeSummary(diff) },
      async execute() {
        await mkdir(path.dirname(target.absolute), { recursive: true });
        await writeFile(target.absolute, content, 'utf8');
        return ok(before === undefined ? `Created ${target.display} (${plural(lines, 'line')}).` : `Overwrote ${target.display} (${plural(lines, 'line')}; ${changeSummary(diff).toLowerCase()}).`);
      },
    };
  },
};

interface EditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function numbered(lines: string[], from: number): string {
  const width = String(from + lines.length).length;
  return lines.map((l, i) => `${String(from + i).padStart(width)}\t${l}`).join('\n');
}

function excerpt(text: string, around: number[], radius = 6): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= 300) return numbered(lines, 1);
  const parts: string[] = [];
  for (const line of around.slice(0, 5)) {
    const start = Math.max(1, line - radius);
    parts.push(numbered(lines.slice(start - 1, line + radius), start));
  }
  if (!parts.length) parts.push(`${numbered(lines.slice(0, 150), 1)}\n… [${lines.length - 150} more lines; use read_file with offset]`);
  return parts.join('\n…\n');
}

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

function closestLines(text: string, needle: string): number[] {
  const first = needle.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).find((l) => l.length > 3);
  if (!first) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim() === first || (first.length > 12 && l.includes(first.slice(0, Math.min(40, first.length))))) hits.push(i + 1);
  });
  return hits;
}

export const editFileTool: Tool<EditArgs> = {
  name: 'edit_file',
  category: 'edit',
  description:
    'Replace an exact string in a file. old_string must match the file exactly (including whitespace and indentation) and occur exactly once, unless replace_all is true. Include enough surrounding lines to make it unique. If it fails you get the current content to retry with.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  title: (a) => `Edit ${a.path}`,
  async prepare(args, ctx) {
    const target = ctx.paths.resolve(args.path);
    const before = await readExisting(target.absolute).catch((e: Error) => e);
    if (before instanceof Error) return fail(before.message);
    if (before === undefined) return fail(`File not found: ${target.display}. Use write_file to create a new file.`);
    if (!args.old_string) return fail('old_string is empty. To create or replace a whole file, use write_file.');
    if (args.old_string === args.new_string) return fail('old_string and new_string are identical; nothing to change.');
    let oldStr = args.old_string;
    let newStr = args.new_string;
    let hits = findAll(before, oldStr);
    if (!hits.length && before.includes('\r\n') && !oldStr.includes('\r\n')) {
      oldStr = toCrlf(oldStr);
      newStr = toCrlf(newStr);
      hits = findAll(before, oldStr);
    }
    if (!hits.length) {
      return fail(
        `old_string was not found in ${target.display}. It must match exactly, including whitespace. Current content:\n${excerpt(before, closestLines(before, args.old_string))}`,
      );
    }
    if (hits.length > 1 && !args.replace_all) {
      const lineNos = hits.map((h) => lineOf(before, h));
      return fail(
        `old_string occurs ${hits.length} times in ${target.display} (lines ${lineNos.join(', ')}). Add surrounding lines to make it unique, or set replace_all to true.\n${excerpt(before, lineNos, 3)}`,
      );
    }
    const after = args.replace_all ? before.split(oldStr).join(newStr) : before.slice(0, hits[0]!) + newStr + before.slice(hits[0]! + oldStr.length);
    const diff = computeDiff(before, after);
    const summary = changeSummary(diff);
    return {
      access: { kind: 'write', paths: [target] },
      card: { title: `Edit ${target.display} — ${summary}`, diff: diff.unified, summary },
      async execute() {
        const current = await readFile(target.absolute, 'utf8');
        if (current !== before) return fail(`${target.display} changed on disk since the edit was prepared. Read it again and retry.`);
        await writeFile(target.absolute, after, 'utf8');
        const count = args.replace_all ? ` (${hits.length} occurrence${hits.length === 1 ? '' : 's'})` : '';
        return ok(`Edited ${target.display}${count}: ${summary.toLowerCase()}.`);
      },
    };
  },
};
