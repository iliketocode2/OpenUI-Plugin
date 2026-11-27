import type { SummaryCommand } from './protocol';

/** "0.4s", "41.2s", "3m12s", "1h05m": short enough for a log line or a tool card header. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/** "exit 0", "exit 1", "timed out or killed", "started in the background", or the card status. */
export function commandOutcome(c: SummaryCommand): string {
  if (c.background) return c.status === 'done' ? 'started in the background' : c.status;
  if (typeof c.exitCode === 'number') return `exit ${c.exitCode}`;
  return c.status === 'error' && c.exitCode === null ? 'timed out or killed' : c.status;
}
