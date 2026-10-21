import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUMMARY_PREFIX } from '../../src/agent/compaction';
import type { WireMessage } from '../../src/owui/types';
import { createHarness, tools, type Harness, type HarnessOptions } from '../helpers/agent';
import { MockOwui, sseChunks } from '../mock-owui/server';

const KEY = 'sk-knowledge';
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

const body = (i: number) => mock.chatRequests()[i]!.body as { messages: WireMessage[]; tools?: unknown[] };
const system = (i: number) => String(body(i).messages[0]!.content);
const say = (content: string) => ({ kind: 'sse' as const, chunks: sseChunks({ content }) });
const call = (content: string, ...calls: { name: string; arguments: object }[]) => ({ kind: 'sse' as const, chunks: sseChunks({ content, toolCalls: calls }) });

describe('memory and skills in the system prompt', () => {
  it('includes AGENTS.md, the memory index and skills, and returns the task list in the tool result', async () => {
    const t = await harness({ mode: 'ask' });
    await writeFile(path.join(t.workspace, 'AGENTS.md'), 'Always use pnpm.');
    await mkdir(path.join(t.workspace, '.owui', 'memory'), { recursive: true });
    await writeFile(path.join(t.workspace, '.owui', 'memory', 'MEMORY.md'), '# Project memory\n- [build](build.md) — pnpm test runs vitest\n');
    await mkdir(path.join(t.workspace, '.owui', 'skills', 'viz'), { recursive: true });
    await writeFile(path.join(t.workspace, '.owui', 'skills', 'viz', 'SKILL.md'), '---\nname: dataviz\ndescription: Charts with accessible palettes\n---\nBody');
    mock.enqueue(
      call('', { name: 'todo_write', arguments: { todos: [{ content: 'Write schema', status: 'in_progress' }] } }),
      call('', { name: 'load_skill', arguments: { name: 'dataviz' } }),
      say('ok'),
    );
    await t.session.send('build a dashboard', t.ctx);
    expect(system(0)).toContain('Always use pnpm.');
    expect(system(0)).toContain('pnpm test runs vitest');
    expect(system(0)).toContain('- dataviz: Charts with accessible palettes');
    expect(system(1)).toBe(system(0));
    expect(system(1)).not.toContain('Write schema');
    expect(String(body(1).messages.at(-1)!.content)).toContain('- [~] Write schema');
    expect(String(body(2).messages.at(-1)!.content)).toContain('Body');
  });

  it('offers load_skill only when skills exist', async () => {
    const t = await harness({ mode: 'ask' });
    mock.enqueue(say('ok'));
    await t.session.send('hi', t.ctx);
    expect((body(0).tools as { function: { name: string } }[]).map((d) => d.function.name)).not.toContain('load_skill');
  });

  it('saves memory through update_memory with an approval in ask mode, without changing the system prompt', async () => {
    const t = await harness({ mode: 'ask' });
    mock.enqueue(call('', { name: 'update_memory', arguments: { topic: 'build', content: 'Run pnpm test', summary: 'Testing' } }), say('saved'));
    await t.session.send('remember how to test', t.ctx);
    expect(t.approvalsSeen.map((a) => a.tool)).toEqual(['update_memory']);
    expect(t.createdDirs).toEqual([path.join(t.workspace, '.owui')]);
    expect(await readFile(path.join(t.workspace, '.owui', 'memory', 'MEMORY.md'), 'utf8')).toContain('- [build](build.md) — Testing');
    mock.enqueue(say('next'));
    await t.session.send('again', t.ctx);
    expect(system(2)).toBe(system(0));
  });
});

