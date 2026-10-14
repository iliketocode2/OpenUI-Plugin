import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const extension = {
  entryPoints: [join(root, 'src/extension.ts')],
  outfile: join(root, 'dist/extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'playwright-core'],
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
  loader: { '.md': 'text' },
};

const webview = {
  entryPoints: [join(root, 'webview/src/main.tsx')],
  outfile: join(root, 'dist/webview/main.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: !production,
  minify: production,
  logLevel: 'warning',
};

async function copyAssets() {
  await mkdir(join(root, 'dist/webview'), { recursive: true });
  await cp(join(root, 'webview/src/styles.css'), join(root, 'dist/webview/styles.css'));
}

if (!watch) await rm(join(root, 'dist'), { recursive: true, force: true });

if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await copyAssets();
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  await copyAssets();
}
