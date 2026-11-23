import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { SENSITIVE_GLOBS } from '../../workspace/paths';
import { runRipgrep } from '../../workspace/ripgrep';
import { fail, ok, type Tool, type ToolResult } from '../types';

const MAX_FILES = 500;
/** VS Code ships ripgrep, so this only happens when the extension runs somewhere unusual. */
const NO_RIPGREP: ToolResult = fail('ripgrep was not found, so file search is unavailable. Install ripgrep (rg) on PATH, or use run_command with your shell.');
/** Paths always use /, also on Windows, so the model never sees a backslash it might copy into a pattern or edit. */
const COMMON = ['--path-separator', '/', '--hidden', '--no-require-git', '--glob', '!.git', '--glob', '!**/node_modules/**'];

interface GlobArgs {
  pattern: string;
  path?: string;
}

export const globTool: Tool<GlobArgs> = {
  name: 'glob',
  category: 'read',
  description: 'Find files by glob, e.g. "src/**/*.ts", respecting .gitignore. Returns paths relative to the search directory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory; defaults to the workspace root.' },
    },
    required: ['pattern'],
  },
  title: (a) => `Find ${a.pattern}`,
  async prepare(args, ctx) {
    const dir = ctx.paths.resolve(args.path ?? '.');
    return {
      access: { kind: 'read', paths: [dir] },
      card: { title: `Find ${args.pattern}${args.path ? ` in ${dir.display}` : ''}` },
      async execute() {
        if (!ctx.ripgrep) return NO_RIPGREP;
        const r = await runRipgrep(ctx.ripgrep, ['--files', ...COMMON, '--glob', args.pattern.replace(/\\/g, '/')], dir.absolute, ctx.signal);
        if (r.code !== 0 && r.code !== 1) return fail(`glob failed: ${r.stderr.trim() || `ripgrep exited with ${r.code}`}`);
        const files = r.stdout.split(/\r?\n/).filter(Boolean).sort();
        const truncated = r.truncated;
        ctx.update({ title: `Find ${args.pattern} — ${files.length}${truncated ? '+' : ''} file${files.length === 1 ? '' : 's'}` });
        if (!files.length) return ok('No files matched.');
        const shown = files.slice(0, MAX_FILES);
        return ok(`${shown.join('\n')}${files.length > shown.length || truncated ? `\n[more results not shown; narrow the pattern]` : ''}`);
      },
    };
  },
};

interface GrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  ignore_case?: boolean;
  context?: number;
  output?: 'content' | 'files' | 'count';
  max_results?: number;
}

export const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  category: 'read',
  description: 'Search file contents with a regex (ripgrep syntax), respecting .gitignore. output: content (matching lines, default), files, or count.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'File or directory; defaults to the workspace root.' },
      glob: { type: 'string', description: 'e.g. "*.ts"' },
      ignore_case: { type: 'boolean' },
      context: { type: 'integer', minimum: 0, maximum: 10, description: 'Lines around each match.' },
      output: { type: 'string', enum: ['content', 'files', 'count'] },
      max_results: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 200.' },
    },
    required: ['pattern'],
  },
  title: (a) => `Search ${JSON.stringify(a.pattern)}`,
  async prepare(args, ctx) {
    const target = ctx.paths.resolve(args.path ?? '.');
    const max = args.max_results ?? 200;
    return {
      access: { kind: 'read', paths: [target] },
      card: { title: `Search ${JSON.stringify(args.pattern)}${args.path ? ` in ${target.display}` : ''}` },
      async execute() {
        if (!ctx.ripgrep) return NO_RIPGREP;
        let isFile = false;
        try {
          isFile = (await stat(target.absolute)).isFile();
        } catch {
          return fail(`Path not found: ${target.display}`);
        }
        const cwd = isFile ? path.dirname(target.absolute) : target.absolute;
        const output = args.output ?? 'content';
        const rgArgs = ['--no-heading', '--color', 'never', ...COMMON, '--max-columns', '400', '--max-columns-preview'];
        if (output === 'files') rgArgs.push('--files-with-matches');
        else if (output === 'count') rgArgs.push('--count');
        else rgArgs.push('--line-number');
        if (args.ignore_case) rgArgs.push('--ignore-case');
        if (args.context && output === 'content') rgArgs.push('--context', String(args.context));
        if (args.glob) rgArgs.push('--glob', args.glob);
        // Later globs win, so these exclusions hold even when the model's glob names a secrets file.
        if (!isFile) for (const g of SENSITIVE_GLOBS) rgArgs.push('--glob', `!${g}`);
        rgArgs.push('--regexp', args.pattern);
        if (isFile) rgArgs.push(path.basename(target.absolute));
        const r = await runRipgrep(ctx.ripgrep, rgArgs, cwd, ctx.signal);
        if (r.code === 2 && !r.stdout && /No files were searched/i.test(r.stderr)) return ok('No matches.');
        if (r.code === 2 && !r.stdout) return fail(`grep failed: ${r.stderr.trim()}`);
        const lines = r.stdout.split(/\r?\n/).filter(Boolean);
        const shown = lines.slice(0, max);
        ctx.update({ title: `Search ${JSON.stringify(args.pattern)} — ${lines.length}${r.truncated ? '+' : ''} result${lines.length === 1 ? '' : 's'}` });
        if (!lines.length) return ok('No matches.');
        return ok(`${shown.join('\n')}${lines.length > shown.length || r.truncated ? `\n[${r.truncated ? 'output truncated' : `${lines.length - shown.length} more results`}; narrow the search]` : ''}`);
      },
    };
  },
};
