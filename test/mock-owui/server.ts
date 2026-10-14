import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export type MockReply =
  | { kind: 'sse'; chunks: (object | string)[]; delayMs?: number; dropAfter?: number; hangAfter?: number; done?: boolean; headersDelayMs?: number }
  | { kind: 'raw'; text: string; contentType?: string; chunkSize?: number; delayMs?: number }
  | { kind: 'json'; body: unknown; status?: number; headers?: Record<string, string> }
  | { kind: 'redirect'; location: string; status?: number };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export interface MockOptions {
  apiKey?: string;
  version?: string;
  models?: unknown;
  host?: string;
}

export const FIXTURES = join(__dirname, '..', 'fixtures');

export function loadFixture(relative: string): string {
  return readFileSync(join(FIXTURES, relative), 'utf8');
}

export class MockOwui {
  readonly requests: RecordedRequest[] = [];
  private readonly replies: MockReply[] = [];
  private readonly routes = new Map<string, MockReply>();
  private server: http.Server | undefined;
  private readonly sockets = new Set<import('node:net').Socket>();
  baseUrl = '';

  constructor(private readonly opts: MockOptions = {}) {}

  enqueue(...replies: MockReply[]): this {
    this.replies.push(...replies);
    return this;
  }

  route(method: string, path: string, reply: MockReply): this {
    this.routes.set(`${method} ${path}`, reply);
    return this;
  }

  pending(): number {
    return this.replies.length;
  }

  chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path === '/api/chat/completions');
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, this.opts.host ?? '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://${this.opts.host ?? '127.0.0.1'}:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const path = (req.url ?? '/').split('?')[0]!;
    this.requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });

    const routed = this.routes.get(`${req.method} ${path}`);
    if (routed) return this.reply(res, routed);

    if (path === '/api/version' && req.method === 'GET') {
      return this.reply(res, { kind: 'json', body: { version: this.opts.version ?? '0.12.0' } });
    }
    if (this.opts.apiKey && req.headers.authorization !== `Bearer ${this.opts.apiKey}`) {
      return this.reply(res, { kind: 'json', status: 401, body: { detail: 'Not authenticated' } });
    }
    if (path === '/api/models' && req.method === 'GET') {
      return this.reply(res, { kind: 'json', body: this.opts.models ?? { data: [{ id: 'mock-model', name: 'Mock Model', owned_by: 'ollama' }] } });
    }
    if (path === '/api/chat/completions' && req.method === 'POST') {
      const next = this.replies.shift();
      if (!next) return this.reply(res, { kind: 'json', status: 500, body: { detail: 'mock: no scripted reply left' } });
      return this.reply(res, next);
    }
    return this.reply(res, { kind: 'json', status: 404, body: { detail: 'Not Found' } });
  }

  private async reply(res: http.ServerResponse, r: MockReply): Promise<void> {
    switch (r.kind) {
      case 'json':
        res.writeHead(r.status ?? 200, { 'Content-Type': 'application/json', ...r.headers });
        res.end(JSON.stringify(r.body));
        return;
      case 'redirect':
        res.writeHead(r.status ?? 302, { Location: r.location });
        res.end();
        return;
      case 'raw': {
        res.writeHead(200, { 'Content-Type': r.contentType ?? 'text/event-stream' });
        const size = r.chunkSize ?? r.text.length;
        for (let i = 0; i < r.text.length; i += size) {
          res.write(r.text.slice(i, i + size));
          if (r.delayMs) await delay(r.delayMs);
        }
        res.end();
        return;
      }
      case 'sse': {
        if (r.headersDelayMs) await delay(r.headersDelayMs);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.flushHeaders();
        for (const [i, c] of r.chunks.entries()) {
          if (r.dropAfter !== undefined && i >= r.dropAfter) {
            res.socket?.destroy();
            return;
          }
          if (r.hangAfter !== undefined && i >= r.hangAfter) return;
          res.write(typeof c === 'string' ? c : `data: ${JSON.stringify(c)}\n\n`);
          if (r.delayMs) await delay(r.delayMs);
        }
        if (r.done !== false) res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let seq = 0;

export interface ScriptedTurn {
  content?: string;
  reasoning?: string;
  toolCalls?: { name: string; arguments: object | string; id?: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
  pieces?: number;
}

export function sseChunks(turn: ScriptedTurn): object[] {
  const id = `chatcmpl-${++seq}`;
  const base = { id, object: 'chat.completion.chunk', created: 1, model: 'mock-model' };
  const out: object[] = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }];
  const split = (s: string) => {
    const n = Math.max(1, turn.pieces ?? 4);
    const size = Math.max(1, Math.ceil(s.length / n));
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
    return parts;
  };
  for (const r of split(turn.reasoning ?? '')) out.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: r }, finish_reason: null }] });
  for (const c of split(turn.content ?? '')) out.push({ ...base, choices: [{ index: 0, delta: { content: c }, finish_reason: null }] });
  (turn.toolCalls ?? []).forEach((tc, index) => {
    out.push({
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: tc.id ?? `call_${index}`,
                type: 'function',
                function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });
  out.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }],
    ...(turn.usage ? { usage: { ...turn.usage, total_tokens: turn.usage.prompt_tokens + turn.usage.completion_tokens } } : {}),
  });
  return out;
}
