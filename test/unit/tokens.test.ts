import { describe, expect, it } from 'vitest';
import { DEFAULT_CHARS_PER_TOKEN, TokenCalibrator, checkTruncation, measurePrompt, outputReserve, preflight } from '../../src/owui/tokens';

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

describe('TokenCalibrator', () => {
  it('learns chars per token from usage and persists a snapshot', () => {
    const c = new TokenCalibrator();
    expect(c.charsPerToken('m')).toBe(DEFAULT_CHARS_PER_TOKEN);
    expect(c.observe('m', { chars: 4600, images: 0 }, 1000, 32768)).toBe(true);
    expect(c.charsPerToken('m')).toBeCloseTo(4.6);
    c.observe('m', { chars: 4000, images: 0 }, 1000, 32768);
    expect(c.charsPerToken('m')).toBeCloseTo(4.6 * 0.7 + 4 * 0.3);
    expect(new TokenCalibrator(c.snapshot()).charsPerToken('m')).toBeCloseTo(c.charsPerToken('m'));
  });

  it('refuses samples that could have been truncated or are implausible', () => {
    const c = new TokenCalibrator();
    expect(c.observe('m', { chars: 20000, images: 0 }, 4000, 4096)).toBe(false);
    expect(c.observe('m', { chars: 100, images: 0 }, 10, 4096)).toBe(false);
    expect(c.observe('m', { chars: 10000, images: 0 }, 100, 32768)).toBe(false);
    expect(c.isCalibrated('m')).toBe(false);
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
