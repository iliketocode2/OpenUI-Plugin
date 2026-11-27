import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setLogger } from '../../src/log';
import { createHarness, tools } from '../helpers/agent';

const BASE = (process.env.OWUI_BASE_URL ?? 'http://localhost:8090').replace(/\/+$/, '');
const MODEL = process.env.OWUI_MODEL ?? 'qwen3.6:27b';
const KEY = process.env.OWUI_API_KEY;
const CONTEXT = Number(process.env.OWUI_CONTEXT ?? 16384);
const THINKING = process.env.OWUI_THINKING === '1';
const TASKS = ['code', 'scaffold', 'multistep', 'todo', 'hi', 'web'] as const;
const TASK: (typeof TASKS)[number] = TASKS.find((t) => t === process.env.OWUI_TASK) ?? 'code';
/** OWUI_WARM=1 warms the model up first, as the extension does when it connects, and times it separately. */
const WARM = process.env.OWUI_WARM === '1';
/** The extension's default step limit (owuiAgent.agent.maxIterations), not the test harness's lower one. */
const MAX_ITERATIONS = Number(process.env.OWUI_MAX_ITERATIONS ?? 50);
const PROMPTS = {
  hi: 'hi',
  // A correctness check of the task list, not a speed benchmark: small models rarely start a list on their own.
  todo:
    'Keep a task list with todo_write while you work. Create three files: a.txt containing "a", b.txt containing "b" and c.txt containing "c". ' +
    'Then run node -e "console.log(require(\'fs\').readdirSync(\'.\').filter(f => f.endsWith(\'.txt\')).sort().join(\',\'))" to check them, and report.',
  multistep:
    'In a new folder notes-cli, build a small Node.js project without installing any packages: ' +
    'package.json with "type": "module" and a test script "node --test"; src/notes.js exporting addNote(list, text), removeNote(list, index) and formatNotes(list), all without mutating their input; ' +
    'src/cli.js that reads notes from notes.json, applies "add <text>", "remove <n>" or "list" from process.argv, and writes the file back; ' +
    'and test/notes.test.js covering all three functions, including removing an index that does not exist. ' +
    'Run npm test inside notes-cli, fix any failures, and finish with a short report.',
  code: 'Create a file hello.js that prints exactly "Hello, sovereign world", run it with node to verify the output, then give a two-line report of what you built and tested.',
  scaffold:
    'In a new folder clock, create a small static page that shows the current time: index.html, styles.css and clock.js, updating every second. ' +
    'Then write clock/check.js, a node script that exits with code 1 unless all three files exist and index.html links styles.css and clock.js. Run it with node to verify, then report briefly.',
  web: 'Use web_search to find the official Vitest documentation page about mocking modules, then use web_fetch to read it. Answer in two sentences: how does vi.mock handle being written below the imports? Cite the URL you read.',
};

