#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, `${pkg.name}-${pkg.version}.vsix`);
const node = process.execPath;
const bin = (name, ...rest) => join(root, 'node_modules', name, ...rest);

function run(label, args) {
  process.stdout.write(`\n> ${label}\n`);
  const r = spawnSync(node, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    process.stderr.write(`${label} failed.\n`);
    process.exit(r.status ?? 1);
  }
}

run('production build', [join(root, 'esbuild.mjs'), '--production']);
run('package', [bin('@vscode', 'vsce', 'vsce'), 'package', '--allow-missing-repository', '--skip-license', '--out', out]);

const listing = execFileSync(node, [bin('@vscode', 'vsce', 'vsce'), 'ls'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);
const required = ['package.json', 'README.md', 'dist/extension.js', 'dist/webview/main.js', 'dist/webview/styles.css', 'media/icon.svg', 'examples/skills/dataviz/SKILL.md', 'examples/skills/dataviz/validate_palette.mjs', 'node_modules/playwright-core/package.json'];
const missing = required.filter((f) => !listing.includes(f));
const forbidden = listing.filter((f) => /\.map$|^src\/|^test\/|^webview\/src\/|^\.vscode|^out\/|\.vsix$|node_modules\/(?!playwright-core\/)/.test(f));
const size = statSync(out).size;
process.stdout.write(`\n${out}\n${listing.length} files, ${(size / 1024 / 1024).toFixed(1)} MB\n`);
if (missing.length) process.stderr.write(`Missing from the package: ${missing.join(', ')}\n`);
if (forbidden.length) process.stderr.write(`Unexpected files in the package: ${forbidden.slice(0, 20).join(', ')}\n`);
const key = process.env.OWUI_API_KEY;
if (key) {
  const leaked = listing.filter((f) => readFileSync(join(root, f)).includes(Buffer.from(key)));
  if (leaked.length) {
    process.stderr.write(`These packaged files contain the OWUI_API_KEY value: ${leaked.join(', ')}\n`);
    process.exit(1);
  }
}
process.exit(missing.length || forbidden.length ? 1 : 0);
