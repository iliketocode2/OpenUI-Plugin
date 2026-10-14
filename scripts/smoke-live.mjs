#!/usr/bin/env node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = (process.env.OWUI_BASE_URL ?? 'http://localhost:8090').replace(/\/+$/, '');
const MODEL = process.env.OWUI_MODEL ?? 'qwen3.6:27b';
const KEY = process.env.OWUI_API_KEY;
const REQUEST_TIMEOUT_MS = Number(process.env.OWUI_SMOKE_TIMEOUT_MS ?? 600_000);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures', 'live');
const CHARS_PER_TOKEN = 3.5;
const TRUNCATION_RATIO = 0.6;

const results = [];
const findings = {};

function record(name, status, detail) {
  results.push({ name, status, detail });
  const tag = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : status === 'skip' ? 'SKIP' : 'FAIL';
  process.stdout.write(`[${tag}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function describeError(e) {
  const cause = e?.cause ? ` (cause: ${e.cause.code ?? e.cause.name ?? ''} ${e.cause.message ?? ''})` : '';
  return `${e?.message ?? e}${cause}`;
}

function headers(json = true) {
  const h = { Authorization: `Bearer ${KEY}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function getJson(path, auth = true) {
  const res = await fetch(`${BASE}${path}`, {
    headers: auth ? headers(false) : {},
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function estimateTokens(messages, tools) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    chars += 8;
  }
  if (tools) chars += JSON.stringify(tools).length;
  return Math.round(chars / CHARS_PER_TOKEN);
}

function parseSse(raw) {
  const events = [];
  const nonstandard = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      else if (line.trim() && !line.startsWith(':')) nonstandard.push(line);
    }
    if (!dataLines.length) continue;
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      events.push({ done: true });
      continue;
    }
    try {
      events.push({ json: JSON.parse(data) });
    } catch {
      nonstandard.push(data);
    }
  }
  return { events, nonstandard };
}

function assemble(events) {
  const out = {
    content: '',
    reasoning: '',
    reasoningFields: new Set(),
    toolCalls: [],
    toolCallChunks: 0,
    toolCallShapes: new Set(),
    finishReason: null,
    usage: null,
    extraTopLevelKeys: new Set(),
    sawDone: false,
  };
  const byIndex = new Map();
  for (const ev of events) {
    if (ev.done) {
      out.sawDone = true;
      continue;
    }
    const j = ev.json;
    for (const k of Object.keys(j)) {
      if (!['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint'].includes(k)) out.extraTopLevelKeys.add(k);
    }
    if (j.usage) out.usage = j.usage;
    const choice = j.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) out.finishReason = choice.finish_reason;
    const d = choice.delta ?? choice.message ?? {};
    if (typeof d.content === 'string') out.content += d.content;
    for (const f of ['reasoning_content', 'reasoning', 'thinking']) {
      if (typeof d[f] === 'string' && d[f]) {
        out.reasoning += d[f];
        out.reasoningFields.add(f);
      }
    }
    if (Array.isArray(d.tool_calls)) {
      out.toolCallChunks++;
      for (const [pos, tc] of d.tool_calls.entries()) {
        const idx = typeof tc.index === 'number' ? tc.index : pos;
        out.toolCallShapes.add(typeof tc.index === 'number' ? 'indexed' : 'no-index');
        const cur = byIndex.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments !== undefined) {
          const a = tc.function.arguments;
          cur.arguments += typeof a === 'string' ? a : JSON.stringify(a);
          if (typeof a !== 'string') out.toolCallShapes.add('object-arguments');
        }
        byIndex.set(idx, cur);
      }
    }
  }
  out.toolCalls = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  return out;
}

function splitThink(content) {
  const m = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
  if (m) return { reasoning: m[1], content: content.slice(m[0].length), form: 'think-tag' };
  const d = content.match(/<details type="reasoning"[\s\S]*?<\/details>\s*/);
  if (d) return { reasoning: d[0], content: content.replace(d[0], ''), form: 'details-tag' };
  return { reasoning: '', content, form: null };
}

