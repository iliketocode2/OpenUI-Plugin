import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Egress, EgressBlockedError } from '../../src/net/egress';
import { OwuiClient, type RetryInfo } from '../../src/owui/client';
import { HttpError, MissingApiKeyError, StallError, isAbortError } from '../../src/owui/errors';
import type { StreamDelta } from '../../src/owui/streamAssembler';
import { MockOwui, loadFixture, sseChunks } from '../mock-owui/server';

const KEY = 'sk-test';
let mock: MockOwui;

function client(opts: { key?: string | undefined; stallMs?: number; firstMs?: number; retries?: number } = {}) {
  const egress = new Egress(() => mock.baseUrl);
  const key = 'key' in opts ? opts.key : KEY;
  return new OwuiClient(egress, async () => key, {
    stallTimeoutMs: () => opts.stallMs ?? 5000,
    firstResponseTimeoutMs: () => opts.firstMs ?? opts.stallMs ?? 5000,
    maxRetries: () => opts.retries ?? 2,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
  });
}

const req = { model: 'mock-model', messages: [{ role: 'user' as const, content: 'hi' }] };

beforeEach(async () => {
  mock = new MockOwui({ apiKey: KEY });
  await mock.start();
});

afterEach(async () => {
  await mock.stop();
});

describe('OwuiClient', () => {
  it('lists models and reads the server version with bearer auth', async () => {
    const c = client();
    expect((await c.listModels()).map((m) => m.id)).toEqual(['mock-model']);
    expect(await c.version()).toBe('0.12.0');
    expect(mock.requests.find((r) => r.path === '/api/models')?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('streams content and reasoning deltas and returns the assembled turn', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ reasoning: 'thinking hard', content: 'Hello there', usage: { prompt_tokens: 9, completion_tokens: 3 } }) });
    const deltas: StreamDelta[] = [];
    const turn = await client().chat(req, { onDelta: (d) => deltas.push(d) });
    expect(turn).toMatchObject({ content: 'Hello there', reasoning: 'thinking hard', finishReason: 'stop', usage: { promptTokens: 9 } });
    expect(deltas.filter((d) => d.kind === 'content').map((d) => d.text).join('')).toBe('Hello there');
    const sent = mock.chatRequests()[0]!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ model: 'mock-model', stream: true });
    expect(sent).not.toHaveProperty('chat_id');
    expect(sent).not.toHaveProperty('id');
  });

  it('replays a recorded live stream delivered in small network chunks', async () => {
    mock.enqueue({ kind: 'raw', text: loadFixture('live/native-tool-1.response.sse'), chunkSize: 7 });
    const turn = await client().chat({ ...req, tools: [{ type: 'function', function: { name: 'add', description: '', parameters: {} } }] });
    expect(turn.toolCalls.map((t) => t.name)).toEqual(['add']);
    expect((mock.chatRequests()[0]!.body as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it('handles a non-streamed JSON response when the server disables streaming', async () => {
    mock.enqueue({ kind: 'json', body: { choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }] } });
    expect((await client().chat(req)).content).toBe('plain');
  });

  it('retries 5xx and 429 with Retry-After, then succeeds', async () => {
    mock.enqueue(
      { kind: 'json', status: 502, body: { detail: 'bad gateway' } },
      { kind: 'json', status: 429, body: { detail: 'slow down' }, headers: { 'Retry-After': '0' } },
      { kind: 'sse', chunks: sseChunks({ content: 'ok' }) },
    );
    const retries: RetryInfo[] = [];
    const turn = await client({ retries: 3 }).chat(req, { onRetry: (r) => retries.push(r) });
    expect(turn.content).toBe('ok');
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retries[1]!.delayMs).toBe(0);
  });

  it('retries a stream dropped mid-way and reports the discarded partial output', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'partial answer', pieces: 4 }), dropAfter: 3, delayMs: 15 }, { kind: 'sse', chunks: sseChunks({ content: 'full answer' }) });
    const retries: RetryInfo[] = [];
    const turn = await client().chat(req, { onRetry: (r) => retries.push(r) });
    expect(turn.content).toBe('full answer');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.discardedPartial).toBe(true);
  });

  it('gives up after maxRetries', async () => {
    mock.enqueue({ kind: 'json', status: 503, body: {} }, { kind: 'json', status: 503, body: {} });
    await expect(client({ retries: 1 }).chat(req)).rejects.toBeInstanceOf(HttpError);
    expect(mock.chatRequests()).toHaveLength(2);
  });

  it('does not retry failures that would only repeat, because each retry re-reads the whole prompt', async () => {
    for (const status of [400, 500]) {
      mock.enqueue({ kind: 'json', status, body: { detail: 'deterministic' } });
      await expect(client({ retries: 3 }).chat(req)).rejects.toBeInstanceOf(HttpError);
    }
    expect(mock.chatRequests()).toHaveLength(2);
    expect(mock.pending()).toBe(0);
  });

  it('sends max_tokens when an output cap is given', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'ok' }) });
    await client().chat({ ...req, maxTokens: 4096 });
    expect((mock.chatRequests()[0]!.body as { max_tokens?: number }).max_tokens).toBe(4096);
  });

  it('does not retry authentication errors', async () => {
    const c = client({ key: 'sk-wrong' });
    const err = await c.chat(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).isAuth).toBe(true);
    expect(mock.chatRequests()).toHaveLength(1);
  });

  it('never retries or follows a redirect off the configured origin', async () => {
    mock.enqueue({ kind: 'redirect', location: 'https://elsewhere.example/x', status: 307 }, { kind: 'sse', chunks: sseChunks({ content: 'should not be used' }) });
    await expect(client().chat(req)).rejects.toBeInstanceOf(EgressBlockedError);
    expect(mock.chatRequests()).toHaveLength(1);
  });

  it('fails fast without an API key and sends nothing', async () => {
    await expect(client({ key: undefined }).chat(req)).rejects.toBeInstanceOf(MissingApiKeyError);
    expect(mock.chatRequests()).toHaveLength(0);
  });

  it('recognizes models that reject tools', async () => {
    mock.enqueue({ kind: 'json', status: 400, body: { detail: 'registry.ollama.ai/library/gemma:2b does not support tools' } });
    const err = (await client().chat(req).catch((e: unknown) => e)) as HttpError;
    expect(err.toolsUnsupported).toBe(true);
  });

  it('aborts a stalled stream with StallError', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'never finishes' }), hangAfter: 2 });
    const err = await client({ stallMs: 150, retries: 0 }).chat(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StallError);
  });

  it('waits longer for the first response than between chunks', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'slow start' }), headersDelayMs: 400 });
    const turn = await client({ stallMs: 150, firstMs: 2000, retries: 0 }).chat(req);
    expect(turn.content).toBe('slow start');
  });

  it('gives up without retrying when the model never starts responding', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'too late' }), headersDelayMs: 1500 }, { kind: 'sse', chunks: sseChunks({ content: 'unused' }) });
    const err = (await client({ stallMs: 100, firstMs: 300, retries: 2 }).chat(req).catch((e: unknown) => e)) as StallError;
    expect(err).toBeInstanceOf(StallError);
    expect(err.beforeFirstResponse).toBe(true);
    expect(err.message).toMatch(/did not start responding/);
    expect(mock.chatRequests()).toHaveLength(1);
  });

  it('stops immediately when the caller aborts', async () => {
    mock.enqueue({ kind: 'sse', chunks: sseChunks({ content: 'slow stream', pieces: 10 }), delayMs: 100 });
    const controller = new AbortController();
    const deltas: StreamDelta[] = [];
    const p = client().chat(req, { onDelta: (d) => (deltas.push(d), controller.abort()) }, controller.signal);
    const err = await p.catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
    expect(deltas.length).toBeGreaterThan(0);
    expect(mock.chatRequests()).toHaveLength(1);
  });
});
