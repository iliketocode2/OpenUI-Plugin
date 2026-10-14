import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT_VERSION, renderSystemPrompt } from '../../src/agent/systemPrompt';

describe('renderSystemPrompt', () => {
  it('fills placeholders, drops the version header and reports the version', () => {
    const out = renderSystemPrompt({ os: 'Windows_NT 10 (win32)', date: '2026-10-14', workspace: 'C:\\My Projects\\app' });
    expect(SYSTEM_PROMPT_VERSION).toMatch(/^\d+\.\d+/);
    expect(out).not.toContain('<!--');
    expect(out).not.toMatch(/\{\{\w+\}\}/);
    expect(out).toContain('C:\\My Projects\\app');
    expect(out).toContain('2026-10-14');
  });
});
