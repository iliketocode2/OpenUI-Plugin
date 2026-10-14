import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let inGroup = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        const atSegmentStart = i === 0 || g[i - 1] === '/';
        const atSegmentEnd = g[i + 2] === '/' || i + 2 === g.length;
        if (atSegmentStart && atSegmentEnd) {
          re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
          i += g[i + 2] === '/' ? 3 : 2;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = g.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += `[${g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
    i++;
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export function matchGlob(relPath: string, glob: string): boolean {
  const p = relPath.replace(/\\/g, '/');
  const re = globToRegExp(glob);
  return re.test(p) || (!glob.includes('/') && re.test(path.posix.basename(p)));
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.venv', 'venv', '__pycache__', '.vscode-test', 'target', 'coverage']);

export async function walkFiles(root: string, opts: { signal?: AbortSignal; limit: number; includeHidden?: boolean }): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const stack = [''];
  while (stack.length) {
    if (opts.signal?.aborted) break;
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && (opts.includeHidden || !e.name.startsWith('.') || e.name === '.github')) stack.push(child);
      } else if (e.isFile()) {
        files.push(child);
        if (files.length >= opts.limit) return { files, truncated: true };
      }
    }
  }
  return { files: files.sort(), truncated: false };
}

export async function jsGrep(
  root: string,
  pattern: RegExp,
  opts: { glob?: string; signal?: AbortSignal; maxMatches: number },
): Promise<{ matches: { file: string; line: number; text: string }[]; truncated: boolean }> {
  const { files } = await walkFiles(root, { limit: 50_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  const matches: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    if (opts.signal?.aborted) break;
    if (opts.glob && !matchGlob(file, opts.glob)) continue;
    const abs = path.join(root, file);
    try {
      if ((await stat(abs)).size > 2_000_000) continue;
      const buf = await readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        pattern.lastIndex = 0;
        if (pattern.test(lines[i]!)) {
          matches.push({ file, line: i + 1, text: lines[i]!.slice(0, 500) });
          if (matches.length >= opts.maxMatches) return { matches, truncated: true };
        }
      }
    } catch {
      continue;
    }
  }
  return { matches, truncated: false };
}
