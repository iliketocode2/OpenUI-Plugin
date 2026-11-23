import template from '../../prompts/compaction.md';
import type { ContentPart, WireMessage } from '../owui/types';

export const COMPACTION_PROMPT = template.replace(/^<!--[^\n]*-->\s*\n/, '').trim();
export const SUMMARY_PREFIX = '[Summary of the earlier conversation. Older messages were compacted to save context.]';

const ELIDE_OVER = 800;
const ELIDE_KEEP = 300;
const RESULT_CHARS_IN_SUMMARY_INPUT = 1500;

export interface CompactionDeps {
  estimate(messages: WireMessage[]): number;
  summarize(transcript: string, previous: string | undefined): Promise<string>;
}

export interface CompactionResult {
  wire: WireMessage[];
  stage: 'none' | 'elided' | 'summarized';
  before: number;
  after: number;
  summarizedMessages: number;
}

function textOf(content: WireMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('\n');
}

function elideText(text: string): string {
  if (text.length <= ELIDE_OVER) return text;
  return `${text.slice(0, ELIDE_KEEP)}\n… [${text.length - ELIDE_KEEP} characters of old tool output removed to save context; re-run the tool if you need them]`;
}

export function elideOldToolResults(wire: WireMessage[], keepLast: number): { wire: WireMessage[]; changed: number } {
  let changed = 0;
  const limit = Math.max(0, wire.length - keepLast);
  const out = wire.map((m, i) => {
    if (i >= limit) return m;
    if (m.role === 'tool') {
      const text = textOf(m.content);
      const next = elideText(text);
      if (next === text) return m;
      changed++;
      return { ...m, content: next };
    }
    // Images on the wire come from view_image; old ones cost hundreds of tokens each and can be viewed again.
    if (Array.isArray(m.content) && m.content.some((p) => p.type !== 'text')) {
      changed++;
      const parts: ContentPart[] = m.content.map((p) => (p.type === 'text' ? p : { type: 'text', text: '[image removed to save context]' }));
      return { ...m, content: parts };
    }
    return m;
  });
  return { wire: out, changed };
}

export function cutPoints(wire: WireMessage[]): number[] {
  const points: number[] = [];
  for (let i = 1; i < wire.length; i++) {
    const m = wire[i]!;
    if (m.role === 'assistant' || m.role === 'user') points.push(i);
  }
  return points;
}

export function renderTranscript(messages: WireMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'tool') return `TOOL RESULT (${m.tool_call_id ?? ''}):\n${clip(textOf(m.content))}`;
      const head = m.role === 'user' ? (textOf(m.content).startsWith(SUMMARY_PREFIX) ? 'PREVIOUS SUMMARY' : 'USER') : m.role.toUpperCase();
      const calls = m.tool_calls?.length ? `\nTOOL CALLS: ${m.tool_calls.map((c) => `${c.function.name}(${clip(c.function.arguments, 400)})`).join('; ')}` : '';
      return `${head}:\n${textOf(m.content)}${calls}`;
    })
    .join('\n\n');
}

function clip(text: string, max = RESULT_CHARS_IN_SUMMARY_INPUT): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
}

function chunkMessages(messages: WireMessage[], maxChars: number): WireMessage[][] {
  const chunks: WireMessage[][] = [];
  let cur: WireMessage[] = [];
  let size = 0;
  for (const m of messages) {
    const len = renderTranscript([m]).length;
    if (cur.length && size + len > maxChars) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export interface CompactOptions {
  budget: number;
  threshold: number;
  target: number;
  keepRecent: number;
  maxChunkChars: number;
  force?: boolean;
}

export async function compact(wire: WireMessage[], deps: CompactionDeps, opts: CompactOptions): Promise<CompactionResult> {
  const before = deps.estimate(wire);
  if (!opts.force && before < opts.budget * opts.threshold) return { wire, stage: 'none', before, after: before, summarizedMessages: 0 };

  const elided = elideOldToolResults(wire, opts.keepRecent);
  const afterElide = deps.estimate(elided.wire);
  if (!opts.force && afterElide < opts.budget * opts.target) {
    return { wire: elided.wire, stage: elided.changed ? 'elided' : 'none', before, after: afterElide, summarizedMessages: 0 };
  }

  const points = cutPoints(elided.wire);
  if (!points.length) return { wire: elided.wire, stage: elided.changed ? 'elided' : 'none', before, after: afterElide, summarizedMessages: 0 };
  const lastUser = [...points].reverse().find((i) => elided.wire[i]!.role === 'user');
  const latestAllowed = opts.force ? (lastUser ?? points[points.length - 1]!) : points[points.length - 1]!;
  let cut = points.find((i) => i <= latestAllowed && deps.estimate(elided.wire.slice(i)) <= opts.budget * opts.target) ?? latestAllowed;
  if (cut <= 0) cut = latestAllowed;

  const older = elided.wire.slice(0, cut);
  const tail = elided.wire.slice(cut);
  let summary: string | undefined;
  for (const chunk of chunkMessages(older, opts.maxChunkChars)) {
    summary = (await deps.summarize(renderTranscript(chunk), summary)).trim();
  }
  const head: WireMessage[] = [{ role: 'user', content: `${SUMMARY_PREFIX}\n\n${summary ?? ''}` }];
  if (tail[0]?.role !== 'assistant') head.push({ role: 'assistant', content: 'Understood. Continuing from the summary.' });
  const next = [...head, ...tail];
  return { wire: next, stage: 'summarized', before, after: deps.estimate(next), summarizedMessages: older.length };
}
