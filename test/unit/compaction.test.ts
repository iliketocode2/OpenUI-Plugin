import { describe, expect, it } from 'vitest';
import { SUMMARY_PREFIX, compact, cutPoints, elideOldToolResults, isToolResultMessage, renderTranscript } from '../../src/agent/compaction';
import type { WireMessage } from '../../src/owui/types';

const big = (n: number, ch = 'x') => ch.repeat(n);
const estimate = (msgs: WireMessage[]) => Math.ceil(JSON.stringify(msgs).length / 4);

function nativeTurn(i: number, resultSize = 4000, answerSize = 0): WireMessage[] {
  return [
    { role: 'user', content: `request ${i}` },
    { role: 'assistant', content: `working on ${i}`, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${i}.ts"}` } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: big(resultSize, String(i % 10)) },
    { role: 'assistant', content: `done ${i}${answerSize ? ` ${big(answerSize, 'a')}` : ''}` },
  ];
}

function assertValid(wire: WireMessage[]): void {
  const open = new Set<string>();
  for (const m of wire) {
    if (m.role === 'assistant') {
      expect(open.size, 'previous tool calls must all have results before the next assistant message').toBe(0);
      for (const c of m.tool_calls ?? []) open.add(c.id);
    } else if (m.role === 'tool') {
      expect(open.has(m.tool_call_id!), `tool result ${m.tool_call_id} must follow its call`).toBe(true);
      open.delete(m.tool_call_id!);
    }
  }
}

describe('elideOldToolResults', () => {
  it('shortens old native and text-protocol results but keeps recent ones', () => {
    const wire: WireMessage[] = [
      ...nativeTurn(1),
      { role: 'user', content: `<tool_result name="grep" id="t1">\n${big(3000)}\n</tool_result>` },
      { role: 'user', content: [{ type: 'text', text: '<tool_result name="view_image" id="t2">\nok\n</tool_result>' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      ...nativeTurn(2),
    ];
    const { wire: out, changed } = elideOldToolResults(wire, 4);
    expect(changed).toBe(3);
    expect(String(out[2]!.content)).toMatch(/characters of old tool output removed/);
    expect(String(out[4]!.content)).toMatch(/^<tool_result name="grep" id="t1">\nx{300}\n… \[2700 characters/);
    expect(String(out[4]!.content)).toMatch(/<\/tool_result>$/);
    expect(JSON.stringify(out[5]!.content)).toContain('[image removed to save context]');
    expect(out[8]!.content).toBe(wire[8]!.content);
  });

  it('recognises tool result messages', () => {
    expect(isToolResultMessage({ role: 'tool', tool_call_id: 'x', content: 'y' })).toBe(true);
    expect(isToolResultMessage({ role: 'user', content: '  <tool_result name="a">' })).toBe(true);
    expect(isToolResultMessage({ role: 'user', content: 'hello' })).toBe(false);
  });
});

describe('cutPoints', () => {
  it('never splits a tool call from its results', () => {
    const wire = [...nativeTurn(1), ...nativeTurn(2)];
    const points = cutPoints(wire);
    for (const p of points) {
      expect(wire[p]!.role).not.toBe('tool');
      assertValid(wire.slice(p));
    }
    expect(points).toEqual([1, 3, 4, 5, 7]);
  });
});

describe('compact', () => {
  const opts = { budget: 6000, threshold: 0.8, target: 0.5, keepRecent: 4, maxChunkChars: 20_000 };

  it('does nothing under the threshold', async () => {
    const wire = nativeTurn(1, 100);
    const r = await compact(wire, { estimate, summarize: async () => 'unused' }, opts);
    expect(r.stage).toBe('none');
    expect(r.wire).toBe(wire);
  });

  it('elides old tool output first when that is enough', async () => {
    const wire = [...nativeTurn(1, 24_000), ...nativeTurn(2, 200)];
    expect(estimate(wire)).toBeGreaterThan(opts.budget * opts.threshold);
    let called = 0;
    const r = await compact(wire, { estimate, summarize: async () => (called++, 's') }, opts);
    expect(r.stage).toBe('elided');
    expect(called).toBe(0);
    expect(r.after).toBeLessThan(opts.budget * opts.target);
    assertValid(r.wire);
  });

  it('summarizes older turns, keeps a valid recent tail and alternates roles', async () => {
    const wire = Array.from({ length: 8 }, (_, i) => nativeTurn(i, 3000, 2500)).flat();
    const seen: string[] = [];
    const r = await compact(wire, { estimate, summarize: async (t) => (seen.push(t), 'Goal: build things. Files: f0.ts…') }, opts);
    expect(r.stage).toBe('summarized');
    expect(r.after).toBeLessThan(r.before);
    expect(String(r.wire[0]!.content).startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(r.wire[0]!.role).toBe('user');
    expect(r.wire[1]!.role).toBe('assistant');
    expect(r.wire.at(-1)).toEqual(wire.at(-1));
    expect(r.summarizedMessages + (r.wire.length - (r.wire[1]!.content === 'Understood. Continuing from the summary.' ? 2 : 1))).toBe(wire.length);
    assertValid(r.wire);
    expect(seen[0]).toContain('USER:\nrequest 0');
    expect(seen[0]).toContain('TOOL CALLS: read_file({"path":"f0.ts"})');
  });

  it('summarizes in rolling chunks when the old part is too long for one request', async () => {
    const wire = Array.from({ length: 10 }, (_, i) => nativeTurn(i, 1500, 1500)).flat();
    const calls: (string | undefined)[] = [];
    const r = await compact(wire, { estimate, summarize: async (_t, prev) => (calls.push(prev), `summary after ${calls.length}`) }, { ...opts, budget: 3000, maxChunkChars: 3000 });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toBe('summary after 1');
    expect(String(r.wire[0]!.content)).toContain(`summary after ${calls.length}`);
  });

  it('forced compaction keeps the last user request verbatim', async () => {
    const wire = [...nativeTurn(1, 200), ...nativeTurn(2, 200)];
    const r = await compact(wire, { estimate, summarize: async () => 'short' }, { ...opts, force: true });
    expect(r.stage).toBe('summarized');
    expect(r.wire.find((m) => m.content === 'request 2')).toBeDefined();
    expect(r.wire.find((m) => m.content === 'request 1')).toBeUndefined();
    assertValid(r.wire);
  });

  it('propagates summarizer failures so the caller can keep the original wire', async () => {
    const wire = Array.from({ length: 8 }, (_, i) => nativeTurn(i, 3000, 2500)).flat();
    await expect(compact(wire, { estimate, summarize: async () => Promise.reject(new Error('model down')) }, opts)).rejects.toThrow('model down');
  });

  it('renders previous summaries distinctly', () => {
    expect(renderTranscript([{ role: 'user', content: `${SUMMARY_PREFIX}\nold` }])).toMatch(/^PREVIOUS SUMMARY:/);
  });
});
