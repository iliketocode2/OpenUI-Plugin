import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { WireMessage } from '../../src/owui/types';
import { createHarness, tools, type Harness } from '../helpers/agent';
import { MockOwui, sseChunks } from '../mock-owui/server';

const KEY = 'sk-browser';
const APP = `<!doctype html><html><head><title>Todo App</title></head><body>
<h1>Todos</h1><ul id="list"></ul><input id="new"><button id="add" onclick="const li=document.createElement('li');li.textContent=document.getElementById('new').value;document.getElementById('list').appendChild(li)">Add</button>
<script>console.error('hydration warning: mismatch'); fetch('https://telemetry.example.com/beacon');</script></body></html>`;

let app: http.Server;
let appUrl: string;
let mock: MockOwui;
let h: Harness | undefined;

beforeAll(async () => {
  app = http.createServer((_q, r) => r.writeHead(200, { 'Content-Type': 'text/html' }).end(APP));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => app.close(() => r()));
});

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
const say = (content: string) => ({ kind: 'sse' as const, chunks: sseChunks({ content }) });
const body = (i: number) => mock.chatRequests()[i]!.body as { messages: WireMessage[]; tools?: { function: { name: string } }[] };

describe('browser tools in the agent loop', () => {
  it('opens a local app, interacts, reads logs and sends a screenshot to a vision model', async () => {
    h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, browser: true, mode: 'auto', vision: true, override: { vision: true } });
    mock.enqueue(
      call('browser', { action: 'navigate', url: appUrl }),
      call('browser', { action: 'type', selector: '#new', text: 'Ship phase e' }),
      call('browser', { action: 'click', selector: '#add' }),
      call('browser', { action: 'read_text', selector: '#list' }),
      call('browser', { action: 'screenshot' }),
      say('The todo was added and the page renders.'),
    );
    await h.session.send('check the app', h.ctx);
    expect(tools(h.session).map((t) => [t.tool, t.status])).toEqual([
      ['browser', 'done'],
      ['browser', 'done'],
      ['browser', 'done'],
      ['browser', 'done'],
      ['browser', 'done'],
    ]);
    const navResult = String(body(1).messages.at(-1)!.content);
    expect(navResult).toMatch(/Loaded http:\/\/127\.0\.0\.1:\d+\/ \(HTTP 200\)\. Title: Todo App/);
    expect(navResult).toContain('hydration warning: mismatch');
    expect(navResult).toMatch(/Blocked requests to non-local hosts:\n- https:\/\/telemetry\.example\.com\/beacon/);
    expect(String(body(4).messages.at(-1)!.content)).toBe('Ship phase e');
    const last = body(5).messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
    expect(tools(h.session)[4]!.image).toMatch(/^data:image\/png;base64,/);
  }, 120_000);

  it('refuses non-local pages, and is refused in plan mode', async () => {
    h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, browser: true, mode: 'auto' });
    mock.enqueue(call('browser', { action: 'navigate', url: 'https://example.com/' }), say('ok'));
    await h.session.send('look', h.ctx);
    expect(body(0).tools!.map((t) => t.function.name)).toContain('browser');
    expect(String(body(1).messages.at(-1)!.content)).toMatch(/only opens local development servers/);
    h.setMode('plan');
    mock.enqueue(call('browser', { action: 'navigate', url: 'http://localhost:1/' }), say('ok'));
    await h.session.send('look again', h.ctx);
    expect(String(body(3).messages.at(-1)!.content)).toMatch(/not available in plan mode/);
  }, 60_000);

  it('is not offered when disabled', async () => {
    h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, browser: false });
    mock.enqueue(say('ok'));
    await h.session.send('hi', h.ctx);
    expect(body(0).tools!.map((t) => t.function.name)).not.toContain('browser');
  });
});
