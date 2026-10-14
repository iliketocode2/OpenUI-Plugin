import { describe, expect, it } from 'vitest';
import { SseDecoder } from '../../src/owui/sse';
import { loadFixture } from '../mock-owui/server';

function decodeAll(chunks: string[]): string[] {
  const d = new SseDecoder();
  const out = chunks.flatMap((c) => d.push(c)).map((e) => e.data);
  return [...out, ...d.flush().map((e) => e.data)];
}

describe('SseDecoder', () => {
  it('decodes events with LF, CRLF and CR line endings', () => {
    expect(decodeAll(['data: a\n\ndata: b\r\n\r\ndata: c\r\rdata: d\n\n'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles chunk boundaries anywhere, including inside CRLF', () => {
    const text = 'data: {"x":1}\r\n\r\ndata: {"x":2}\r\n\r\n';
    for (let cut = 1; cut < text.length; cut++) {
      expect(decodeAll([text.slice(0, cut), text.slice(cut)])).toEqual(['{"x":1}', '{"x":2}']);
    }
  });

  it('joins multi-line data, ignores comments and unknown fields', () => {
    expect(decodeAll([': keep-alive\n', 'id: 1\nevent: msg\ndata: line1\ndata: line2\nretry: 5\n\n'])).toEqual(['line1\nline2']);
  });

  it('keeps the event name', () => {
    const d = new SseDecoder();
    expect(d.push('event: error\ndata: boom\n\n')).toEqual([{ event: 'error', data: 'boom' }]);
  });

  it('flushes an unterminated final event', () => {
    expect(decodeAll(['data: tail'])).toEqual(['tail']);
  });

  it('decodes a recorded Open WebUI stream byte by byte', () => {
    const raw = loadFixture('live/chat-basic.response.sse');
    const whole = decodeAll([raw]);
    const bytewise = decodeAll(raw.split(''));
    expect(bytewise).toEqual(whole);
    expect(whole[whole.length - 1]).toBe('[DONE]');
  });
});