async function chat(label, body) {
  const payload = { model: MODEL, stream: true, ...body };
  const started = Date.now();
  const res = await fetch(`${BASE}/api/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();
  const ms = Date.now() - started;
  const name = label;
  await writeFile(join(FIXTURES, `${name}.request.json`), JSON.stringify(payload, null, 2));
  await writeFile(join(FIXTURES, `${name}.response.${contentType.includes('event-stream') ? 'sse' : 'txt'}`), raw);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${raw.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  let parsed;
  let streamed;
  if (contentType.includes('event-stream') || raw.trimStart().startsWith('data:')) {
    streamed = true;
    parsed = parseSse(raw);
  } else {
    streamed = false;
    parsed = { events: [{ json: JSON.parse(raw) }], nonstandard: [] };
  }
  const a = assemble(parsed.events);
  const think = splitThink(a.content);
  return {
    ...a,
    content: think.content,
    reasoning: a.reasoning || think.reasoning,
    reasoningForm: a.reasoningFields.size ? [...a.reasoningFields].join('+') : think.form,
    streamed,
    contentType,
    nonstandard: parsed.nonstandard,
    eventCount: parsed.events.length,
    ms,
    fixture: name,
  };
}

function shapeSummary(r) {
  return {
    streamed: r.streamed,
    contentType: r.contentType,
    events: r.eventCount,
    sawDone: r.sawDone,
    finishReason: r.finishReason,
    usage: r.usage,
    reasoningForm: r.reasoningForm,
    reasoningChars: r.reasoning.length,
    toolCallChunks: r.toolCallChunks,
    toolCallShapes: [...r.toolCallShapes],
    extraTopLevelKeys: [...r.extraTopLevelKeys],
    nonstandardLines: r.nonstandard.slice(0, 5),
    ms: r.ms,
    fixture: r.fixture,
  };
}

function checkTruncation(name, estimate, usage) {
  if (!usage || typeof usage.prompt_tokens !== 'number') {
    record(`${name}: truncation check`, 'warn', 'no usage in response; truncation detection unavailable (enable the model\'s Usage capability in Open WebUI)');
    return null;
  }
  const ratio = usage.prompt_tokens / estimate;
  const suspect = estimate > 1500 && ratio < TRUNCATION_RATIO;
  record(
    `${name}: truncation check`,
    suspect ? 'warn' : 'pass',
    `server prompt_tokens=${usage.prompt_tokens}, estimate=${estimate}, ratio=${ratio.toFixed(2)}${suspect ? ' — LIKELY TRUNCATED (num_ctx)' : ''}`,
  );
  return { prompt_tokens: usage.prompt_tokens, estimate, ratio, suspect };
}

const ADD_TOOL = {
  type: 'function',
  function: {
    name: 'add',
    description: 'Add two integers and return the sum.',
    parameters: {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    },
  },
};

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file in the working directory.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace old_string with new_string in a file. old_string must occur exactly once.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command in the working directory. Only "node <file>.js" is permitted in this test.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

function parseArgs(s) {
  if (!s || !s.trim()) return {};
  return JSON.parse(s.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

function runNode(dir, file) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      res(`exit ${code}\n${out}`);
    });
  });
}

async function execAgentTool(dir, name, args) {
  const safe = (p) => {
    const full = resolve(dir, String(p ?? ''));
    if (!full.startsWith(resolve(dir))) throw new Error('path outside working directory');
    return full;
  };
  if (name === 'read_file') return await readFile(safe(args.path), 'utf8');
  if (name === 'edit_file') {
    const full = safe(args.path);
    const text = await readFile(full, 'utf8');
    const count = text.split(args.old_string).length - 1;
    if (count !== 1) return `Error: old_string matched ${count} times. Current content:\n${text}`;
    await writeFile(full, text.replace(args.old_string, () => args.new_string));
    return 'OK';
  }
  if (name === 'run_command') {
    const m = String(args.command ?? '').trim().match(/^node\s+(?:\.\/)?([\w.-]+\.js)$/);
    if (!m) return `Error: command refused by smoke-test policy (only "node <file>.js"): ${args.command}`;
    return await runNode(dir, safe(m[1]));
  }
  return `Error: unknown tool ${name}`;
}

async function testServer() {
  try {
    const v = await getJson('/api/version', false);
    findings.version = v.body;
    record('server version', v.status === 200 ? 'pass' : 'fail', JSON.stringify(v.body));
  } catch (e) {
    record('server version', 'fail', `unreachable: ${e.message}`);
    return false;
  }
  try {
    const c = await getJson('/api/config');
    findings.config = c.status === 200 ? { features: c.body?.features ?? null, keys: Object.keys(c.body ?? {}) } : { status: c.status };
    record('GET /api/config', c.status === 200 ? 'pass' : 'warn', c.status === 200 ? `features keys: ${Object.keys(c.body?.features ?? {}).join(', ')}` : `HTTP ${c.status}`);
  } catch (e) {
    record('GET /api/config', 'warn', e.message);
  }
  return true;
}

async function testModels() {
  const r = await getJson('/api/models');
  if (r.status !== 200) {
    record('GET /api/models', 'fail', `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return false;
  }
  const list = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body) ? r.body : [];
  const m = list.find((x) => x.id === MODEL);
  findings.models = { count: list.length, ids: list.map((x) => x.id).slice(0, 50), envelope: Object.keys(r.body ?? {}) };
  if (!m) {
    record('GET /api/models', 'fail', `${list.length} models; "${MODEL}" not found`);
    return false;
  }
  findings.model = {
    topLevelKeys: Object.keys(m),
    owned_by: m.owned_by,
    capabilities: m.info?.meta?.capabilities ?? null,
    params: m.info?.params ?? null,
    ollamaDetails: m.ollama?.details ?? null,
    hasInfo: !!m.info,
  };
  await writeFile(join(FIXTURES, 'models.json'), JSON.stringify(r.body, null, 2));
  record('GET /api/models', 'pass', `${list.length} models; ${MODEL} found; capabilities=${JSON.stringify(findings.model.capabilities)}; num_ctx=${m.info?.params?.num_ctx ?? 'unset'}`);
  return true;
}

