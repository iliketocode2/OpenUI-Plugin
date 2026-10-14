import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { createHarness, tools } from '../helpers/agent';

const BASE = (process.env.OWUI_BASE_URL ?? 'http://localhost:8090').replace(/\/+$/, '');
const MODEL = process.env.OWUI_MODEL ?? 'qwen3.6:27b';
const KEY = process.env.OWUI_API_KEY;
const CONTEXT = Number(process.env.OWUI_CONTEXT ?? 16384);
const THINKING = process.env.OWUI_THINKING === '1';

async function main(): Promise<void> {
  if (!KEY) {
    process.stdout.write('OWUI_API_KEY is not set.\n');
    process.exit(2);
  }
  const h = await createHarness({ baseUrl: BASE, apiKey: KEY, mode: 'auto', allowlist: ['node'], modelId: MODEL, stallMs: 300_000, firstResponseMs: 1_200_000, maxRetries: 1, override: { contextSize: CONTEXT, thinking: THINKING } });
  const started = Date.now();
  let last = 0;
  const timer = setInterval(() => {
    const items = h.session.transcript;
    for (const item of items.slice(last)) {
      if (item.kind === 'tool' && item.status !== 'pending' && item.status !== 'running') {
        process.stdout.write(`  [${Math.round((Date.now() - started) / 1000)}s] ${item.status.padEnd(9)} ${item.title}\n`);
        last = items.indexOf(item) + 1;
      } else if (item.kind !== 'tool' && !(item.kind === 'assistant' && item.streaming)) {
        last = items.indexOf(item) + 1;
      } else break;
    }
  }, 500);
  try {
    process.stdout.write(`Live agent run → ${BASE} model=${MODEL} context=${CONTEXT} thinking=${THINKING}\n`);
    await h.session.send(
      'Create a file hello.js that prints exactly "Hello, sovereign world", run it with node to verify the output, then give a two-line report of what you built and tested.',
      h.ctx,
    );
    clearInterval(timer);
    const cards = tools(h.session);
    for (const c of cards.slice(last)) process.stdout.write(`  ${c.status.padEnd(9)} ${c.title}\n`);
    const content = await readFile(path.join(h.workspace, 'hello.js'), 'utf8').catch(() => '(missing)');
    const final = h.session.transcript.filter((t) => t.kind === 'assistant').at(-1);
    const errors = h.session.transcript.filter((t) => t.kind === 'error' || t.kind === 'warning').map((t) => (t as { text: string }).text);
    const ran = cards.some((c) => c.tool === 'run_command' && c.status === 'done' && /Hello, sovereign world/.test(c.output ?? ''));
    process.stdout.write(`\nhello.js: ${JSON.stringify(content.trim())}\n`);
    process.stdout.write(`final: ${JSON.stringify(final && 'text' in final ? final.text.trim().slice(0, 300) : '')}\n`);
    if (errors.length) process.stdout.write(`notices:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.stdout.write(`\n${ran ? 'PASS' : 'FAIL'}: ${cards.length} tool calls in ${Math.round((Date.now() - started) / 1000)}s; usage=${JSON.stringify(h.session.usage)}\n`);
    process.exitCode = ran ? 0 : 1;
  } finally {
    clearInterval(timer);
    await h.cleanup();
  }
}

void main();
