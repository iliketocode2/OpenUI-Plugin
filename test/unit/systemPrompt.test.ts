import { describe, expect, it } from 'vitest';
import { MODE_TEXT, SYSTEM_PROMPT_VERSION, modeNote, renderSystemPrompt, scratchpadNote } from '../../src/agent/systemPrompt';

const ctx = {
  os: 'Windows_NT 10 (win32)',
  shell: 'Git Bash (gitbash)',
  shells: 'Git Bash (gitbash), Windows PowerShell (powershell)',
  date: '2026-10-14',
  workspace: 'C:\\My Projects\\app',
};

describe('renderSystemPrompt', () => {
  it('fills every placeholder, drops the version header and reports the version', () => {
    const out = renderSystemPrompt(ctx);
    expect(SYSTEM_PROMPT_VERSION).toBe('0.5');
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

  it('stops after a plan when the user asks for one in words', () => {
    const out = renderSystemPrompt(ctx);
    expect(out).toMatch(/asks you to go into planning mode, only read and search to investigate, then reply with a numbered plan/);
    expect(out).toMatch(/Do not edit files or run commands until the user approves the plan/);
  });

  it('asks for fewer output tokens: batched calls, task list updates, brief narration, scaffolding commands', () => {
    const out = renderSystemPrompt(ctx);
    expect(out).toMatch(/do not depend on each other in the same turn/);
    expect(out).toMatch(/todo_write: create it once, then mark progress with its `update` argument/);
    expect(out).toMatch(/at most one short sentence/);
    expect(out).toMatch(/official scaffolding command/);
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

describe('scratchpadNote', () => {
  it('names the session scratchpad in one bracketed line, which the instructions point to', () => {
    expect(scratchpadNote('C:\\scratch\\2026-10-14-abcd1234')).toBe('[Session scratchpad: C:\\scratch\\2026-10-14-abcd1234]');
    expect(renderSystemPrompt(ctx)).toContain('[Session scratchpad: …]');
    expect(renderSystemPrompt(ctx)).not.toMatch(/\{\{scratchpad\}\}/);
  });
});
