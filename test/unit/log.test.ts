import { afterEach, describe, expect, it } from 'vitest';
import { log, redact, setLogger } from '../../src/log';

afterEach(() => setLogger(undefined));

describe('log', () => {
  it('redacts bearer tokens and API keys that end up in messages', () => {
    expect(redact('HTTP 401 for Authorization: Bearer sk-abc123def456ghi')).toBe('HTTP 401 for Authorization: Bearer [redacted]');
    expect(redact('key sk-0123456789abcdef was rejected')).toBe('key sk-[redacted] was rejected');
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });

  it('forwards to the installed logger, redacted, and is a no-op without one', () => {
    log.error('ignored, no logger installed');
    const lines: string[] = [];
    setLogger({ info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) });
    log.warn('used sk-0123456789abcdef');
    expect(lines).toEqual(['warn used sk-[redacted]']);
  });
});
