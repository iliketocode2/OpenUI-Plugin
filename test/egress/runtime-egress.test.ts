import { createRequire } from 'node:module';
import type * as NetModule from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Egress, EgressBlockedError } from '../../src/net/egress';
import { OwuiClient } from '../../src/owui/client';
import { createHarness, tools } from '../helpers/agent';
import { MockOwui, sseChunks } from '../mock-owui/server';

const nodeRequire = createRequire(__filename);
const net = nodeRequire('node:net') as typeof NetModule;
const tls = nodeRequire('node:tls') as { connect: unknown };
const dns = nodeRequire('node:dns') as { lookup: unknown };

interface Destination {
  via: string;
  host: string;
  port: number;
}

const seen: Destination[] = [];
const originals = {
  connect: net.Socket.prototype.connect,
  tlsConnect: tls.connect,
  lookup: dns.lookup,
};

function record(via: string, rawArgs: unknown[]): void {
  const args = Array.isArray(rawArgs[0]) ? (rawArgs[0] as unknown[]) : rawArgs;
  const first = args[0];
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) seen.push({ via, host: `pipe:${o.path}`, port: 0 });
    else seen.push({ via, host: o.host ?? 'localhost', port: Number(o.port) });
  } else if (typeof first === 'number' || typeof first === 'string') {
    const port = Number(first);
    if (Number.isNaN(port)) seen.push({ via, host: `pipe:${String(first)}`, port: 0 });
    else seen.push({ via, host: typeof args[1] === 'string' ? args[1] : 'localhost', port });
  }
}

const KEY = 'sk-egress';
const mock = new MockOwui({ apiKey: KEY });
let allowed: { host: string; port: number };

beforeAll(async () => {
  const base = new URL(await mock.start());
  allowed = { host: base.hostname, port: Number(base.port) };
  net.Socket.prototype.connect = function (this: NetModule.Socket, ...args: unknown[]) {
    record('net.Socket.connect', args);
    return (originals.connect as (...a: unknown[]) => NetModule.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  tls.connect = (...args: unknown[]) => {
    record('tls.connect', args);
    return (originals.tlsConnect as (...a: unknown[]) => unknown)(...args);
  };
  dns.lookup = (...args: unknown[]) => {
    seen.push({ via: 'dns.lookup', host: String(args[0]), port: 0 });
    return (originals.lookup as (...a: unknown[]) => void)(...args);
  };
});

afterAll(async () => {
  net.Socket.prototype.connect = originals.connect;
  tls.connect = originals.tlsConnect;
  dns.lookup = originals.lookup;
  await mock.stop();
});

describe('network egress', () => {
  it('the interceptor sees real connections (canary)', async () => {
    const other = new MockOwui();
    const url = new URL(await other.start());
    const before = seen.length;
    await new Promise<void>((resolve, reject) => {
      const s = net.connect(Number(url.port), url.hostname, () => {
        s.destroy();
        resolve();
      });
      s.on('error', reject);
    });
    await other.stop();
    expect(seen.slice(before).some((d) => d.port === Number(url.port))).toBe(true);
    seen.length = before;
  });

  it('a full agent session with tools contacts only the configured Open WebUI origin', async () => {
    const start = seen.length;
    const client = new OwuiClient(new Egress(() => mock.baseUrl), async () => KEY, { stallTimeoutMs: () => 5000, maxRetries: () => 2, backoffBaseMs: 5, backoffMaxMs: 10 });
    await client.listModels();
    await client.version();
    const h = await createHarness({ baseUrl: mock.baseUrl, apiKey: KEY, mode: 'auto', web: true, autoApproveSearches: true });
    try {
      mock.route('POST', '/api/v1/retrieval/process/web/search', { kind: 'json', body: { items: [{ link: 'https://docs.example.org/a', title: 'A', snippet: 'see https://cdn.example.net/x.js' }] } });
      mock.route('POST', '/api/v1/retrieval/process/web', { kind: 'json', body: { content: 'Page that links to https://tracker.example.com/pixel and wss://socket.example.com' } });
      mock.enqueue(
        { kind: 'sse', chunks: sseChunks({ reasoning: 'r', content: 'first', usage: { prompt_tokens: 20, completion_tokens: 2 } }) },
        { kind: 'json', status: 503, body: { detail: 'busy' } },
        {
          kind: 'sse',
          chunks: sseChunks({
            content: 'Writing a file and running it.',
            toolCalls: [
              { name: 'write_file', arguments: { path: 'hello.js', content: "console.log('see https://example.com/docs')\n" } },
              { name: 'run_command', arguments: { command: 'node hello.js', description: 'Run the script' } },
              { name: 'read_file', arguments: { path: 'hello.js' } },
            ],
          }),
        },
        {
          kind: 'sse',
          chunks: sseChunks({
            content: 'Researching.',
            toolCalls: [
              { name: 'web_search', arguments: { query: 'generic library question' } },
              { name: 'web_fetch', arguments: { url: 'https://docs.example.org/a' } },
            ],
          }),
        },
        { kind: 'sse', chunks: sseChunks({ content: 'Done: it printed a URL but nothing was fetched by the extension itself.' }) },
        { kind: 'redirect', location: 'https://attacker.example/steal' },
      );
      await h.session.send('hello', h.ctx);
      await h.session.send('again', h.ctx);
      await expect(client.chat({ model: 'mock-model', messages: [{ role: 'user', content: 'redirect me' }] })).rejects.toBeInstanceOf(EgressBlockedError);

      const contacted = seen.slice(start);
      expect(contacted.length).toBeGreaterThan(0);
      const foreign = contacted.filter((d) => (d.via === 'dns.lookup' ? d.host !== allowed.host : d.host !== allowed.host || d.port !== allowed.port));
      expect(foreign).toEqual([]);
      expect(tools(h.session).map((t) => [t.tool, t.status])).toEqual([
        ['write_file', 'done'],
        ['run_command', 'done'],
        ['read_file', 'done'],
        ['web_search', 'done'],
        ['web_fetch', 'done'],
      ]);
      expect(h.approvalsSeen.map((a) => a.tool)).toEqual(['run_command', 'web_fetch']);
    } finally {
      await h.cleanup();
    }
  });
});
