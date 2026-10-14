import { describe, expect, it } from 'vitest';
import { globToRegExp, matchGlob } from '../../src/workspace/glob';
import { OutputBuffer, cleanOutput, truncateMiddle } from '../../src/tools/shell/output';
import { coerceArgs, parseArguments, validateArgs } from '../../src/tools/validate';
import type { JsonSchema } from '../../src/tools/types';

const schema: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    limit: { type: 'integer', minimum: 1 },
    all: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
    items: { type: 'array', maxItems: 2, items: { type: 'object', properties: { s: { type: 'string', enum: ['x'] } }, required: ['s'] } },
  },
  required: ['path'],
};

describe('argument validation', () => {
  it('accepts valid arguments and reports each problem clearly', () => {
    expect(validateArgs(schema, { path: 'a', limit: 3, all: true, mode: 'a', items: [{ s: 'x' }] })).toEqual([]);
    expect(validateArgs(schema, { limit: 0, mode: 'c', items: [{ s: 'y' }, {}, {}] })).toEqual([
      'arguments.path is required',
      'arguments.limit must be >= 1',
      'arguments.mode must be one of "a", "b"',
      'arguments.items allows at most 2 item(s)',
      'arguments.items[0].s must be one of "x"',
      'arguments.items[1].s is required',
      'arguments.items[2].s is required',
    ]);
    expect(validateArgs(schema, { path: 5 })).toEqual(['arguments.path must be a string, got integer']);
  });

  it('coerces common model mistakes', () => {
    expect(coerceArgs(schema, { path: 'a', limit: '20', all: 'true', items: '[{"s":"x"}]', mode: null })).toEqual({ path: 'a', limit: 20, all: true, items: [{ s: 'x' }] });
  });

  it('parses arguments, tolerating code fences and empty input', () => {
    expect(parseArguments('```json\n{"a":1}\n```').value).toEqual({ a: 1 });
    expect(parseArguments('').value).toEqual({});
    expect(parseArguments('[1]').error).toMatch(/JSON object/);
    expect(parseArguments('{oops').error).toMatch(/not valid JSON/);
  });
});

describe('glob', () => {
  it('matches common patterns', () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('a.tsx')).toBe(true);
    expect(globToRegExp('*.ts').test('a/b.ts')).toBe(false);
    expect(matchGlob('deep/dir/package.json', 'package.json')).toBe(true);
    expect(matchGlob('a/b.test.ts', '**/*.test.ts')).toBe(true);
    expect(globToRegExp('file?.[jt]s').test('file1.ts')).toBe(true);
  });
});

describe('output helpers', () => {
  it('strips ANSI codes and carriage-return progress lines', () => {
    expect(cleanOutput('\x1b[32mok\x1b[0m\r\nprogress 10%\rprogress 100%\n')).toBe('ok\nprogress 100%\n');
  });

  it('keeps head and tail when truncating', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
    const t = truncateMiddle(text, 200);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith('line 0')).toBe(true);
    expect(t.text.endsWith('line 999')).toBe(true);
    expect(t.text).toMatch(/characters, \d+ lines\) omitted|characters, \d+ lines omitted/);
  });

  it('tracks unread output and reports dropped data', () => {
    const b = new OutputBuffer(10);
    b.push('hello ');
    expect(b.sinceLastRead()).toBe('hello ');
    b.push('world');
    expect(b.sinceLastRead()).toBe('world');
    b.push('0123456789');
    b.push('abcdef');
    expect(b.sinceLastRead()).toMatch(/dropped before they were read/);
    expect(b.all()).toMatch(/abcdef$/);
  });
});