describe('automatic compaction', () => {
  const longAnswer = (i: number) => `Step ${i}: ${'lorem ipsum dolor sit amet '.repeat(220)}`;

  it('summarizes older turns before a request that would not fit, then continues', async () => {
    const t = await harness({ override: { contextSize: 13000 } });
    for (let i = 0; i < 4; i++) {
      mock.enqueue(say(longAnswer(i)));
      await t.session.send(`question ${i}`, t.ctx);
    }
    const before = mock.chatRequests().length;
    mock.enqueue(say('- Goal: answer questions\n- State: four answers given'), say('final answer'));
    await t.session.send('question 4', t.ctx);
    const summaryReq = body(before);
    expect(summaryReq.tools).toBeUndefined();
    expect(String(summaryReq.messages[0]!.content)).toMatch(/compress the history of a coding session/);
    expect(String(summaryReq.messages[1]!.content)).toMatch(/USER:\n\[Permission mode: ask before acting[^\]]*\]\n\nquestion 0/);
    const turn = body(before + 1);
    expect(String(turn.messages[1]!.content).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(String(turn.messages[1]!.content)).toContain('four answers given');
    expect(turn.messages.at(-1)).toEqual({ role: 'user', content: 'question 4' });
    expect(t.session.transcript.some((x) => x.kind === 'notice' && /summarized \d+ earlier messages/.test(x.text))).toBe(true);
    expect(t.session.transcript.filter((x) => x.kind === 'user')).toHaveLength(5);
  });

  it('keeps the conversation unchanged when summarizing fails', async () => {
    const t = await harness({ override: { contextSize: 13000 }, maxRetries: 0 });
    for (let i = 0; i < 4; i++) {
      mock.enqueue(say(longAnswer(i)));
      await t.session.send(`question ${i}`, t.ctx);
    }
    const wireBefore = JSON.stringify(t.session.wireMessages());
    mock.enqueue({ kind: 'json', status: 500, body: { detail: 'summary model crashed' } }, say('answered anyway'));
    await t.session.send('question 4', t.ctx);
    expect(t.session.transcript.some((x) => x.kind === 'notice' && /Compaction failed: .*summary model crashed/.test(x.text))).toBe(true);
    expect(JSON.stringify(t.session.wireMessages().slice(0, -2))).toBe(wireBefore);
  });

  it('/compact summarizes on demand and rewinding a compacted message only restores code', async () => {
    const t = await harness({ mode: 'auto' });
    await writeFile(path.join(t.workspace, 'a.txt'), 'v1');
    mock.enqueue(call('', { name: 'write_file', arguments: { path: 'a.txt', content: 'v2' } }), say('first'));
    await t.session.send('first request', t.ctx);
    mock.enqueue(say('second'));
    await t.session.send('second request', t.ctx);
    mock.enqueue(say('- Summary of the first request'));
    await t.session.compactNow(t.ctx);
    const wire = t.session.wireMessages();
    expect(String(wire[0]!.content).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(wire.some((m) => m.content === 'second request')).toBe(true);
    expect(wire.some((m) => m.content === 'first request')).toBe(false);

    const [first, second] = t.session.transcript.filter((x) => x.kind === 'user');
    const res = await t.session.rewind(first!.id, 'both');
    expect(res?.text).toBe('');
    expect(t.session.transcript.some((x) => x.kind === 'warning' && /compacted into a summary/.test(x.text))).toBe(true);
    const back = await t.session.rewind(second!.id, 'conversation');
    expect(back?.text).toBe('second request');
    expect(t.session.wireMessages().some((m) => m.content === 'second request')).toBe(false);
    expect(String(t.session.wireMessages()[0]!.content).startsWith(SUMMARY_PREFIX)).toBe(true);
  });
});

describe('saving and resuming sessions', () => {
  it('round-trips a session and repairs interrupted state', async () => {
    const t = await harness({ approve: () => undefined });
    mock.enqueue(call('', { name: 'run_command', arguments: { command: 'echo hi', description: 'Echo' } }));
    const pending = t.session.send('run something', t.ctx);
    while (!tools(t.session).some((c) => c.status === 'awaiting-approval')) await new Promise((r) => setTimeout(r, 20));
    const record = structuredClone(t.session.toRecord('Run something', 'mock-model', 'ask'));
    t.session.stop();
    await pending;

    const r = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY });
    try {
      r.session.restore(record);
      expect(r.session.id).not.toBe(record.id);
      const card = tools(r.session)[0]!;
      expect(card.status).toBe('cancelled');
      expect(card.approval).toBeUndefined();
      const wire = r.session.wireMessages();
      const callId = wire.find((m) => m.tool_calls)?.tool_calls?.[0]?.id;
      expect(wire.at(-1)).toMatchObject({ role: 'tool', tool_call_id: callId, content: expect.stringMatching(/Not run/) });
      expect(r.session.canResume()).toBe(true);
      mock.enqueue(say('resumed fine'));
      await r.session.resume(r.ctx);
      expect(r.session.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'resumed fine' });
    } finally {
      await r.cleanup();
    }
  });
});
