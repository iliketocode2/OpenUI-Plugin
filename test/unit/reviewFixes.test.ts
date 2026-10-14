import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentState } from '../../src/config/state';
import { looksLikeSecret, upsertIndexLine } from '../../src/memory/projectMemory';

describe('memory index with special characters', () => {
  it('does not expand $ patterns in summaries', () => {
    let idx = upsertIndexLine('', 'x', 'old');
    idx = upsertIndexLine(idx, 'y', 'other');
    idx = upsertIndexLine(idx, 'x', "costs $& and $' and $1");
    expect(idx).toContain("- [x](x.md) — costs $& and $' and $1");
    expect(idx.match(/\[y\]/g)).toHaveLength(1);
  });
});

describe('secret detection for project memory', () => {
  it('catches common secret formats', () => {
    for (const s of [
      'OPENAI_API_KEY=sk-abcdefghijklmnop',
      '{"apiKey": "abcdefghijklmnop"}',
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      'the password is hunter2hunter2',
      'aws AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-1234567890-abcdef',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ]) {
      expect(looksLikeSecret(s), s).toBe(true);
    }
  });

  it('allows ordinary project facts', () => {
    for (const s of [
      'The password reset flow lives in src/auth/reset.ts',
      'Uses a token bucket rate limiter',
      'API keys are read from the OPENAI_API_KEY environment variable',
      'Run `pnpm test`; the secret sauce is the cache layer',
    ]) {
      expect(looksLikeSecret(s), s).toBe(false);
    }
  });
});

describe('palette validator path detection', () => {
  it('runs from folders whose names contain #, % and spaces', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'owui palette '));
    try {
      for (const name of ['a#b', 'pct%20x', 'with space']) {
        const dir = path.join(base, name);
        await mkdir(dir, { recursive: true });
        const script = path.join(dir, 'validate_palette.mjs');
        await copyFile(path.join(__dirname, '..', '..', 'examples', 'skills', 'dataviz', 'validate_palette.mjs'), script);
        const out = execFileSync(process.execPath, [script, '#0072B2', '#D55E00'], { encoding: 'utf8' });
        expect(out, name).toMatch(/PASS/);
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe('PersistentState', () => {
  it('keeps the latest value even if the underlying storage replaces its snapshot', async () => {
    let snapshot: Record<string, unknown> = {};
    const writes: string[] = [];
    const memento = {
      keys: () => Object.keys(snapshot),
      get: <T>(k: string) => snapshot[k] as T | undefined,
      update: async (k: string, v: unknown) => {
        await new Promise((r) => setTimeout(r, 5));
        writes.push(k);
        snapshot = { ...snapshot, [k]: v };
      },
    };
    const state = new PersistentState(memento);
    void state.update('mode', 'plan');
    void state.update('totals', { n: 1 });
    snapshot = {};
    expect(state.get('mode', 'ask')).toBe('plan');
    expect(state.get('missing', 'fallback')).toBe('fallback');
    await state.flush();
    expect(writes).toEqual(['mode', 'totals']);
    expect(snapshot).toEqual({ mode: 'plan', totals: { n: 1 } });
  });
});
