import { EgressBlockedError, InvalidBaseUrlError, type Egress } from '../net/egress';
import { HttpError, MissingApiKeyError, StallError, isAbortError } from './errors';
import { parseModelList, type ServerModel } from './models';
import { abortError, backoffDelay, parseRetryAfter, sleep } from './retry';
import { SseDecoder } from './sse';
import { StreamAssembler, type StreamDelta } from './streamAssembler';
import type { AssistantTurn, ChatRequest } from './types';

export interface ClientOptions {
  stallTimeoutMs: () => number;
  firstResponseTimeoutMs?: () => number;
  maxRetries: () => number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  reason: string;
  discardedPartial: boolean;
}

export interface ChatHandlers {
  onDelta?: (delta: StreamDelta) => void;
  onRetry?: (info: RetryInfo) => void;
}

export class OwuiClient {
  constructor(
    private readonly egress: Egress,
    private readonly apiKey: () => Promise<string | undefined>,
    private readonly opts: ClientOptions,
  ) {}

  async version(signal?: AbortSignal): Promise<string | undefined> {
    const res = await this.egress.request('/api/version', { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  }

  async listModels(signal?: AbortSignal): Promise<ServerModel[]> {
    const res = await this.egress.request('/api/models', { headers: await this.headers(false), signal });
    if (!res.ok) throw await this.httpError(res);
    return parseModelList(await res.json());
  }

  async chat(req: ChatRequest, handlers: ChatHandlers = {}, signal?: AbortSignal): Promise<AssistantTurn> {
    const maxRetries = this.opts.maxRetries();
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        return await this.chatOnce(req, signal, (d) => {
          emitted = true;
          handlers.onDelta?.(d);
        });
      } catch (e) {
        if (signal?.aborted) throw abortError();
        if (isAbortError(e)) throw e;
        const retryable =
          e instanceof HttpError
            ? e.retryable
            : !(e instanceof MissingApiKeyError || e instanceof EgressBlockedError || e instanceof InvalidBaseUrlError || (e instanceof StallError && e.beforeFirstResponse));
        if (!retryable || attempt >= maxRetries) throw e;
        const delayMs = backoffDelay(
          attempt,
          { baseMs: this.opts.backoffBaseMs ?? 1000, maxMs: this.opts.backoffMaxMs ?? 30_000 },
          e instanceof HttpError ? e.retryAfterMs : undefined,
        );
        handlers.onRetry?.({
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          reason: e instanceof Error ? e.message : String(e),
          discardedPartial: emitted,
        });
        await sleep(delayMs, signal);
      }
    }
  }

  private async chatOnce(req: ChatRequest, signal: AbortSignal | undefined, onDelta: (d: StreamDelta) => void): Promise<AssistantTurn> {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(abortError());
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    const stallMs = this.opts.stallTimeoutMs();
    const firstMs = Math.max(stallMs, this.opts.firstResponseTimeoutMs?.() ?? stallMs);
    let receivedEvent = false;
    let stalled: StallError | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      const ms = receivedEvent ? stallMs : firstMs;
      timer = setTimeout(() => {
        stalled = new StallError(Math.round(ms / 1000), !receivedEvent);
        controller.abort(stalled);
      }, ms);
    };
    try {
      arm();
      const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: true };
      if (req.tools?.length) body.tools = req.tools;
      if (req.stop?.length) body.stop = req.stop;
      if (req.temperature !== undefined) body.temperature = req.temperature;
      const params: Record<string, unknown> = {};
      if (req.think !== undefined) params.think = req.think;
      if (req.numCtx !== undefined) params.num_ctx = req.numCtx;
      if (Object.keys(params).length) body.params = params;
      const res = await this.egress.request('/api/chat/completions', {
        method: 'POST',
        headers: { ...(await this.headers(true)), Accept: 'text/event-stream, application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw await this.httpError(res);
      const assembler = new StreamAssembler();
      const contentType = res.headers.get('content-type') ?? '';
      if (!res.body) throw new Error('Open WebUI returned an empty response body.');
      if (!contentType.includes('text/event-stream')) {
        const text = await readAll(res.body, arm);
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          if (text.trimStart().startsWith('data:')) return this.consumeSseText(text, assembler, onDelta);
          throw new Error(`Unexpected response from Open WebUI: ${text.slice(0, 200)}`);
        }
        for (const d of assembler.pushChunk(json)) onDelta(d);
        for (const d of assembler.flushPending()) onDelta(d);
        return assembler.finish();
      }
      const decoder = new SseDecoder();
      const text = new TextDecoder();
      const reader = res.body.getReader();
      let done = false;
      while (!done) {
        const r = await reader.read();
        if (r.done) break;
        const events = decoder.push(text.decode(r.value, { stream: true }));
        if (events.length) receivedEvent = true;
        arm();
        for (const ev of events) {
          if (this.handleEvent(ev.data, assembler, onDelta)) done = true;
        }
      }
      if (done) await reader.cancel().catch(() => undefined);
      for (const ev of decoder.push(text.decode())) this.handleEvent(ev.data, assembler, onDelta);
      for (const ev of decoder.flush()) this.handleEvent(ev.data, assembler, onDelta);
      for (const d of assembler.flushPending()) onDelta(d);
      return assembler.finish();
    } catch (e) {
      if (stalled) throw stalled;
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private consumeSseText(raw: string, assembler: StreamAssembler, onDelta: (d: StreamDelta) => void): AssistantTurn {
    const decoder = new SseDecoder();
    for (const ev of [...decoder.push(raw), ...decoder.flush()]) this.handleEvent(ev.data, assembler, onDelta);
    for (const d of assembler.flushPending()) onDelta(d);
    return assembler.finish();
  }

  private handleEvent(data: string, assembler: StreamAssembler, onDelta: (d: StreamDelta) => void): boolean {
    const trimmed = data.trim();
    if (trimmed === '[DONE]') return true;
    if (!trimmed) return false;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return false;
    }
    for (const d of assembler.pushChunk(json)) onDelta(d);
    return false;
  }

  private async headers(json: boolean): Promise<Record<string, string>> {
    const key = await this.apiKey();
    if (!key) throw new MissingApiKeyError();
    const h: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private async httpError(res: Response): Promise<HttpError> {
    const body = await res.text().catch(() => '');
    return new HttpError(res.status, body, parseRetryAfter(res.headers.get('retry-after')));
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, onChunk: () => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const r = await reader.read();
    onChunk();
    if (r.done) break;
    out += decoder.decode(r.value, { stream: true });
  }
  return out + decoder.decode();
}
