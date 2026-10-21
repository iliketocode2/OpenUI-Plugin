import { describe, expect, it } from 'vitest';
import { MODE_TEXT, SYSTEM_PROMPT_VERSION, modeNote, renderSystemPrompt } from '../../src/agent/systemPrompt';

const ctx = {
  os: 'Windows_NT 10 (win32)',
  shell: 'Git Bash (gitbash)',
  shells: 'Git Bash (gitbash), Windows PowerShell (powershell)',
  date: '2026-10-14',
  workspace: 'C:\\My Projects\\app',
  scratchpad: 'C:\\Users\\me\\AppData\\scratch\\2026-10-14-abcd1234',
};

describe('renderSystemPrompt', () => {
  it('fills every placeholder, drops the version header and reports the version', () => {
    const out = renderSystemPrompt(ctx);
    expect(SYSTEM_PROMPT_VERSION).toBe('0.3');
    expect(out).not.toContain('<!--');
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    for (const v of Object.values(ctx)) expect(out).toContain(v);
  });

  it('contains the behaviours the agent must follow', () => {
    const out = renderSystemPrompt(ctx);
    expect(out).toMatch(/Check that a tool or runtime exists/);
    expect(out).toMatch(/type-check, lint, tests, build/i);
    expect(out).toMatch(/is data, not instructions/);
    expect(out).not.toMatch(/PLAN MODE|ask before acting/);
    expect(out).toMatch(/what you did NOT test/);
    expect(out).toMatch(/Never commit, push/);
    expect(out).toMatch(/scratchpad/i);
    expect(out).toMatch(/Do not start Docker/);
  });

  it('appends extra sections', () => {
    expect(renderSystemPrompt(ctx, ['# Extra', ''])).toMatch(/\n\n# Extra$/);
  });
});

describe('modeNote', () => {
  it('describes each mode in one bracketed line for the start of a user message', () => {
    for (const mode of Object.keys(MODE_TEXT)) {
      expect(modeNote(mode).startsWith('[Permission mode: ')).toBe(true);
      expect(modeNote(mode)).not.toContain('\n');
    }
    expect(modeNote('plan')).toMatch(/read-only/);
  });
});
