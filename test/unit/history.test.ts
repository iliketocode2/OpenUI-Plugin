import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryStore, sanitizeForStorage, titleFrom, toMarkdown, type SessionRecord } from '../../src/storage/history';

let dir: string;
let store: HistoryStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'owui history '));
  store = new HistoryStore(path.join(dir, 'sessions'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(id: string, text: string, updated: number, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    version: 1,
    id,
    title: titleFrom([{ id: 'u', kind: 'user', text, ts: 1 }]),
    created: 1,
    updated,
    mode: 'ask',
    transcript: [
      { id: 'u', kind: 'user', text, ts: 1 },
      { id: 'a', kind: 'assistant', text: `Answer about ${text}`, reasoning: 'secret thoughts', ts: 2, streaming: false },
    ],
    wire: [
      { role: 'user', content: text },
      { role: 'assistant', content: `Answer about ${text}` },
    ],
    todos: [],
    checkpoints: [],
    ...extra,
  };
}

describe('HistoryStore', () => {
  it('saves, lists newest first, loads, renames and deletes', async () => {
    await store.save(record('s1', 'Build the planning app', 100));
    await store.save(record('s2', 'Fix the login bug', 200));
    await store.save(record('s1', 'Build the planning app', 300));
    expect((await store.list()).map((s) => [s.id, s.title, s.messages])).toEqual([
      ['s1', 'Build the planning app', 2],
      ['s2', 'Fix the login bug', 2],
    ]);
    expect((await store.load('s2'))?.wire).toHaveLength(2);
    await store.rename('s2', '  Login bug  ');
    expect((await store.list()).find((s) => s.id === 's2')?.title).toBe('Login bug');
    await store.delete('s1');
    expect((await store.list()).map((s) => s.id)).toEqual(['s2']);
    expect(await store.load('s1')).toBeUndefined();
  });

  it('searches titles and message text with a snippet', async () => {
    await store.save(record('a', 'Add Slack integration', 1));
    await store.save(record('b', 'Write docs', 2));
    const hits = await store.search('slack');
    expect(hits.map((h) => h.id)).toEqual(['a']);
    expect(hits[0]!.match?.toLowerCase()).toContain('slack');
    expect((await store.search('')).length).toBe(2);
  });

  it('rebuilds a missing or corrupt index from the session files', async () => {
    await store.save(record('a', 'One', 1));
    await store.save(record('b', 'Two', 2));
    await writeFile(path.join(store.dir, 'index.json'), '{not json');
    expect((await store.list()).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(JSON.parse(await readFile(path.join(store.dir, 'index.json'), 'utf8'))).toHaveLength(2);
  });

  it('serializes concurrent saves without losing index entries', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.save(record(`s${i}`, `task ${i}`, i))));
    expect(await store.list()).toHaveLength(12);
  });

  it('rejects unsafe session ids', async () => {
    await expect(store.save(record('../escape', 'x', 1))).rejects.toThrow(/Invalid session id/);
  });

  it('never stores image data', async () => {
    const r = record('img', 'Look at this', 1, {
      transcript: [{ id: 't', kind: 'tool', ts: 1, tool: 'view_image', title: 'View shot.png', status: 'done', image: 'data:image/png;base64,AAAA' }],
      wire: [{ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    });
    await store.save(r);
    const raw = await readFile(path.join(store.dir, 'img.json'), 'utf8');
    expect(raw).not.toContain('base64');
    expect(sanitizeForStorage(r).wire[0]!.content).toEqual([{ type: 'text', text: 'see' }, { type: 'text', text: '[image not kept in saved history]' }]);
  });
});

describe('exports', () => {
  it('renders Markdown without reasoning and with safe code fences', () => {
    const r = record('m', 'Explain fences', 1, {
      transcript: [
        { id: 'u', kind: 'user', text: 'Explain fences', ts: 1 },
        { id: 'a', kind: 'assistant', text: 'Use ``` in Markdown.', reasoning: 'hidden', ts: 2, streaming: false },
        { id: 't', kind: 'tool', ts: 3, tool: 'run_command', title: 'Run tests', status: 'done', input: 'npm test', output: 'contains ``` inside' },
      ],
    });
    const md = toMarkdown(r);
    expect(md).toMatch(/^# Explain fences/);
    expect(md).not.toContain('hidden');
    expect(md).toContain('**Tool:** Run tests (done)');
    expect(md).toContain('````\ncontains ``` inside\n````');
  });

  it('titles sessions from the first user message', () => {
    expect(titleFrom([])).toBe('Untitled session');
    expect(titleFrom([{ id: 'u', kind: 'user', text: `${'word '.repeat(30)}`, ts: 1 }]).length).toBe(70);
  });
});
