import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { WireMessage } from '../owui/types';
import type { AgentMode, TodoItem, TranscriptItem } from '../shared/protocol';

export interface SerializedCheckpoint {
  id: string;
  label: string;
  ts: number;
  sha?: string;
  originals: [string, string | null][];
}

export interface SessionRecord {
  version: 1;
  id: string;
  title: string;
  created: number;
  updated: number;
  model?: string;
  mode: AgentMode;
  transcript: TranscriptItem[];
  wire: WireMessage[];
  todos: TodoItem[];
  checkpoints: SerializedCheckpoint[];
  scratchpad?: string;
  turns?: [string, { wire: number; transcript: number }][];
}

export interface SessionSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  model?: string;
  messages: number;
  preview: string;
  match?: string;
}

const INDEX = 'index.json';
const IMAGE_NOTE = '[image not kept in saved history]';

export function sanitizeForStorage(record: SessionRecord): SessionRecord {
  const transcript = record.transcript.map((t) => (t.kind === 'tool' && t.image ? { ...t, image: undefined, output: [t.output, IMAGE_NOTE].filter(Boolean).join('\n') } : t));
  const wire = record.wire.map((m) =>
    Array.isArray(m.content) ? { ...m, content: m.content.map((p) => (p.type === 'image_url' ? { type: 'text' as const, text: IMAGE_NOTE } : p)) } : m,
  );
  return { ...record, transcript, wire };
}

export function titleFrom(transcript: TranscriptItem[]): string {
  const first = transcript.find((t) => t.kind === 'user');
  const text = first && first.kind === 'user' ? first.text.replace(/\s+/g, ' ').trim() : 'Untitled session';
  return text.length > 70 ? `${text.slice(0, 69)}…` : text;
}

function summarize(r: SessionRecord): SessionSummary {
  const last = [...r.transcript].reverse().find((t) => t.kind === 'assistant' && t.text.trim());
  const preview = last && last.kind === 'assistant' ? last.text.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
  const s: SessionSummary = { id: r.id, title: r.title, created: r.created, updated: r.updated, messages: r.transcript.filter((t) => t.kind === 'user' || t.kind === 'assistant').length, preview };
  if (r.model) s.model = r.model;
  return s;
}

function searchableText(r: SessionRecord): string {
  return [
    r.title,
    ...r.transcript.map((t) => {
      switch (t.kind) {
        case 'user':
        case 'assistant':
          return t.text;
        case 'tool':
          return `${t.title} ${t.input ?? ''}`;
        default:
          return '';
      }
    }),
  ].join('\n');
}

