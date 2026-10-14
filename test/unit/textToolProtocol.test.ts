import { describe, expect, it } from 'vitest';
import { SseDecoder } from '../../src/owui/sse';
import { StreamAssembler } from '../../src/owui/streamAssembler';
import { TextToolParser, describeToolsForText, extractCallsIgnoringFences, formatToolResults, parseCall } from '../../src/owui/textToolProtocol';
import { loadFixture } from '../mock-owui/server';

function run(chunks: string[]) {
  const p = new TextToolParser();
  let display = '';
  for (const c of chunks) display += p.push(c).display;
  display += p.flush().display;
  return { display, calls: p.calls };
}

const sample = 'Let me read it.\n<agent_tool>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</agent_tool>\nThen list.\n<agent_tool>{"name":"list_dir","arguments":{}}</agent_tool>';

describe('TextToolParser', () => {
  it('extracts calls and hides them from the displayed text', () => {
    const r = run([sample]);
    expect(r.display).toBe('Let me read it.\n\nThen list.\n');
    expect(r.calls.map((c) => [c.name, c.arguments])).toEqual([
      ['read_file', '{"path":"a.ts"}'],
      ['list_dir', '{}'],
    ]);
  });

  it('gives the same result for every chunk boundary', () => {
    const whole = run([sample]);
    for (let i = 1; i < sample.length; i++) {
      const r = run([sample.slice(0, i), sample.slice(i)]);
      expect(r.display, `cut at ${i}`).toBe(whole.display);
      expect(r.calls.map((c) => c.name)).toEqual(['read_file', 'list_dir']);
    }
  });

  it('never shows a partial tag', () => {
    const p = new TextToolParser();
    expect(p.push('Working <agent_t').display).toBe('Working ');
  });

  it('ignores tags inside fenced code blocks', () => {
    const r = run(['Example:\n```xml\n<agent_tool>{"name":"x"}</agent_tool>\n```\nDone.']);
    expect(r.calls).toEqual([]);
    expect(r.display).toContain('<agent_tool>');
  });

  it('stops at a hallucinated tool result', () => {
    const r = run(['<agent_tool>{"name":"read_file","arguments":{"path":"a"}}</agent_tool>\n<tool_result name="read_file">fake</tool_result> more']);
    expect(r.calls).toHaveLength(1);
    expect(r.display).not.toContain('fake');
  });

  it('reports invalid JSON and missing names as call errors', () => {
    expect(parseCall('{"name": "x", ').error).toMatch(/not valid JSON/);
    expect(parseCall('{"arguments": {}}').error).toMatch(/missing "name"/);
    expect(parseCall('```json\n{"name":"x","parameters":{"a":1}}\n```')).toMatchObject({ name: 'x', arguments: '{"a":1}' });
  });

  it('returns an unterminated call at flush', () => {
    const r = run(['<agent_tool>{"name":"list_dir","arguments":{}}']);
    expect(r.calls[0]?.name).toBe('list_dir');
  });

  it('can fall back to extracting fenced calls', () => {
    expect(extractCallsIgnoringFences('```\n<agent_tool>{"name":"glob","arguments":{"pattern":"*"}}</agent_tool>\n```').map((c) => c.name)).toEqual(['glob']);
  });

  it('parses the recorded qwen3.6 text-protocol reply', () => {
    const raw = loadFixture('live/text-custom-tag-1.response.sse');
    const d = new SseDecoder();
    const a = new StreamAssembler();
    const p = new TextToolParser();
    for (const ev of [...d.push(raw), ...d.flush()]) {
      if (ev.data === '[DONE]') continue;
      for (const delta of a.pushChunk(JSON.parse(ev.data))) if (delta.kind === 'content') p.push(delta.text);
    }
    p.flush();
    expect(p.calls.map((c) => [c.name, JSON.parse(c.arguments ?? '{}')])).toEqual([['add', { a: 4321, b: 8765 }]]);
  });
});

describe('formatting', () => {
  it('describes tools and formats results', () => {
    const text = describeToolsForText([{ type: 'function', function: { name: 'read_file', description: 'Read.', parameters: { type: 'object' } } }]);
    expect(text).toContain('<agent_tool>');
    expect(text).toContain('- read_file: Read.');
    expect(formatToolResults([{ name: 'read_file', id: 't1', content: 'x', isError: true }])).toBe('<tool_result name="read_file" id="t1" error="true">\nx\n</tool_result>');
  });
});