async function testStreamedChat() {
  const messages = [{ role: 'user', content: 'Reply with exactly the word: pong' }];
  const r = await chat('chat-basic', { messages });
  findings.chatBasic = shapeSummary(r);
  record('streamed chat', /pong/i.test(r.content) ? 'pass' : 'warn', `streamed=${r.streamed}, content=${JSON.stringify(r.content.trim().slice(0, 80))}, ${r.ms}ms`);
  record('usage present', r.usage ? 'pass' : 'warn', r.usage ? JSON.stringify(r.usage) : 'no usage in stream');
  record('reasoning form', r.reasoningForm ? 'pass' : 'warn', r.reasoningForm ? `${r.reasoningForm} (${r.reasoning.length} chars)` : 'no reasoning detected');
  if (r.nonstandard.length) record('non-standard SSE lines', 'warn', JSON.stringify(r.nonstandard.slice(0, 3)));
}

async function testNativeTool() {
  const messages = [
    { role: 'system', content: 'You are a calculator. Always use the add tool for arithmetic. Never compute sums yourself.' },
    { role: 'user', content: 'What is 1234 + 5678? Use the add tool.' },
  ];
  let r;
  try {
    r = await chat('native-tool-1', { messages, tools: [ADD_TOOL] });
  } catch (e) {
    record('native tool call', 'fail', describeError(e));
    findings.nativeTools = { error: e.message };
    return;
  }
  findings.nativeTool1 = shapeSummary(r);
  const call = r.toolCalls[0];
  if (!call) {
    record('native tool call', 'fail', `no tool_calls; finish=${r.finishReason}; content=${JSON.stringify(r.content.slice(0, 200))}`);
    return;
  }
  let args;
  try {
    args = parseArgs(call.arguments);
  } catch {
    record('native tool call', 'fail', `unparseable arguments: ${call.arguments}`);
    return;
  }
  record('native tool call', 'pass', `${call.name}(${JSON.stringify(args)}) id=${call.id || '(none)'} chunks=${r.toolCallChunks} shapes=${[...r.toolCallShapes]} finish=${r.finishReason}`);
  const id = call.id || 'call_0';
  messages.push({ role: 'assistant', content: r.content || null, tool_calls: [{ id, type: 'function', function: { name: call.name, arguments: call.arguments } }] });
  messages.push({ role: 'tool', tool_call_id: id, content: String(Number(args.a) + Number(args.b)) });
  const r2 = await chat('native-tool-2', { messages, tools: [ADD_TOOL] });
  findings.nativeTool2 = shapeSummary(r2);
  record('native tool result round-trip', /6,?912/.test(r2.content) ? 'pass' : 'warn', JSON.stringify(r2.content.trim().slice(0, 120)));
}

const TEXT_VARIANTS = [
  { id: 'qwen-tag-stop', open: '<tool_call>', close: '</tool_call>', stop: true },
  { id: 'qwen-tag-nostop', open: '<tool_call>', close: '</tool_call>', stop: false },
  { id: 'custom-tag', open: '<agent_tool>', close: '</agent_tool>', stop: false },
];