export class HistoryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly textCache = new Map<string, { updated: number; text: string }>();

  constructor(readonly dir: string) {}

  private file(id: string): string {
    if (!/^[\w-]{1,80}$/.test(id)) throw new Error('Invalid session id.');
    return path.join(this.dir, `${id}.json`);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  save(record: SessionRecord): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true });
      const clean = sanitizeForStorage(record);
      await atomicWrite(this.file(record.id), JSON.stringify(clean));
      const index = (await this.readIndex()).filter((s) => s.id !== record.id);
      index.push(summarize(clean));
      await this.writeIndex(index);
    });
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    try {
      const r = JSON.parse(await readFile(this.file(id), 'utf8')) as SessionRecord;
      if (r.version !== 1) return undefined;
      return { ...r, transcript: r.transcript.map(fromLegacyItem) };
    } catch {
      return undefined;
    }
  }

  list(): Promise<SessionSummary[]> {
    return this.serial(async () => (await this.readIndex()).sort((a, b) => b.updated - a.updated));
  }

  async search(query: string): Promise<SessionSummary[]> {
    const q = query.trim().toLowerCase();
    const all = await this.list();
    if (!q) return all;
    const out: SessionSummary[] = [];
    for (const s of all) {
      let text = this.textCache.get(s.id)?.updated === s.updated ? this.textCache.get(s.id)!.text : undefined;
      if (text === undefined) {
        const r = await this.load(s.id);
        if (!r) continue;
        text = searchableText(r);
        this.textCache.set(s.id, { updated: s.updated, text });
      }
      const at = text.toLowerCase().indexOf(q);
      if (at === -1) continue;
      const start = Math.max(0, at - 40);
      out.push({ ...s, match: `${start ? '…' : ''}${text.slice(start, at + q.length + 60).replace(/\s+/g, ' ')}…` });
    }
    return out;
  }

  rename(id: string, title: string): Promise<void> {
    return this.serial(async () => {
      const r = await this.load(id);
      if (!r) return;
      r.title = title.trim().slice(0, 120) || r.title;
      await atomicWrite(this.file(id), JSON.stringify(r));
      const index = (await this.readIndex()).map((s) => (s.id === id ? { ...s, title: r.title } : s));
      await this.writeIndex(index);
    });
  }

  delete(id: string): Promise<void> {
    return this.serial(async () => {
      await rm(this.file(id), { force: true });
      await this.writeIndex((await this.readIndex()).filter((s) => s.id !== id));
    });
  }

  private async readIndex(): Promise<SessionSummary[]> {
    try {
      const parsed = JSON.parse(await readFile(path.join(this.dir, INDEX), 'utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed as SessionSummary[];
    } catch {
      // rebuilt below
    }
    return this.rebuildIndex();
  }

  private async rebuildIndex(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json') && n !== INDEX);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const n of names) {
      const r = await this.load(n.slice(0, -5));
      if (r) out.push(summarize(r));
    }
    if (out.length) await this.writeIndex(out);
    return out;
  }

  private async writeIndex(index: SessionSummary[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(path.join(this.dir, INDEX), JSON.stringify(index));
  }
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, 'utf8');
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export function toMarkdown(r: SessionRecord): string {
  const out: string[] = [`# ${r.title}`, '', `- Session: ${r.id}`, `- Started: ${new Date(r.created).toISOString()}`, `- Updated: ${new Date(r.updated).toISOString()}`];
  if (r.model) out.push(`- Model: ${r.model}`);
  out.push('');
  const fence = (s: string) => {
    const ticks = (s.match(/`{3,}/g) ?? []).reduce((n, m) => Math.max(n, m.length + 1), 3);
    return '`'.repeat(ticks);
  };
  for (const t of r.transcript) {
    switch (t.kind) {
      case 'user':
        out.push(`## User · ${new Date(t.ts).toLocaleString()}`, '', t.text, '');
        break;
      case 'assistant':
        if (t.text.trim()) out.push(`## Assistant · ${new Date(t.ts).toLocaleString()}`, '', t.text.trim(), '');
        break;
      case 'tool': {
        out.push(`**Tool:** ${t.title} (${t.status})`, '');
        if (t.input) out.push(`${fence(t.input)}\n${t.input}\n${fence(t.input)}`, '');
        if (t.diff) out.push(`${fence(t.diff)}diff\n${t.diff}\n${fence(t.diff)}`, '');
        if (t.output) out.push(`${fence(t.output)}\n${t.output}\n${fence(t.output)}`, '');
        break;
      }
      case 'question':
        out.push('**Questions:**', ...t.questions.map((q, i) => `- ${q.question} → ${(t.answers?.[i] ?? []).join(', ') || '(no answer)'}`), '');
        break;
      case 'review':
        out.push('**Review:**', ...t.files.map((f) => `- ${f.display}: ${f.decision ?? 'pending'}`), '');
        break;
      case 'error':
      case 'warning':
      case 'notice':
        out.push(`> ${t.kind === 'error' ? 'Error' : t.kind === 'warning' ? 'Warning' : 'Note'}: ${t.text}`, '');
        break;
    }
  }
  return `${out.join('\n').trim()}\n`;
}

/** Sessions saved before plan review was removed contain 'plan' items; show those plans as ordinary replies. */
function fromLegacyItem(t: TranscriptItem): TranscriptItem {
  const legacy = t as unknown as { kind: string; id: string; ts: number; plan?: string };
  if (legacy.kind !== 'plan') return t;
  return { id: legacy.id, kind: 'assistant', ts: legacy.ts, text: legacy.plan ?? '', reasoning: '', streaming: false };
}
