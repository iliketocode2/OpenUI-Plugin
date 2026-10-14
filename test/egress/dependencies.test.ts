import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

const APPROVED_RUNTIME = [
  'argparse',
  'diff',
  'entities',
  'highlight.js',
  'linkify-it',
  'markdown-it',
  'mdurl',
  'preact',
  'punycode.js',
  'uc.micro',
];

interface Tree {
  version?: string;
  missing?: boolean;
  dependencies?: Record<string, Tree>;
}

function collect(tree: Tree, into: Set<string>): Set<string> {
  for (const [name, sub] of Object.entries(tree.dependencies ?? {})) {
    if (sub.missing || !sub.version) continue;
    into.add(name);
    collect(sub, into);
  }
  return into;
}

describe('runtime dependency allowlist', () => {
  it('production dependencies match the audited list exactly', () => {
    const raw = execSync('npm ls --omit=dev --all --json', { cwd: ROOT, encoding: 'utf8' });
    const names = [...collect(JSON.parse(raw) as Tree, new Set())].sort();
    expect(names).toEqual(APPROVED_RUNTIME);
  });
});
