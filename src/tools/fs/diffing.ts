import { structuredPatch } from 'diff';

export interface DiffSummary {
  unified: string;
  added: number;
  removed: number;
}

const MAX_DIFF_LINES = 400;

export function computeDiff(before: string, after: string, context = 3): DiffSummary {
  const a = before.replace(/\r\n/g, '\n');
  const b = after.replace(/\r\n/g, '\n');
  const patch = structuredPatch('a', 'b', a, b, undefined, undefined, { context });
  let added = 0;
  let removed = 0;
  const lines: string[] = [];
  for (const h of patch.hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
      if (!l.startsWith('\\')) lines.push(l);
    }
  }
  const unified = lines.length > MAX_DIFF_LINES ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more diff lines`].join('\n') : lines.join('\n');
  return { unified, added, removed };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function changeSummary(d: DiffSummary): string {
  if (!d.added && !d.removed) return 'No changes';
  const parts: string[] = [];
  if (d.added) parts.push(`Added ${plural(d.added, 'line')}`);
  if (d.removed) parts.push(`${d.added ? 'removed' : 'Removed'} ${plural(d.removed, 'line')}`);
  return parts.join(', ');
}

export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split(/\r?\n/).length;
  return /\r?\n$/.test(text) ? n - 1 : n;
}
