import * as http from 'node:http';
import * as https from 'node:https';
import { Readable } from 'node:stream';

export interface TransportInit {
  method?: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

export function nodeTransport(url: string, init: TransportInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const mod = target.protocol === 'https:' ? https : http;
    if (init.signal?.aborted) {
      reject(abortReason(init.signal));
      return;
    }
    const body = init.body === undefined ? undefined : Buffer.from(init.body, 'utf8');
    const req = mod.request(
      target,
      {
        method: init.method ?? 'GET',
        headers: { ...init.headers, ...(body ? { 'Content-Length': String(body.length) } : {}) },
        agent: false,
        timeout: 0,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
          else if (v !== undefined) headers.set(k, v);
        }
        const status = res.statusCode ?? 0;
        const stream = NULL_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        if (!stream) res.resume();
        resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers }));
      },
    );
    const onAbort = () => req.destroy(abortReason(init.signal!));
    init.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => init.signal?.removeEventListener('abort', onAbort));
    req.on('error', (e) => reject(init.signal?.aborted ? abortReason(init.signal) : e));
    if (body) req.write(body);
    req.end();
  });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}