function textProtocol(v) {
  return `You can call tools. To call a tool, output exactly:
${v.open}
{"name": "<tool name>", "arguments": {<JSON arguments>}}
${v.close}
Then stop and wait. The result will arrive in a <tool_result> block.
Available tools:
- add: Add two integers. Arguments: {"a": integer, "b": integer}`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function testTextVariant(v) {
  const label = `text-protocol [${v.id}]`;
  const messages = [
    { role: 'system', content: `${textProtocol(v)}\nAlways use the add tool for arithmetic.` },
    { role: 'user', content: 'What is 4321 + 8765?' },
  ];
  const extra = v.stop ? { stop: [v.close] } : {};
  const r = await chat(`text-${v.id}-1`, { messages, ...extra });
  findings[`text-${v.id}-1`] = shapeSummary(r);
  const full = r.content.includes(v.open) && !r.content.includes(v.close) ? `${r.content}${v.close}` : r.content;
  const m = full.match(new RegExp(`${escapeRe(v.open)}\\s*([\\s\\S]*?)\\s*${escapeRe(v.close)}`));
  if (!m) {
    const bare = r.content.match(/\{\s*"name"[\s\S]*\}/);
    record(label, 'fail', `no ${v.open} in content: ${JSON.stringify(r.content.slice(0, 200))}${bare ? ' (bare JSON present: tags were stripped)' : ''}; reasoning mentions tag: ${r.reasoning.includes(v.open)}`);
    return;
  }
  let call;
  try {
    call = parseArgs(m[1]);
  } catch {
    record(label, 'fail', `bad JSON: ${m[1].slice(0, 200)}`);
    return;
  }
  record(label, 'pass', `${call.name}(${JSON.stringify(call.arguments)})`);
  messages.push({ role: 'assistant', content: full });
  messages.push({ role: 'user', content: `<tool_result name="add">${Number(call.arguments.a) + Number(call.arguments.b)}</tool_result>` });
  const r2 = await chat(`text-${v.id}-2`, { messages, ...extra });
  findings[`text-${v.id}-2`] = shapeSummary(r2);
  record(`${label} round-trip`, /13,?086/.test(r2.content) ? 'pass' : 'warn', JSON.stringify(r2.content.trim().slice(0, 120)));
}

async function testTextProtocol() {
  for (const v of TEXT_VARIANTS) {
    try {
      await testTextVariant(v);
    } catch (e) {
      record(`text-protocol [${v.id}]`, 'fail', describeError(e));
    }
  }
}

async function testAgentRoundTrip() {
  const dir = await mkdtemp(join(tmpdir(), 'owui smoke '));
  try {
    await writeFile(join(dir, 'greet.js'), "const word = 'Hello';\nconsole.log(`${word}, sovereign world`);\n");
    const messages = [
      {
        role: 'system',
        content: 'You are a coding agent working in a directory. Use the tools to act; do not guess file contents. Before each tool call, write one short sentence saying what you are doing. When finished, give a one-line summary.',
      },
      { role: 'user', content: "In greet.js change the greeting word from 'Hello' to 'Hi', then run it with `node greet.js` and tell me the exact output." },
    ];
    const trace = [];
    let finalText = '';
    for (let i = 0; i < 10; i++) {
      const r = await chat(`agent-${i + 1}`, { messages, tools: AGENT_TOOLS });
      if (!r.toolCalls.length) {
        finalText = r.content;
        break;
      }
      messages.push({
        role: 'assistant',
        content: r.content || null,
        tool_calls: r.toolCalls.map((c, j) => ({ id: c.id || `call_${i}_${j}`, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      for (const [j, c] of r.toolCalls.entries()) {
        let out;
        try {
          out = await execAgentTool(dir, c.name, parseArgs(c.arguments));
        } catch (e) {
          out = `Error: ${e.message}`;
        }
        trace.push(`${c.name}(${c.arguments.slice(0, 120)}) -> ${out.split('\n')[0].slice(0, 80)}`);
        messages.push({ role: 'tool', tool_call_id: c.id || `call_${i}_${j}`, content: out });
      }
    }
    const final = await readFile(join(dir, 'greet.js'), 'utf8');
    const edited = final.includes("'Hi'") && !final.includes("'Hello'");
    const ran = trace.some((t) => t.startsWith('run_command') && t.includes('exit 0'));
    findings.agent = { trace, finalText: finalText.slice(0, 300), edited, ran };
    record('agent read→edit→run round-trip', edited && ran && /Hi, sovereign world/.test(finalText) ? 'pass' : 'fail', `steps=${trace.length}; edited=${edited}; ran=${ran}; final=${JSON.stringify(finalText.trim().slice(0, 120))}`);
    for (const t of trace) process.stdout.write(`        ${t}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function testTruncation() {
  const sentence = 'The quick brown fox jumps over the lazy dog while the archivist catalogues unremarkable ledgers. ';
  const sizes = (process.env.OWUI_SMOKE_FILLER_REPEATS ?? '60,160').split(',').map(Number);
  for (const repeat of sizes) {
    const messages = [
      { role: 'system', content: 'Answer questions about the document precisely and briefly.' },
      { role: 'user', content: `DOCUMENT START. The vault code is MAGENTA-7741.\n${sentence.repeat(repeat)}\nDOCUMENT END.\nWhat is the vault code? Reply with only the code.` },
    ];
    const estimate = estimateTokens(messages);
    const name = `long prompt (~${estimate} est. tokens)`;
    const t0 = Date.now();
    try {
      const r = await chat(`truncation-${repeat}`, { messages });
      const recalled = /MAGENTA-7741/.test(r.content);
      findings[`truncation-${repeat}`] = { ...shapeSummary(r), estimate, recalled, check: checkTruncation(name, estimate, r.usage) };
      record(`${name}: needle recall`, recalled ? 'pass' : 'warn', JSON.stringify(r.content.trim().slice(0, 80)));
    } catch (e) {
      record(name, 'fail', `${describeError(e)} after ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
}

async function timeToFirstDelta(messages, { abortAfterDeltas } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = Date.now();
  let first;
  let deltas = 0;
  try {
    const res = await fetch(`${BASE}/api/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: MODEL, stream: true, messages }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const text = decoder.decode(r.value, { stream: true });
      const n = (text.match(/"(?:content|reasoning_content)":"[^"]/g) ?? []).length;
      if (n && first === undefined) first = Date.now() - started;
      deltas += n;
      if (abortAfterDeltas && deltas >= abortAfterDeltas) {
        controller.abort();
        break;
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  return { firstMs: first, totalMs: Date.now() - started, deltas };
}

async function testAbortPropagation() {
  const tiny = [{ role: 'user', content: 'Reply with exactly: ok' }];
  const baseline = await timeToFirstDelta(tiny);
  const long = [{ role: 'user', content: 'Write the numbers from 1 to 400 in words, one per line. Do not skip any.' }];
  const aborted = await timeToFirstDelta(long, { abortAfterDeltas: 8 });
  const after = await timeToFirstDelta(tiny);
  findings.abort = { baseline, aborted, after };
  const delay = (after.firstMs ?? Infinity) - (baseline.firstMs ?? 0);
  const propagates = delay < Math.max(15_000, (baseline.firstMs ?? 0) * 1.5);
  record(
    'stop propagates to the server',
    propagates ? 'pass' : 'warn',
    `first-token baseline ${baseline.firstMs}ms, after abort ${after.firstMs}ms${propagates ? '' : ' — the server kept generating after the client aborted'}`,
  );
}

async function main() {
  process.stdout.write(`OWUI smoke test → ${BASE}  model=${MODEL}\n`);
  if (!KEY) {
    process.stdout.write('OWUI_API_KEY is not set in this process environment. Set it and re-run.\n');
    process.exit(2);
  }
  await mkdir(FIXTURES, { recursive: true });
  const steps = [
    ['server', testServer],
    ['models', testModels],
    ['streamed chat', testStreamedChat],
    ['native tool', testNativeTool],
    ['text protocol', testTextProtocol],
    ['agent round-trip', testAgentRoundTrip],
    ['truncation', testTruncation],
    ['abort', testAbortPropagation],
  ];
  const only = process.env.OWUI_SMOKE_ONLY?.split(',').map((x) => x.trim());
  for (const [name, fn] of steps) {
    if (only && !['server', 'models'].includes(name) && !only.includes(name)) continue;
    try {
      const ok = await fn();
      if (ok === false && (name === 'server' || name === 'models')) break;
    } catch (e) {
      record(name, 'fail', describeError(e));
    }
  }
  await writeFile(join(FIXTURES, 'summary.json'), JSON.stringify({ base: BASE, model: MODEL, at: new Date().toISOString(), results, findings }, null, 2));
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  process.stdout.write(`\n${results.length - failed - warned} pass, ${warned} warn, ${failed} fail. Fixtures: ${FIXTURES}\n`);
  process.exit(failed ? 1 : 0);
}

main();
