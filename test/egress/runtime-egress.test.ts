import { createRequire } from 'node:module';
import type * as NetModule from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatSession, type RunContext } from '../../src/agent/session';
import { Egress, EgressBlockedError } from '../../src/net/egress';
import { OwuiClient } from '../../src/owui/client';
import { resolveModel } from '../../src/owui/models';
import { TokenCalibrator } from '../../src/owui/tokens';
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

  it('a full session contacts only the configured Open WebUI origin', async () => {
    const start = seen.length;
    const egress = new Egress(() => mock.baseUrl);
    const client = new OwuiClient(egress, async () => KEY, { stallTimeoutMs: () => 5000, maxRetries: () => 2, backoffBaseMs: 5, backoffMaxMs: 10 });

    const [server] = await client.listModels();
    await client.version();
    const model = resolveModel(server!, { contextSize: 8192 });
    const ctx: RunContext = { model, systemPrompt: 'test', calibrator: new TokenCalibrator(), warnOnce: () => undefined };
    const session = new ChatSession(client, { changed: () => undefined, delta: () => undefined, usage: () => undefined });

    mock.enqueue(
      { kind: 'sse', chunks: sseChunks({ reasoning: 'r', content: 'first', usage: { prompt_tokens: 20, completion_tokens: 2 } }) },
      { kind: 'json', status: 503, body: { detail: 'busy' } },
      { kind: 'sse', chunks: sseChunks({ content: 'see https://example.com/docs and http://10.0.0.5/admin' }) },
      { kind: 'redirect', location: 'https://attacker.example/steal' },
    );
    await session.send('hello', ctx);
    await session.send('again', ctx);
    await expect(
      client.chat({ model: model.id, messages: [{ role: 'user', content: 'redirect me' }] }),
    ).rejects.toBeInstanceOf(EgressBlockedError);

    const contacted = seen.slice(start);
    expect(contacted.length).toBeGreaterThan(0);
    const foreign = contacted.filter((d) => d.via === 'dns.lookup' ? d.host !== allowed.host : d.host !== allowed.host || d.port !== allowed.port);
    expect(foreign).toEqual([]);
    expect(session.transcript.filter((t) => t.kind === 'assistant').map((t) => (t as { text: string }).text)).toEqual([
      'first',
      'see https://example.com/docs and http://10.0.0.5/admin',
    ]);
  });
});
