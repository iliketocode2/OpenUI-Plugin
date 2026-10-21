import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/shared/protocol';
import { createHarness, type Harness } from '../helpers/agent';
import { MockOwui, sseChunks } from '../mock-owui/server';

const KEY = 'sk-stop';
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

const call = (name: string, args: object) => ({ kind: 'sse' as const, chunks: sseChunks({ content: '', toolCalls: [{ name, arguments: args }] }) });

async function stopWhile(kind: TranscriptItem['kind'], isWaiting: (t: TranscriptItem) => boolean, mode: 'ask', reply: ReturnType<typeof call>) {
  h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, mode, approve: () => undefined });
  mock.enqueue(reply);
  const run = h.session.send('go', h.ctx);
  while (!h.session.transcript.some((t) => t.kind === kind && isWaiting(t))) await new Promise((r) => setTimeout(r, 20));
  h.session.stop();
  await run;
  expect(h.session.busy).toBe(false);
  expect(mock.chatRequests()).toHaveLength(1);
  return h.session.transcript.find((t) => t.kind === kind)!;
}

describe('Stop while the agent waits for the user', () => {
  it('ends a pending approval as cancelled', async () => {
    const card = await stopWhile('tool', (t) => t.kind === 'tool' && t.status === 'awaiting-approval', 'ask', call('run_command', { command: 'echo hi', description: 'Echo' }));
    expect(card).toMatchObject({ status: 'cancelled' });
  });

  it('ends an open question as cancelled', async () => {
    const q = await stopWhile('question', (t) => t.kind === 'question' && t.status === 'open', 'ask', call('ask_user', { questions: [{ question: 'Which?' }] }));
    expect(q).toMatchObject({ status: 'cancelled' });
  });
});
