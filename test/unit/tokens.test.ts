import { describe, expect, it } from 'vitest';
import { checkTruncation, measurePrompt, outputReserve, preflight, toolOutputChars, tokensFor } from '../../src/owui/tokens';

const text = (n: number) => 'x'.repeat(n);

describe('measurePrompt', () => {
  it('counts text, tool calls, tool schemas and images', () => {
    const size = measurePrompt(
      [
        { role: 'system', content: text(100) },
        { role: 'user', content: [{ type: 'text', text: text(50) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
      ],
      [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
    );
    expect(size.images).toBe(1);
    expect(size.chars).toBeGreaterThan(150);
  });
});

describe('tokensFor', () => {
  it('estimates text at 3.5 characters per token and images at a flat cost', () => {
    expect(tokensFor({ chars: 3500, images: 0 })).toBe(1000);
    expect(tokensFor({ chars: 0, images: 2 })).toBe(1600);
  });
});

describe('toolOutputChars', () => {
  it('gives one tool result about a fifth of the context, within fixed bounds', () => {
    expect(toolOutputChars(16384)).toBe(11469);
    expect(toolOutputChars(2048)).toBe(4000);
    expect(toolOutputChars(262144)).toBe(40000);
  });
});

describe('checkTruncation', () => {
  it('passes the ratios measured against the live server', () => {
    expect(checkTruncation(1716, 1317, 4096).kind).toBe('ok');
    expect(checkTruncation(4487, 3417, 4096).kind).toBe('ok');
  });

  it('flags a much lower server count', () => {
    const v = checkTruncation(9000, 2000, 32768);
    expect(v.kind).toBe('suspect');
  });

  it('flags a server count pinned at the context limit when more was sent', () => {
    expect(checkTruncation(6000, 4090, 4096).kind).toBe('suspect');
  });

  it('ignores small prompts and missing usage', () => {
    expect(checkTruncation(800, 100, 4096).kind).toBe('ok');
    expect(checkTruncation(5000, undefined, 4096).kind).toBe('unknown');
  });
});

describe('preflight', () => {
  it('classifies prompt size against the usable context', () => {
    expect(preflight(1000, 4096, 1024)).toEqual({ kind: 'ok' });
    expect(preflight(2600, 4096, 1024).kind).toBe('near');
    expect(preflight(3500, 4096, 1024).kind).toBe('over');
  });

  it('reserves a sensible share for output', () => {
    expect(outputReserve(4096)).toBe(1024);
    expect(outputReserve(1024)).toBe(512);
    expect(outputReserve(131072)).toBe(8192);
  });
});