async function main(): Promise<void> {
  if (!KEY) {
    process.stdout.write('OWUI_API_KEY is not set.\n');
    process.exit(2);
  }
  const h = await createHarness({ baseUrl: BASE, apiKey: KEY, mode: 'auto', allowlist: ['node'], web: TASK === 'web', maxIterations: MAX_ITERATIONS, modelId: MODEL, stallMs: 300_000, firstResponseMs: 1_200_000, maxRetries: 1, override: { contextSize: CONTEXT, thinking: THINKING } });
  // The extension's own timing lines, for a summary that can be compared between prompt versions.
  let modelTurns = 0;
  let outputTokens = 0;
  setLogger({
    info: (m) => {
      const turn = /, \d+ prompt \+ (\d+) output tokens, \d+ tool call/.exec(m);
      if (turn) {
        modelTurns++;
        outputTokens += Number(turn[1]);
      } else if (/~\d+ prompt tokens \(estimated\), \d+ tool call/.test(m)) {
        modelTurns++;
      }
      if (process.env.OWUI_VERBOSE) process.stdout.write(`  log: ${m}\n`);
    },
    warn: (m) => process.stdout.write(`  warn: ${m}\n`),
    error: (m) => process.stdout.write(`  error: ${m}\n`),
  });
  let started = Date.now();
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
    process.stdout.write(`Live agent run (${TASK}) → ${BASE} model=${MODEL} context=${CONTEXT} thinking=${THINKING}\n`);
    if (WARM) {
      await h.session.warmUp(h.ctx);
      process.stdout.write(`warm-up: ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
      started = Date.now();
    }
    await h.session.send(PROMPTS[TASK], h.ctx);
    clearInterval(timer);
    const cards = tools(h.session);
    for (const c of cards.slice(last)) process.stdout.write(`  ${c.status.padEnd(9)} ${c.title}\n`);
    const content = await readFile(path.join(h.workspace, 'hello.js'), 'utf8').catch(() => '(missing)');
    const final = h.session.transcript.filter((t) => t.kind === 'assistant').at(-1);
    const errors = h.session.transcript.filter((t) => t.kind === 'error' || t.kind === 'warning').map((t) => (t as { text: string }).text);
    const finalText = final && 'text' in final ? final.text : '';
    const ran =
      TASK === 'web'
        ? cards.some((c) => c.tool === 'web_search' && c.status === 'done') && cards.some((c) => c.tool === 'web_fetch' && c.status === 'done') && /vitest\.dev/i.test(finalText)
        : TASK === 'scaffold'
          ? cards.some((c) => c.tool === 'run_command' && c.status === 'done' && /check\.js/.test(`${c.title}\n${c.input ?? ''}`))
          : TASK === 'hi'
            ? cards.length === 0 && finalText.trim().length > 0
          : TASK === 'todo'
            ? // The list was kept with status updates by item number, and ends complete.
              h.session.wireMessages().some((m) => m.tool_calls?.some((c) => c.function.name === 'todo_write' && /"update"\s*:/.test(c.function.arguments))) &&
              h.session.todos.length > 0 &&
              h.session.todos.every((t) => t.status === 'completed')
          : TASK === 'multistep'
            ? // The last test run decides: a failure that the agent fixed and re-ran is fine.
              cards.filter((c) => c.tool === 'run_command' && /npm (?:run )?test|node --test/.test(c.input ?? '')).at(-1)?.status === 'done'
            : cards.some((c) => c.tool === 'run_command' && c.status === 'done' && /Hello, sovereign world/.test(c.output ?? ''));
    if (TASK === 'web') process.stdout.write(`approvals: ${h.approvalsSeen.map((a) => `${a.tool}(${a.approval?.editable?.value ?? ''})`).join(', ')}\n`);
    if (TASK === 'code') process.stdout.write(`\nhello.js: ${JSON.stringify(content.trim())}\n`);
    if (TASK === 'todo') {
      const forms = h.session
        .wireMessages()
        .flatMap((m) => m.tool_calls ?? [])
        .filter((c) => c.function.name === 'todo_write')
        .map((c) => (/"update"\s*:/.test(c.function.arguments) ? 'update' : 'full list'));
      process.stdout.write(`todo_write calls: ${forms.join(', ') || 'none'}; final statuses: ${h.session.todos.map((t) => t.status).join(', ') || 'none'}\n`);
    }
    process.stdout.write(`final: ${JSON.stringify(final && 'text' in final ? final.text.trim().slice(0, 300) : '')}\n`);
    if (errors.length) process.stdout.write(`notices:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.stdout.write(`\n${ran ? 'PASS' : 'FAIL'}: ${cards.length} tool calls in ${Math.round((Date.now() - started) / 1000)}s; usage=${JSON.stringify(h.session.usage)}\n`);
    process.stdout.write(
      `metrics: ${modelTurns} model turns, ${outputTokens} output tokens, ${cards.length} tool calls (${cards.filter((c) => c.tool === 'todo_write').length} todo_write), ${Math.round((Date.now() - started) / 1000)}s\n`,
    );
    const batches = h.session.wireMessages().flatMap((m) => (m.role === 'assistant' && m.tool_calls?.length ? [m.tool_calls.length] : []));
    process.stdout.write(
      `metrics-json: ${JSON.stringify({
        task: TASK,
        pass: ran,
        seconds: Math.round((Date.now() - started) / 1000),
        modelTurns,
        outputTokens,
        toolCalls: cards.length,
        todoWrite: cards.filter((c) => c.tool === 'todo_write').length,
        failedTools: cards.filter((c) => c.status === 'error').length,
        maxCallsPerTurn: Math.max(0, ...batches),
      })}\n`,
    );
    process.exitCode = ran ? 0 : 1;
  } finally {
    clearInterval(timer);
    setLogger(undefined);
    await h.cleanup();
  }
}

void main();
