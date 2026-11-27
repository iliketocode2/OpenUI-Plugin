import { describe, expect, it } from 'vitest';
import { formatDuration } from '../../src/shared/format';

describe('formatDuration', () => {
  it('uses tenths of a second under a minute, then minutes and hours', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(-5)).toBe('0.0s');
    expect(formatDuration(412)).toBe('0.4s');
    expect(formatDuration(41_249)).toBe('41.2s');
    expect(formatDuration(59_940)).toBe('59.9s');
    expect(formatDuration(60_000)).toBe('1m00s');
    expect(formatDuration(192_400)).toBe('3m12s');
    expect(formatDuration(3_599_400)).toBe('59m59s');
    expect(formatDuration(3_900_000)).toBe('1h05m');
  });
});
