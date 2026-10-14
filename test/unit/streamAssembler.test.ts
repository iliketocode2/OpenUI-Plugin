import { describe, expect, it } from 'vitest';
import { SseDecoder } from '../../src/owui/sse';
import { ModelStreamError, StreamAssembler, parseUsage, type StreamDelta } from '../../src/owui/streamAssembler';
import { loadFixture } from '../mock-owui/server';

function replay(raw: string) {
  const decoder = new SseDecoder();
  const a = new StreamAssembler();
  const deltas: StreamDelta[] = [];
  for (const ev of [...decoder.push(raw), ...decoder.flush()]) {
    if (ev.data === '[DONE]') continue;
    deltas.push(...a.pushChunk(JSON.parse(ev.data)));
  }
  deltas.push(...a.flushPending());
  return { turn: a.finish(), deltas };
}

describe('StreamAssembler with recorded Open WebUI 0.12 streams', () => {
  it('separates reasoning_content from content and reads usage', () => {
    const { turn, deltas } = replay(loadFixture('live/chat-basic.response.sse'));
    expect(turn.content.trim()).toMatch(/pong/i);
    expect(turn.reasoning.length).toBeGreaterThan(20);
    expect(turn.content).not.toContain(turn.reasoning.slice(0, 20));
    expect(turn.finishReason).toBe('stop');
    expect(turn.usage?.promptTokens).toBe(17);
    expect(turn.toolCalls).toEqual([]);
    expect(deltas.filter((d) => d.kind === 'reasoning').map((d) => d.text).join('')).toBe(turn.reasoning);
  });

  it('assembles a native tool call delivered in one chunk', () => {
    const { turn } = replay(loadFixture('live/native-tool-1.response.sse'));
    expect(turn.finishReason).toBe('tool_calls');
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]!.name).toBe('add');
    expect(JSON.parse(turn.toolCalls[0]!.arguments)).toEqual({ a: 1234, b: 5678 });
    expect(turn.toolCalls[0]!.id).toMatch(/^call_/);
  });

  it('assembles each step of the recorded agent round-trip', () => {
    const names = ['agent-1', 'agent-2', 'agent-3'].map((f) => replay(loadFixture(`live/${f}.response.sse`)).turn.toolCalls[0]?.name);
    expect(names).toEqual(['read_file', 'edit_file', 'run_command']);
    const final = replay(loadFixture('live/agent-4.response.sse')).turn;
    expect(final.toolCalls).toEqual([]);
    expect(final.content).toContain('Hi, sovereign world');
  });

  it('does not find tool calls inside reasoning', () => {
    const { turn } = replay(loadFixture('live/text-custom-tag-1.response.sse'));
    expect(turn.toolCalls).toEqual([]);
    expect(turn.content).toContain('<agent_tool>');
  });
});

describe('StreamAssembler with synthetic streams', () => {
  it('splits <think> tags embedded in content across chunk boundaries', () => {
    const { turn, deltas } = replay(loadFixture('synthetic/think-tags.sse'));
    expect(turn.reasoning).toBe('The user wants a greeting. I will say hello.');
    expect(turn.content).toBe('\n\nHello, world! Use <b>bold</b> carefully.');
    expect(deltas.some((d) => d.kind === 'content' && d.text.includes('<th'))).toBe(false);
  });

  it('concatenates fragmented OpenAI-style tool-call arguments by index', () => {
    const { turn } = replay(loadFixture('synthetic/openai-fragmented-tools.sse'));
    expect(turn.toolCalls).toEqual([
      { id: 'call_a', name: 'read_file', arguments: '{"path": "src/a.ts"}' },
      { id: 'call_b', name: 'list_dir', arguments: '{"path":"."}' },
    ]);
  });

  it('accepts tool calls without index and object arguments', () => {
    const a = new StreamAssembler();
    a.pushChunk({ choices: [{ delta: { tool_calls: [{ id: 'x', function: { name: 'f', arguments: { a: 1 } } }, { id: 'y', function: { name: 'g' } }] } }] });
    expect(a.finish().toolCalls).toEqual([
      { id: 'x', name: 'f', arguments: '{"a":1}' },
      { id: 'y', name: 'g', arguments: '{}' },
    ]);
  });

  it('reads a non-streamed completion message', () => {
    const a = new StreamAssembler();
    a.pushChunk({
      choices: [{ index: 0, message: { role: 'assistant', content: 'done', reasoning_content: 'why' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    expect(a.finish()).toMatchObject({ content: 'done', reasoning: 'why', finishReason: 'stop', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
  });

  it('throws on an error chunk', () => {
    const a = new StreamAssembler();
    expect(() => a.pushChunk({ error: { message: 'model crashed' } })).toThrow(ModelStreamError);
    expect(() => new StreamAssembler().pushChunk({ detail: 'nope' })).toThrow('nope');
  });

  it('ignores choices other than the first', () => {
    const a = new StreamAssembler();
    a.pushChunk({ choices: [{ index: 1, delta: { content: 'other' } }, { index: 0, delta: { content: 'main' } }] });
    expect(a.finish().content).toBe('main');
  });
});

describe('parseUsage', () => {
  it('supports OpenAI, Anthropic-style and Ollama field names', () => {
    expect(parseUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });
    expect(parseUsage({ input_tokens: 3, output_tokens: 4, total_tokens: 9 })).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 9 });
    expect(parseUsage({ prompt_eval_count: 8, eval_count: 2 })).toEqual({ promptTokens: 8, completionTokens: 2, totalTokens: 10 });
    expect(parseUsage({})).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });
});
