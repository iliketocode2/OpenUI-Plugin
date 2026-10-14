import { describe, expect, it } from 'vitest';
import { ThinkTagSplitter, stripThinkTags, type SplitPiece } from '../../src/owui/reasoning';

function run(chunks: string[]): { content: string; reasoning: string } {
  const s = new ThinkTagSplitter();
  const pieces: SplitPiece[] = [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
  return {
    content: pieces.filter((p) => p.kind === 'content').map((p) => p.text).join(''),
    reasoning: pieces.filter((p) => p.kind === 'reasoning').map((p) => p.text).join(''),
  };
}

describe('ThinkTagSplitter', () => {
  const text = '<think>plan it</think>\n\nThe answer is 4.';

  it('splits reasoning from content', () => {
    expect(run([text])).toEqual({ reasoning: 'plan it', content: '\n\nThe answer is 4.' });
  });

  it('is independent of chunk boundaries', () => {
    for (let a = 1; a < text.length - 1; a++) {
      for (let b = a + 1; b < text.length; b++) {
        expect(run([text.slice(0, a), text.slice(a, b), text.slice(b)])).toEqual({ reasoning: 'plan it', content: '\n\nThe answer is 4.' });
      }
    }
  });

  it('never emits a partial tag as content', () => {
    const s = new ThinkTagSplitter();
    expect(s.push('Hello <th')).toEqual([{ kind: 'content', text: 'Hello ' }]);
    expect(s.push('ere')).toEqual([{ kind: 'content', text: '<there' }]);
  });

  it('treats an unclosed think block as reasoning', () => {
    expect(run(['<think>still thinking'])).toEqual({ reasoning: 'still thinking', content: '' });
  });

  it('leaves content without tags untouched', () => {
    expect(run(['a < b and c > d'])).toEqual({ reasoning: '', content: 'a < b and c > d' });
  });
});

describe('stripThinkTags', () => {
  it('removes think blocks, including unclosed ones', () => {
    expect(stripThinkTags('<think>x</think>\nHi')).toBe('Hi');
    expect(stripThinkTags('Hi <think>dangling')).toBe('Hi ');
  });
});
