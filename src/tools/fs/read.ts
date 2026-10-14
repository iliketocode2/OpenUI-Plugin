import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fail, ok, type Tool } from '../types';

const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

interface ReadArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export const readFileTool: Tool<ReadArgs> = {
  name: 'read_file',
  category: 'read',
  description:
    'Read a text file. Returns lines prefixed with line numbers ("  12\\t…"). Use offset/limit for large files. Use view_image for images.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace root or absolute.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to read (1-based).' },
      limit: { type: 'integer', minimum: 1, description: `Number of lines to read (default ${DEFAULT_LIMIT}).` },
    },
    required: ['path'],
  },
  title: (a) => `Read ${a.path}`,
  async prepare(args, ctx) {
    const target = ctx.paths.resolve(args.path);
    return {
      access: { kind: 'read', paths: [target] },
      card: { title: `Read ${target.display}` },
      async execute() {
        let st;
        try {
          st = await stat(target.absolute);
        } catch {
          return fail(`File not found: ${target.display}. Use list_dir or glob to find the right path.`);
        }
        if (st.isDirectory()) return fail(`${target.display} is a directory. Use list_dir instead.`);
        if (IMAGE_EXT.test(target.absolute)) return fail(`${target.display} is an image. Use view_image to look at it.`);
        if (st.size > 20 * 1024 * 1024) return fail(`${target.display} is ${(st.size / 1024 / 1024).toFixed(1)} MB; too large to read. Use grep to search it.`);
        const buf = await readFile(target.absolute);
        if (buf.subarray(0, 8000).includes(0)) return fail(`${target.display} looks like a binary file.`);
        const text = buf.toString('utf8').replace(/^﻿/, '');
        const lines = text.split(/\r?\n/);
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const start = Math.max(1, args.offset ?? 1);
        const limit = args.limit ?? DEFAULT_LIMIT;
        const end = Math.min(lines.length, start + limit - 1);
        if (!lines.length || (lines.length === 1 && lines[0] === '')) {
          ctx.update({ title: `Read ${target.display} — empty file` });
          return ok('(empty file)');
        }
        if (start > lines.length) return fail(`${target.display} has only ${lines.length} lines; offset ${start} is past the end.`);
        const width = String(end).length;
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(width)}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l}`)
          .join('\n');
        const range = start === 1 && end === lines.length ? `${lines.length} lines` : `lines ${start}–${end} of ${lines.length}`;
        ctx.update({ title: `Read ${target.display} — ${range}` });
        const more = end < lines.length ? `\n[${lines.length - end} more lines; continue with offset=${end + 1}]` : '';
        return ok(`${body}${more}`);
      },
    };
  },
};

interface ListArgs {
  path?: string;
}

export const listDirTool: Tool<ListArgs> = {
  name: 'list_dir',
  category: 'read',
  description: 'List the entries of a directory (directories end with "/").',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory path; defaults to the workspace root.' } },
  },
  title: (a) => `List ${a.path ?? '.'}`,
  async prepare(args, ctx) {
    const target = ctx.paths.resolve(args.path ?? '.');
    return {
      access: { kind: 'read', paths: [target] },
      card: { title: `List ${target.display}` },
      async execute() {
        let entries;
        try {
          entries = await readdir(target.absolute, { withFileTypes: true });
        } catch {
          return fail(`Directory not found: ${target.display}`);
        }
        const rows = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b));
        const shown = rows.slice(0, 500);
        ctx.update({ title: `List ${target.display} — ${rows.length} entries` });
        const extra = rows.length > shown.length ? `\n[${rows.length - shown.length} more entries not shown]` : '';
        return ok(shown.length ? `${shown.join('\n')}${extra}` : '(empty directory)');
      },
    };
  },
};

export function relativeTo(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}
