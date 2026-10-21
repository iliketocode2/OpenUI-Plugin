import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function body(i: number): { messages: WireMessage[]; tools?: unknown[]; stop?: string[]; params?: unknown } {
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

describe('agent loop (text tool protocol)', () => {
  it('runs tools from <agent_tool> blocks and returns <tool_result> blocks', async () => {
    const t = await harness({ override: { toolMode: 'text' }, mode: 'auto', allowlist: ['echo'] });
    mock.enqueue(
      say('Creating the file.\n<agent_tool>\n{"name": "write_file", "arguments": {"path": "t.txt", "content": "hello"}}\n</agent_tool>'),
      say('Checking.\n<agent_tool>{"name":"run_command","arguments":{"command":"echo checked","description":"Echo"}}</agent_tool>'),
      say('All done.'),
    );
    await t.session.send('make t.txt', t.ctx);
    expect(await readFile(path.join(t.workspace, 't.txt'), 'utf8')).toBe('hello');
    expect(body(0).tools).toBeUndefined();
    expect(body(0).stop).toEqual(['<tool_result']);
    expect(String(body(0).messages[0]!.content)).toContain('<agent_tool>');
    const results = String(body(1).messages.at(-1)!.content);
    expect(results).toMatch(/^<tool_result name="write_file" id="[^"]+">\nCreated t.txt/);
    expect(String(body(2).messages.at(-1)!.content)).toContain('checked');
    const shown = t.session.transcript.filter((x) => x.kind === 'assistant').map((x) => (x as { text: string }).text);
    expect(shown).toEqual(['Creating the file.\n', 'Checking.\n', 'All done.']);
    expect(shown.join('')).not.toContain('agent_tool');
  });

  it('switches automatically when the server rejects native tools', async () => {
    const t = await harness();
    mock.enqueue(
      { kind: 'json', status: 400, body: { detail: 'registry.ollama.ai/library/old-model does not support tools' } },
      say('<agent_tool>{"name":"read_file","arguments":{"path":"."}}</agent_tool>'),
      say('listed'),
    );
    await t.session.send('list', t.ctx);
    expect(t.textModeSwitches).toBe(1);
    expect(body(0).tools).toBeDefined();
    expect(body(1).tools).toBeUndefined();
    expect(tools(t.session).map((c) => c.status)).toEqual(['done']);
    expect(t.warnings.join(' ')).toMatch(/text-based tool protocol/);
  });
});
