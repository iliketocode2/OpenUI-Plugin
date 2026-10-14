#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out', 'live', 'agent.live.js');
await esbuild.build({
  entryPoints: [join(root, 'test', 'live', 'agent.live.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['playwright-core'],
  loader: { '.md': 'text' },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, [out], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
