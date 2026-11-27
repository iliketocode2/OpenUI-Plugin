#!/usr/bin/env node
// Runs live agent tasks several times against a real Open WebUI and prints the median, minimum and maximum of each
// metric, so a change can be judged on more than one run. Needs the same variables as `npm run smoke:agent`
// (OWUI_API_KEY, OWUI_MODEL, OWUI_CONTEXT). Usage:
//   OWUI_RUNS=3 OWUI_TASKS=scaffold,multistep node scripts/bench-agent.mjs [label]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2] ?? 'bench';
const runs = Math.max(1, Number(process.env.OWUI_RUNS ?? 3));
const tasks = (process.env.OWUI_TASKS ?? 'scaffold,multistep').split(',').map((t) => t.trim()).filter(Boolean);
if (!process.env.OWUI_API_KEY) {
  process.stdout.write('OWUI_API_KEY is not set.\n');
  process.exit(2);
}

const METRICS = ['seconds', 'outputTokens', 'modelTurns', 'toolCalls', 'failedTools', 'todoWrite', 'maxCallsPerTurn'];
const results = Object.fromEntries(tasks.map((t) => [t, []]));
for (let i = 1; i <= runs; i++) {
  // Tasks interleave, so slow drift (heat, memory) spreads over all of them.
  for (const task of tasks) {
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'live-agent.mjs')], { cwd: root, env: { ...process.env, OWUI_TASK: task }, encoding: 'utf8' });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('metrics-json: '));
    if (!line) {
      process.stdout.write(`${label} ${task} run ${i}: no metrics (exit ${r.status})\n${(r.stdout ?? '').slice(-800)}${r.stderr ?? ''}\n`);
      continue;
    }
    const m = JSON.parse(line.slice('metrics-json: '.length));
    results[task].push(m);
    process.stdout.write(`${label} ${task} run ${i}: ${m.pass ? 'PASS' : 'FAIL'} ${METRICS.map((k) => `${k}=${m[k]}`).join(' ')}\n`);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
for (const task of tasks) {
  const rs = results[task];
  if (!rs.length) continue;
  process.stdout.write(`\n${label} ${task}: ${rs.filter((r) => r.pass).length}/${rs.length} passed\n`);
  for (const k of METRICS) {
    const xs = rs.map((r) => r[k]);
    process.stdout.write(`  ${k.padEnd(16)} median ${String(median(xs)).padStart(6)}   min ${String(Math.min(...xs)).padStart(6)}   max ${String(Math.max(...xs)).padStart(6)}\n`);
  }
  process.stdout.write(`summary-json: ${JSON.stringify({ label, task, runs: rs.length, passed: rs.filter((r) => r.pass).length, ...Object.fromEntries(METRICS.map((k) => [k, median(rs.map((r) => r[k]))])) })}\n`);
}
