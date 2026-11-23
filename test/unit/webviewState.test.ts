import { describe, expect, it } from 'vitest';
import type { TranscriptItem, ViewState } from '../../src/shared/protocol';
import { reducer } from '../../webview/src/state';

function state(transcript: TranscriptItem[]): ViewState {
  return {
    sessionId: 's',
    connection: { baseUrl: 'http://localhost:3000', insecure: false, hasKey: true, status: 'ok' },
    models: [],
    busy: true,
    mode: 'ask',
    transcript,
    todos: [],
    sovereignty: 'local',
    noticeAcknowledged: true,
    web: { enabled: false, verification: 'unverified' },
  };
}

const assistant: TranscriptItem = { id: 'a1', kind: 'assistant', text: 'Hel', reasoning: '', ts: 1, streaming: true, interrupted: 'Retrying (1/3) in 2s' };
const tool: TranscriptItem = { id: 't1', kind: 'tool', ts: 2, tool: 'run_command', title: 'Run tests', status: 'running' };

describe('webview state reducer', () => {
  it('ignores streamed pieces until the first full state arrives', () => {
    expect(reducer(undefined, { type: 'delta', id: 'a1', kind: 'content', text: 'x' })).toBeUndefined();
  });

  it('appends streamed text to the right part of the right message, and clears a retry notice', () => {
    let s = reducer(undefined, { type: 'state', state: state([assistant, tool]) });
    s = reducer(s, { type: 'delta', id: 'a1', kind: 'content', text: 'lo' });
    s = reducer(s, { type: 'delta', id: 'a1', kind: 'reasoning', text: 'greet' });
    expect(s?.transcript[0]).toMatchObject({ text: 'Hello', reasoning: 'greet', interrupted: undefined });
    expect(s?.transcript[1]).toBe(tool);
  });

  it('patches a tool card without touching other items, and never turns a message into a card', () => {
    const before = state([assistant, tool]);
    const s = reducer(before, { type: 'toolUpdate', id: 't1', patch: { output: 'PASS', exitCode: 0 } });
    expect(s?.transcript[1]).toMatchObject({ title: 'Run tests', output: 'PASS', exitCode: 0 });
    expect(s?.transcript[0]).toBe(assistant);
    expect(reducer(before, { type: 'toolUpdate', id: 'a1', patch: { output: 'x' } })?.transcript[0]).toBe(assistant);
    expect(before.transcript[1]).toBe(tool);
    expect(tool).not.toHaveProperty('output');
  });

  it('replaces everything with a new full state', () => {
    const next = state([]);
    expect(reducer(state([assistant]), { type: 'state', state: next })).toBe(next);
  });
});
