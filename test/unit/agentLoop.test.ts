import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WARM_UP_PADDING, resumesFromCheckpoints, warmUpMessage } from '../../src/agent/session';
import { setLogger } from '../../src/log';
import type { WireMessage } from '../../src/owui/types';
import { createHarness, tools, type Harness, type HarnessOptions } from '../helpers/agent';
import { MockOwui, sseChunks } from '../mock-owui/server';

const KEY = 'sk-loop';
const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
let mock: MockOwui;
let h: Harness | undefined;

beforeEach(async () => {
  mock = new MockOwui({ apiKey: KEY });
  await mock.start();
});

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  await mock.stop();
});

async function harness(opts: Partial<HarnessOptions> = {}): Promise<Harness> {
  h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, ...opts });
  return h;
}

function body(i: number): { messages: WireMessage[]; tools?: unknown[]; params?: unknown } {
  return mock.chatRequests()[i]!.body as never;
}

const say = (content: string) => ({ kind: 'sse' as const, chunks: sseChunks({ content }) });
const call = (content: string, ...calls: { name: string; arguments: object | string; id?: string }[]) => ({ kind: 'sse' as const, chunks: sseChunks({ content, toolCalls: calls }) });

describe('agent loop (native tool calls)', () => {
  it('reads, edits with approval, runs a command with approval, and reports', async () => {
    const t = await harness({ mode: 'ask' });
    await writeFile(path.join(t.workspace, 'greet.js'), "const word = 'Hello';\nconsole.log(`${word}, world`);\n");
    mock.enqueue(
      call('Reading the file first.', { name: 'read_file', arguments: { path: 'greet.js' }, id: 'c1' }),
      call('Changing the greeting.', { name: 'edit_file', arguments: { path: 'greet.js', old_string: "'Hello'", new_string: "'Hi'" }, id: 'c2' }),
      call('Running it.', { name: 'run_command', arguments: { command: `${node} greet.js`, description: 'Run the script' }, id: 'c3' }),
      say('It prints "Hi, world". Tested: ran the script. Not tested: nothing else.'),
    );
    await t.session.send('Change Hello to Hi and run it', t.ctx);

    expect(await readFile(path.join(t.workspace, 'greet.js'), 'utf8')).toContain("'Hi'");
    expect(t.approvalsSeen.map((a) => a.approval?.kind)).toEqual(['edit', 'command']);
    expect(t.approvalsSeen[0]!.diff).toContain("+const word = 'Hi';");
    expect(tools(t.session).map((c) => [c.tool, c.status])).toEqual([
      ['read_file', 'done'],
      ['edit_file', 'done'],
      ['run_command', 'done'],
    ]);
    const final = body(3).messages;
    const toolMsgs = final.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2', 'c3']);
    expect(String(toolMsgs[2]!.content)).toContain('Hi, world');
    expect(final.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])).toEqual(['c1', 'c2', 'c3']);
    expect(body(0).tools?.length).toBeGreaterThan(10);
    expect(t.session.busy).toBe(false);
  });

  it('auto mode applies workspace edits without asking but still asks for commands', async () => {
    const t = await harness({ mode: 'auto' });
    mock.enqueue(
      call('', { name: 'write_file', arguments: { path: 'a.txt', content: 'x' } }, { name: 'run_command', arguments: { command: 'echo hi', description: 'Echo' } }),
      say('done'),
    );
    await t.session.send('go', t.ctx);
    expect(t.approvalsSeen.map((a) => a.approval?.kind)).toEqual(['command']);
  });

  it('always asks before writing outside the workspace, even in auto mode', async () => {
    const t = await harness({ mode: 'auto', approve: () => ({ decision: 'deny', feedback: 'stay in the workspace' }) });
    const outside = path.join(path.dirname(t.workspace), 'owui-outside-write.txt');
    mock.enqueue(call('', { name: 'write_file', arguments: { path: outside, content: 'x' } }), say('ok, staying inside'));
    await t.session.send('go', t.ctx);
    expect(t.approvalsSeen[0]!.approval?.warnings[0]).toMatch(/outside the workspace/);
    expect(String(body(1).messages.at(-1)!.content)).toContain('stay in the workspace');
  });

  it('stops the loop when the user denies without feedback', async () => {
    const t = await harness({ approve: () => ({ decision: 'deny' }) });
    mock.enqueue(
      call('', { name: 'run_command', arguments: { command: 'git push', description: 'Push' } }, { name: 'read_file', arguments: { path: '.' } }),
      say('should not be requested'),
    );
    await t.session.send('push it', t.ctx);
    expect(mock.chatRequests()).toHaveLength(1);
    expect(tools(t.session).map((c) => c.status)).toEqual(['denied']);
    expect(t.approvalsSeen[0]!.approval?.warnings.join(' ')).toMatch(/Git history/);
    const wire = t.session.wireMessages();
    expect(wire.filter((m) => m.role === 'tool').map((m) => String(m.content))).toEqual([expect.stringMatching(/denied/), expect.stringMatching(/Not run because/)]);
    expect(t.session.canResume()).toBe(true);
  });

  it('"always allow" adds the command to the allowlist and skips approval next time', async () => {
    let approvals = 0;
    const t = await harness({ approve: () => (approvals++, { decision: 'allowAlways' }) });
    mock.enqueue(
      call('', { name: 'run_command', arguments: { command: 'echo one', description: 'Echo' } }),
      call('', { name: 'run_command', arguments: { command: 'echo two', description: 'Echo' } }),
      say('done'),
    );
    await t.session.send('go', t.ctx);
    expect(t.allowlist).toEqual(['echo']);
    expect(approvals).toBe(1);
  });

  it('answers every tool call, in order, even when something outside the tool throws mid-batch', async () => {
    const t = await harness({ approve: () => ({ decision: 'allowAlways' }) });
    t.ctx.addAllowlistEntry = async () => {
      throw new Error('settings.json is read-only');
    };
    mock.enqueue(
      call('', { name: 'read_file', arguments: { path: '.' } }, { name: 'run_command', arguments: { command: 'echo hi', description: 'Echo' } }, { name: 'glob', arguments: { pattern: '*' } }),
      say('recovered'),
    );
    await t.session.send('go', t.ctx);
    const next = body(1).messages;
    const assistant = next.findIndex((m) => m.role === 'assistant' && !!m.tool_calls?.length);
    const ids = next[assistant]!.tool_calls!.map((c) => c.id);
    expect(next.slice(assistant + 1, assistant + 4).map((m) => (m as { tool_call_id?: string }).tool_call_id)).toEqual(ids);
    expect(String(next[assistant + 2]!.content)).toMatch(/run_command failed: settings.json is read-only/);
    expect(tools(t.session).map((c) => c.status)).toEqual(['done', 'error', 'done']);
    expect(t.session.busy).toBe(false);
  });

  it('returns helpful errors for unknown tools, bad JSON and invalid arguments, then continues', async () => {
    const t = await harness();
    mock.enqueue(
      call('', { name: 'teleport', arguments: {} }, { name: 'read_file', arguments: '{"path": ' }, { name: 'read_file', arguments: { limit: 'many' } }),
      say('recovered'),
    );
    await t.session.send('go', t.ctx);
    const results = body(1).messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(results[0]).toMatch(/Unknown tool "teleport". Available tools: read_file/);
    expect(results[1]).toMatch(/not valid JSON/);
    expect(results[2]).toMatch(/path is required.*limit must be an integer/);
  });

  it('refuses to run the same call a third time in a row', async () => {
    const t = await harness();
    const same = () => call('', { name: 'read_file', arguments: { path: '.' } });
    mock.enqueue(same(), same(), same(), say('giving up on that'));
    await t.session.send('go', t.ctx);
    expect(tools(t.session).map((c) => c.status)).toEqual(['done', 'done', 'error']);
    expect(String(body(3).messages.at(-1)!.content)).toMatch(/identical arguments 3 times/);
  });

  it('pauses after maxIterations and resumes on continue', async () => {
    const t = await harness({ maxIterations: 2 });
    mock.enqueue(
      call('', { name: 'read_file', arguments: { path: '.' } }),
      call('', { name: 'glob', arguments: { pattern: '*' } }),
      say('finished after continuing'),
    );
    await t.session.send('go', t.ctx);
    const err = t.session.transcript.at(-1);
    expect(err?.kind === 'error' && err.action).toBe('continue');
    expect(t.session.canResume()).toBe(true);
    await t.session.resume(t.ctx);
    expect(t.session.transcript.filter((x) => x.kind === 'assistant').at(-1)).toMatchObject({ text: 'finished after continuing' });
  });

  it('sends images from view_image to the next turn as image parts', async () => {
    const t = await harness({ vision: true, override: { vision: true } });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await writeFile(path.join(t.workspace, 'shot.png'), png);
    mock.enqueue(call('', { name: 'view_image', arguments: { path: 'shot.png' } }), say('I see a tiny image.'));
    await t.session.send('look', t.ctx);
    const last = body(1).messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
  });

  it('asks the user questions and records the todo list', async () => {
    const t = await harness({ answer: () => [['Supabase']] });
    mock.enqueue(
      call('', { name: 'todo_write', arguments: { todos: [{ content: 'Plan', status: 'in_progress' }, { content: 'Build', status: 'pending' }] } }),
      call('', { name: 'ask_user', arguments: { questions: [{ question: 'Which backend?', options: ['Supabase', 'Firebase'] }] } }),
      say('Using Supabase.'),
    );
    await t.session.send('build it', t.ctx);
    expect(t.session.todos.map((x) => x.status)).toEqual(['in_progress', 'pending']);
    expect(String(body(2).messages.at(-1)!.content)).toBe('Q: Which backend?\nA: Supabase');
    expect(t.session.transcript.find((x) => x.kind === 'question')).toMatchObject({ status: 'answered', answers: [['Supabase']] });
  });

  it('runs batched calls in one turn, with task list updates riding along with real work', async () => {
    const t = await harness({ mode: 'auto' });
    mock.enqueue(
      call(
        '',
        { name: 'todo_write', arguments: { todos: [{ content: 'Write a', status: 'in_progress' }, { content: 'Write b', status: 'pending' }] }, id: 't1' },
        { name: 'write_file', arguments: { path: 'a.txt', content: 'a' }, id: 'w1' },
        { name: 'write_file', arguments: { path: 'b.txt', content: 'b' }, id: 'w2' },
        { name: 'todo_write', arguments: { update: [{ item: 1, status: 'completed' }, { item: 2, status: 'completed' }] }, id: 't2' },
      ),
      say('Both files written.'),
    );
    await t.session.send('write a and b', t.ctx);
    expect(mock.chatRequests()).toHaveLength(2);
    expect(await readFile(path.join(t.workspace, 'a.txt'), 'utf8')).toBe('a');
    expect(await readFile(path.join(t.workspace, 'b.txt'), 'utf8')).toBe('b');
    expect(t.session.todos.map((x) => x.status)).toEqual(['completed', 'completed']);
    const results = body(1).messages.filter((m) => m.role === 'tool');
    expect(results.map((m) => m.tool_call_id)).toEqual(['t1', 'w1', 'w2', 't2']);
    expect(String(results[3]!.content)).toBe('Task list (2/2 done):\n1. [x] Write a\n2. [x] Write b');
  });

  it('ends a run with a summary of files, commands and warnings that is never sent to the model', async () => {
    const t = await harness({ mode: 'auto', allowlist: ['node'] });
    await writeFile(path.join(t.workspace, 'old.txt'), 'old');
    mock.enqueue(
      call(
        '',
        { name: 'write_file', arguments: { path: 'new.txt', content: 'n' } },
        { name: 'write_file', arguments: { path: 'old.txt', content: 'changed' } },
      ),
      call('', { name: 'run_command', arguments: { command: `${node} -e "console.log('2 vulnerabilities (1 high, 1 critical)')"`, description: 'Check' } }),
      call('', { name: 'run_command', arguments: { command: `${node} -e "process.exit(3)"`, description: 'Fail' } }),
      say('All done and fully tested.'),
    );
    await t.session.send('go', t.ctx);
    const items = t.session.transcript;
    const summary = items.at(-1)!;
    expect(items.at(-2)).toMatchObject({ kind: 'assistant', text: 'All done and fully tested.' });
    expect(summary.kind).toBe('summary');
    if (summary.kind !== 'summary') return;
    expect(summary.files.map((f) => [f.display, f.action])).toEqual([
      ['new.txt', 'added'],
      ['old.txt', 'modified'],
    ]);
    expect(summary.commands.map((c) => c.exitCode)).toEqual([0, 3]);
    expect(summary.warnings).toEqual([expect.stringMatching(/failed \(exit 3\)/), 'npm audit reports 2 vulnerabilities (1 high, 1 critical).']);
    expect(summary.unverified).toBe(false);
    expect(JSON.stringify(t.session.wireMessages())).not.toContain('npm audit reports');

    // The next request gets its own summary; a read-only one gets none.
    mock.enqueue(call('', { name: 'read_file', arguments: { path: 'new.txt' } }), say('It says n.'));
    await t.session.send('what is in new.txt?', t.ctx);
    expect(t.session.transcript.filter((x) => x.kind === 'summary')).toHaveLength(1);
    expect(t.session.transcript.at(-1)).toMatchObject({ kind: 'assistant' });
  });

  it('keeps one summary for a request that was paused and continued, and flags unchecked changes', async () => {
    const t = await harness({ mode: 'auto', maxIterations: 1 });
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'a.txt', content: 'a' } }));
    await t.session.send('write a and b', t.ctx);
    expect(t.session.transcript.filter((x) => x.kind === 'summary')).toHaveLength(1);
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'b.txt', content: 'b' } }));
    await t.session.resume(t.ctx);
    const summaries = t.session.transcript.filter((x) => x.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.kind === 'summary' && summaries[0]!.files.map((f) => f.display)).toEqual(['a.txt', 'b.txt']);
    expect(summaries[0]!.kind === 'summary' && summaries[0]!.unverified).toBe(true);
  });

  it('cancels a running command on stop and keeps the conversation consistent', async () => {
    const t = await harness({ mode: 'auto', allowlist: ['*'] });
    mock.enqueue(call('', { name: 'run_command', arguments: { command: `${node} -e "setInterval(() => {}, 1000)"`, description: 'Hang', timeout_seconds: 60 } }));
    const p = t.session.send('hang', t.ctx);
    while (tools(t.session)[0]?.status !== 'running') await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 500));
    t.session.stop();
    await p;
    expect(tools(t.session)[0]!.status).toBe('cancelled');
    const wire = t.session.wireMessages();
    expect(wire.at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/cancel/i) });
    expect(t.session.busy).toBe(false);
  });

  it('always sends num_ctx: the configured size, else the size Open WebUI reports', async () => {
    const t = await harness({ override: { contextSize: 16384 } });
    mock.enqueue(say('a'));
    await t.session.send('hi', t.ctx);
    expect(body(0).params).toEqual({ num_ctx: 16384 });
    await h?.cleanup();
    const u = await harness({ contextSize: 24576 });
    mock.enqueue(say('b'));
    await u.session.send('hi', u.ctx);
    expect(body(1).params).toEqual({ num_ctx: 24576 });
  });

  it('warms up with the same instructions, tools and model settings as the first real request', async () => {
    const t = await harness({ override: { thinking: false, contextSize: 16384 } });
    mock.enqueue(say('.'), say('hello'));
    const keys: string[] = [];
    expect(await t.session.warmUp(t.ctx, { skip: (k) => (keys.push(k), false) })).toBe(true);
    expect(await t.session.warmUp(t.ctx, { skip: (k) => keys.includes(k) })).toBe(false);
    expect(mock.chatRequests()).toHaveLength(1);
    const warm = mock.chatRequests()[0]!.body as { messages: WireMessage[]; tools: unknown[]; params: unknown; max_tokens: number };
    expect(warm.max_tokens).toBe(1);
    await t.session.send('hi', t.ctx);
    const real = body(1);
    expect(warm.messages[0]).toEqual(real.messages[0]);
    expect(warm.tools).toEqual(real.tools);
    expect(warm.params).toEqual(real.params);
    expect(t.session.transcript.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  });

  it('pads the warm-up for models that resume from checkpoints, and warms each session separately', async () => {
    expect(resumesFromCheckpoints('qwen3.5:9b')).toBe(true);
    expect(resumesFromCheckpoints('qwen3.6:27b')).toBe(true);
    expect(resumesFromCheckpoints('qwen3.5-bench:latest')).toBe(true);
    expect(resumesFromCheckpoints('qwen3:8b')).toBe(false);
    expect(resumesFromCheckpoints('llama3.1:8b')).toBe(false);
    expect(warmUpMessage(false)).toBe('Hi');
    const padding = warmUpMessage(true);
    expect(padding.split(' ')).toHaveLength(WARM_UP_PADDING);
    expect(new Set(padding.split(' '))).toEqual(new Set(['ok']));

    const t = await harness({ modelId: 'qwen3.5:9b' });
    mock.enqueue(say('.'));
    const keys: string[] = [];
    await t.session.warmUp(t.ctx, { skip: (k) => (keys.push(k), false) });
    expect((mock.chatRequests()[0]!.body as { messages: WireMessage[] }).messages[1]).toEqual({ role: 'user', content: padding });
    await h?.cleanup();
    const u = await harness({ modelId: 'qwen3.5:9b' });
    await u.session.warmUp(u.ctx, { skip: (k) => (keys.push(k), true) });
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('times each tool and logs timings without arguments', async () => {
    const lines: string[] = [];
    setLogger({ info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) });
    try {
      const t = await harness({ mode: 'ask' });
      mock.enqueue(
        call('', { name: 'run_command', arguments: { command: `${node} -e "setTimeout(() => {}, 300)"`, description: 'Wait a moment' } }),
        say('done'),
      );
      await t.session.send('go', t.ctx);
      const card = tools(t.session)[0]!;
      expect(card.status).toBe('done');
      expect(card.durationMs).toBeGreaterThanOrEqual(250);
      expect(card.waitedMs).toBeGreaterThanOrEqual(0);
      const toolLine = lines.find((l) => l.startsWith('Tool run_command:'));
      expect(toolLine).toMatch(/^Tool run_command: done, ran \d+\.\ds, waited \d+\.\ds for approval, exit 0\.$/);
      expect(lines.join('\n')).not.toContain('setTimeout');
      expect(lines.filter((l) => /^mock-model: .*first response after \d+\.\ds/.test(l))).toHaveLength(2);
      expect(lines.find((l) => l.startsWith('Run finished in'))).toMatch(/2 model turn\(s\) .*, tools .*, waiting for approval /);
    } finally {
      setLogger(undefined);
    }
  });

  it('keeps the instructions identical across sessions and sends the scratchpad path once, as a note', async () => {
    const a = await harness();
    mock.enqueue(say('one'), say('two'));
    await a.session.send('first', a.ctx);
    await a.session.send('second', a.ctx);
    const scratchA = a.session.scratchpad;
    const workspaceA = a.workspace;
    await h?.cleanup();
    const b = await harness();
    mock.enqueue(say('three'));
    await b.session.send('first', b.ctx);
    expect(b.session.scratchpad).not.toBe(scratchA);
    const [a1, a2, b1] = [body(0), body(1), body(2)];
    // Each test harness has its own workspace folder; real sessions in one window share it.
    const system = (m: WireMessage, workspace: string) => String(m.content).replace(workspace, '<workspace>');
    expect(system(b1.messages[0]!, b.workspace)).toBe(system(a1.messages[0]!, workspaceA));
    expect(b1.tools).toEqual(a1.tools);
    expect(String(a1.messages[0]!.content)).not.toContain(scratchA);
    expect(String(a1.messages[1]!.content)).toContain(`[Session scratchpad: ${scratchA}]`);
    expect(String(b1.messages[1]!.content)).toContain(`[Session scratchpad: ${b.session.scratchpad}]`);
    expect(String(a2.messages.at(-1)!.content)).toBe('second');
  });

  it('sends params.think=false when thinking is turned off for the model', async () => {
    const t = await harness({ override: { thinking: false } });
    mock.enqueue(say('fast answer'));
    await t.session.send('hi', t.ctx);
    expect(body(0).params).toEqual({ think: false, num_ctx: 32768 });
  });

  it('shows an answer that arrived only as reasoning and never sends an empty assistant message', async () => {
    const t = await harness();
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: '', reasoning: 'It is 55°F and sunny in Medford.' }) }, say('ok'));
    await t.session.send('Weather?', t.ctx);
    const answer = t.session.transcript.find((i) => i.kind === 'assistant');
    expect(answer && 'text' in answer ? answer.text : '').toBe('It is 55°F and sunny in Medford.');
    await t.session.send('Thanks', t.ctx);
    const sent = body(1).messages.filter((m) => m.role === 'assistant');
    expect(sent.map((m) => m.content)).toEqual(['It is 55°F and sunny in Medford.']);
  });

  it('repairs a saved session that holds an assistant message with no content and no tool calls', async () => {
    const t = await harness();
    const record = structuredClone(t.session.toRecord('old', undefined, 'ask'));
    record.wire.push({ role: 'user', content: 'What is the weather?' }, { role: 'assistant', content: null });
    t.session.restore(record);
    mock.enqueue(say('55°F'));
    await t.session.send('Just the temperature', t.ctx);
    expect(body(0).messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(t.session.transcript.some((i) => i.kind === 'error')).toBe(false);
  });
});

describe('agent loop (models without tool support)', () => {
  it('reports a clear error, once, when the server rejects native tools', async () => {
    const t = await harness();
    mock.enqueue({ kind: 'json', status: 400, body: { detail: 'registry.ollama.ai/library/old-model does not support tools' } });
    await t.session.send('list', t.ctx);
    expect(mock.chatRequests()).toHaveLength(1);
    expect(body(0).tools).toBeDefined();
    const errors = t.session.transcript.filter((i) => i.kind === 'error').map((i) => (i as { text: string }).text);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/does not support tool calling/);
    expect(t.session.transcript.some((i) => i.kind === 'assistant')).toBe(false);
  });
});
