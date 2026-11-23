import { ThinkTagSplitter } from './reasoning';
import type { AssembledToolCall, AssistantTurn, Usage } from './types';

export type StreamDelta = { kind: 'content'; text: string } | { kind: 'reasoning'; text: string };

export class ModelStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelStreamError';
  }
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

/** Servers name the reasoning field differently, and some send the same text under two names; the first one wins. */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking'] as const;
const CLOSE_THINK = '</think>';

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseUsage(raw: unknown): Usage | null {
  if (!isObject(raw)) return null;
  const prompt = num(raw.prompt_tokens) ?? num(raw.input_tokens) ?? num(raw.prompt_eval_count);
  const completion = num(raw.completion_tokens) ?? num(raw.output_tokens) ?? num(raw.eval_count);
  if (prompt === undefined && completion === undefined) return null;
  const p = prompt ?? 0;
  const c = completion ?? 0;
  return { promptTokens: p, completionTokens: c, totalTokens: num(raw.total_tokens) ?? p + c };
}

function errorMessage(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (isObject(raw)) {
    if (typeof raw.message === 'string') return raw.message;
    if (typeof raw.detail === 'string') return raw.detail;
  }
  return undefined;
}

export class StreamAssembler {
  private content = '';
  private reasoning = '';
  /** Tool calls in arrival order, keyed by slot; `slots` maps the server's index to the slot it currently fills. */
  private readonly calls = new Map<number, PartialCall>();
  private readonly slots = new Map<number, number>();
  private nextSlot = 0;
  private finishReason: string | null = null;
  private usage: Usage | null = null;
  private readonly splitter = new ThinkTagSplitter();

  pushChunk(chunk: unknown): StreamDelta[] {
    if (!isObject(chunk)) return [];
    const err = chunk.error ?? (chunk.choices === undefined ? chunk.detail : undefined);
    if (err !== undefined) throw new ModelStreamError(errorMessage(err) ?? JSON.stringify(err));
    const usage = parseUsage(chunk.usage);
    if (usage) this.usage = usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const out: StreamDelta[] = [];
    for (const choice of choices) {
      if (!isObject(choice)) continue;
      if (typeof choice.index === 'number' && choice.index !== 0) continue;
      if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
      const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : undefined;
      if (!delta) continue;
      const r = REASONING_FIELDS.map((field) => delta[field]).find((v): v is string => typeof v === 'string' && v !== '');
      if (r) {
        this.reasoning += r;
        out.push({ kind: 'reasoning', text: r });
      }
      if (typeof delta.content === 'string' && delta.content) {
        for (const piece of this.splitter.push(delta.content)) out.push(this.applyPiece(piece));
      }
      if (Array.isArray(delta.tool_calls)) this.pushToolCalls(delta.tool_calls);
    }
    return out;
  }

  finish(): AssistantTurn {
    this.flushPending();
    // Chat templates that put <think> in the prompt make the model answer "reasoning…</think>answer", with no opening
    // tag to split on. Only when no reasoning arrived any other way, so a literal </think> in an answer survives.
    const close = this.reasoning ? -1 : this.content.indexOf(CLOSE_THINK);
    if (close !== -1) {
      this.reasoning = this.content.slice(0, close).trim();
      this.content = this.content.slice(close + CLOSE_THINK.length).replace(/^\s+/, '');
    }
    return {
      content: this.content,
      reasoning: this.reasoning,
      toolCalls: this.toolCalls(),
      finishReason: this.finishReason,
      usage: this.usage,
    };
  }

  flushPending(): StreamDelta[] {
    return this.splitter.flush().map((p) => this.applyPiece(p));
  }

  private applyPiece(piece: { kind: 'content' | 'reasoning'; text: string }): StreamDelta {
    if (piece.kind === 'reasoning') this.reasoning += piece.text;
    else this.content += piece.text;
    return { kind: piece.kind, text: piece.text };
  }

  private pushToolCalls(list: unknown[]): void {
    list.forEach((raw, position) => {
      if (!isObject(raw)) return;
      const index = this.slotFor(raw, position);
      const cur = this.calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (typeof raw.id === 'string' && raw.id) cur.id = raw.id;
      const fn = isObject(raw.function) ? raw.function : undefined;
      if (fn) {
        if (typeof fn.name === 'string' && fn.name) cur.name = fn.name;
        const args = fn.arguments;
        if (typeof args === 'string') cur.arguments += args;
        else if (args !== undefined && args !== null) cur.arguments = JSON.stringify(args);
      }
      this.calls.set(index, cur);
    });
  }

  private slotFor(raw: Json, position: number): number {
    const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
    if (typeof raw.index !== 'number' && id) {
      for (const [slot, c] of this.calls) if (c.id === id) return slot;
      return this.nextSlot++;
    }
    const index = typeof raw.index === 'number' ? raw.index : position;
    const slot = this.slots.get(index);
    const existing = slot === undefined ? undefined : this.calls.get(slot);
    // Some servers give every call index 0: a new id at a used index starts a new call instead of extending the old one.
    if (slot !== undefined && !(id && existing?.id && existing.id !== id)) return slot;
    const fresh = this.nextSlot++;
    this.slots.set(index, fresh);
    return fresh;
  }

  private toolCalls(): AssembledToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments.trim() || '{}' }));
  }
}
