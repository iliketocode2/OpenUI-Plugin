import type { RunSummary, SummaryCommand, SummaryFile, TranscriptItem } from '../shared/protocol';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const COMMAND_TOOLS = new Set(['run_command', 'start_process']);
/** Tools whose successful run changes files; a later successful command counts as checking those changes. */
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'update_memory']);
const MAX_COMMAND_CHARS = 160;
const MAX_DEPRECATED = 3;

/**
 * What a run did, from what the extension recorded rather than from the model's own report: the files the agent
 * changed, the commands it ran with their exit codes, warnings found in command output, and whether anything ran
 * after the last file change. Undefined when the run changed nothing and ran no commands.
 */
export function buildRunSummary(cards: ToolItem[], files: SummaryFile[]): RunSummary | undefined {
  const commandCards = cards.filter((c) => COMMAND_TOOLS.has(c.tool) && c.status !== 'pending' && c.status !== 'awaiting-approval');
  if (!files.length && !commandCards.length) return undefined;

  const commands: SummaryCommand[] = commandCards.map((c) => {
    const command = (c.input ?? c.title).trim();
    const out: SummaryCommand = {
      command: command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS - 1)}…` : command,
      status: c.status,
      background: c.tool === 'start_process',
    };
    if (c.exitCode !== undefined) out.exitCode = c.exitCode;
    return out;
  });

  const warnings: string[] = [];
  const seen = new Set<string>();
  const add = (w: string) => {
    if (!seen.has(w)) {
      seen.add(w);
      warnings.push(w);
    }
  };
  // Only the last run of each command decides whether it failed: a failure that was fixed and re-run is not a warning.
  const lastRun = new Map<string, SummaryCommand>();
  for (const c of commands) if (!c.background && (c.status === 'done' || c.status === 'error')) lastRun.set(c.command, c);
  for (const c of lastRun.values()) {
    if (c.status === 'error' || (c.exitCode !== undefined && c.exitCode !== 0)) {
      // Plain text, shown as is: quotation marks rather than Markdown backticks.
      add(`“${c.command}” failed${typeof c.exitCode === 'number' ? ` (exit ${c.exitCode})` : c.exitCode === null ? ' (timed out or killed)' : ''}.`);
    }
  }
  const deprecated: string[] = [];
  for (const c of commandCards) {
    for (const w of findOutputWarnings(c.output ?? '')) {
      if (w.kind === 'deprecated') {
        if (!deprecated.includes(w.text)) deprecated.push(w.text);
      } else add(w.text);
    }
  }
  if (deprecated.length) {
    const shown = deprecated.slice(0, MAX_DEPRECATED).join(', ');
    add(`Deprecated package${deprecated.length > 1 ? 's' : ''}: ${shown}${deprecated.length > MAX_DEPRECATED ? ` and ${deprecated.length - MAX_DEPRECATED} more` : ''}.`);
  }

  let lastEdit = -1;
  let lastPassingCheck = -1;
  cards.forEach((c, i) => {
    if (EDIT_TOOLS.has(c.tool) && c.status === 'done') lastEdit = i;
    if (c.tool === 'run_command' && c.status === 'done' && c.exitCode === 0) lastPassingCheck = i;
  });
  const unverified = files.length > 0 && lastPassingCheck < lastEdit;
  return { files, commands, warnings, unverified };
}

export interface OutputWarning {
  kind: 'audit' | 'deprecated';
  text: string;
}

/** Warnings worth showing even when the command succeeded. Deliberately few patterns, so nothing is invented. */
export function findOutputWarnings(output: string): OutputWarning[] {
  const found: OutputWarning[] = [];
  // npm 7+: "2 vulnerabilities (1 high, 1 critical)"; npm 6: "found 3 high severity vulnerabilities".
  const audit = /\b(\d+) vulnerabilit(?:y|ies) \(([^)]+)\)/i.exec(output) ?? /found (\d+) ((?:low|moderate|high|critical) severity) vulnerabilit/i.exec(output);
  if (audit && Number(audit[1]) > 0) {
    const n = Number(audit[1]);
    found.push({ kind: 'audit', text: `npm audit reports ${n} ${n === 1 ? 'vulnerability' : 'vulnerabilities'} (${audit[2]}).` });
  }
  for (const m of output.matchAll(/npm warn deprecated (\S+?):/gi)) found.push({ kind: 'deprecated', text: m[1]! });
  return found;
}
