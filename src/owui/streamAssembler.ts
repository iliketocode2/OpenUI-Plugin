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

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking'] as const;

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
  private readonly calls = new Map<number, PartialCall>();
  private finishReason: string | null = null;
  private usage: Usage | null = null;
  private readonly splitter = new ThinkTagSplitter();
  private sawStructuredReasoning = false;

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
      for (const field of REASONING_FIELDS) {
        const r = delta[field];
        if (typeof r === 'string' && r) {
          this.sawStructuredReasoning = true;
          this.reasoning += r;
          out.push({ kind: 'reasoning', text: r });
        }
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

  hasOutput(): boolean {
    return this.content.length > 0 || this.reasoning.length > 0 || this.calls.size > 0;
  }

  usesStructuredReasoning(): boolean {
    return this.sawStructuredReasoning;
  }

  private applyPiece(piece: { kind: 'content' | 'reasoning'; text: string }): StreamDelta {
    if (piece.kind === 'reasoning') this.reasoning += piece.text;
    else this.content += piece.text;
    return { kind: piece.kind, text: piece.text };
  }

  private pushToolCalls(list: unknown[]): void {
    list.forEach((raw, position) => {
      if (!isObject(raw)) return;
      const index = typeof raw.index === 'number' ? raw.index : this.nextIndexFor(raw, position);
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

  private nextIndexFor(raw: Json, position: number): number {
    if (typeof raw.id === 'string' && raw.id) {
      for (const [i, c] of this.calls) if (c.id === raw.id) return i;
      return this.calls.size;
    }
    return position;
  }

  private toolCalls(): AssembledToolCall[] {
    return [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments.trim() || '{}' }));
  }
}
