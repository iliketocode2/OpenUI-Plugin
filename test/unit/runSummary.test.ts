import { describe, expect, it } from 'vitest';
import { buildRunSummary, findOutputWarnings } from '../../src/agent/runSummary';
import type { SummaryFile, TranscriptItem } from '../../src/shared/protocol';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** Real output of `npm install` for a Next.js 14.2.5 project (from a live test session). */
const NPM_INSTALL =
  'npm warn deprecated next@14.2.5: This version has a security vulnerability. Please upgrade to a patched version. See https://nextjs.org/blog/security-update-2025-12-11 for more details.\n\n' +
  'added 102 packages, and audited 103 packages in 41s\n\n24 packages are looking for funding\n  run `npm fund` for details\n\n2 vulnerabilities (1 high, 1 critical)\n\n' +
  'To address all issues, run:\n  npm audit fix --force\n\nRun `npm audit` for details.';

let n = 0;
function card(tool: string, extra: Partial<ToolItem> = {}): ToolItem {
  n++;
  return { id: `c${n}`, kind: 'tool', ts: n, tool, title: tool, status: 'done', ...extra };
}
const cmd = (command: string, exitCode: number | null, extra: Partial<ToolItem> = {}) =>
  card('run_command', { input: command, title: `Run ${command}`, exitCode, status: exitCode === 0 ? 'done' : 'error', ...extra });
const file = (display: string, action: SummaryFile['action'] = 'added'): SummaryFile => ({ absolute: `/ws/${display}`, display, action });

describe('findOutputWarnings', () => {
  it('finds npm audit counts and deprecated packages in real npm output', () => {
    expect(findOutputWarnings(NPM_INSTALL)).toEqual([
      { kind: 'audit', text: 'npm audit reports 2 vulnerabilities (1 high, 1 critical).' },
      { kind: 'deprecated', text: 'next@14.2.5' },
    ]);
  });

  it('reads the npm 6 wording, and ignores zero vulnerabilities and unrelated text', () => {
    expect(findOutputWarnings('found 3 high severity vulnerabilities in 900 scanned packages')).toEqual([
      { kind: 'audit', text: 'npm audit reports 3 vulnerabilities (high severity).' },
    ]);
    expect(findOutputWarnings('found 0 vulnerabilities')).toEqual([]);
    expect(findOutputWarnings('1 vulnerability (1 moderate)')).toEqual([{ kind: 'audit', text: 'npm audit reports 1 vulnerability (1 moderate).' }]);
    expect(findOutputWarnings('Tests: 12 passed. The word deprecated appears here: but not as an npm warning.')).toEqual([]);
  });
});

describe('buildRunSummary', () => {
  it('is undefined for a run that changed nothing and ran no commands', () => {
    expect(buildRunSummary([card('read_file'), card('grep')], [])).toBeUndefined();
  });

  it('lists files and commands, and reports audit and deprecation warnings from successful commands', () => {
    const s = buildRunSummary([card('write_file'), cmd('npm install', 0, { output: NPM_INSTALL }), cmd('npm run build', 0)], [file('package.json'), file('src/app/page.tsx')])!;
    expect(s.files.map((f) => f.display)).toEqual(['package.json', 'src/app/page.tsx']);
    expect(s.commands).toEqual([
      { command: 'npm install', status: 'done', exitCode: 0, background: false },
      { command: 'npm run build', status: 'done', exitCode: 0, background: false },
    ]);
    expect(s.warnings).toEqual(['npm audit reports 2 vulnerabilities (1 high, 1 critical).', 'Deprecated package: next@14.2.5.']);
    expect(s.unverified).toBe(false);
  });

  it('reports a failed command only if its last run failed', () => {
    const fixed = buildRunSummary([card('write_file'), cmd('npm run build', 1), card('edit_file'), cmd('npm run build', 0)], [file('a.ts', 'modified')])!;
    expect(fixed.warnings).toEqual([]);
    expect(fixed.unverified).toBe(false);
    const broken = buildRunSummary([cmd('npm test', 0), cmd('npm run lint', 2), cmd('node slow.js', null)], [])!;
    expect(broken.warnings).toEqual(['“npm run lint” failed (exit 2).', '“node slow.js” failed (timed out or killed).']);
  });

  it('flags changes made after the last passing command, or with no command at all', () => {
    expect(buildRunSummary([cmd('npm test', 0), card('edit_file')], [file('a.ts', 'modified')])!.unverified).toBe(true);
    expect(buildRunSummary([card('write_file')], [file('index.html')])!.unverified).toBe(true);
    // A failing check does not verify, and neither does a background process that only started.
    expect(buildRunSummary([card('write_file'), cmd('npm test', 1)], [file('a.ts')])!.unverified).toBe(true);
    expect(buildRunSummary([card('write_file'), card('start_process', { input: 'npm run dev', status: 'done' })], [file('a.ts')])!.unverified).toBe(true);
    // An edit that failed changed nothing.
    expect(buildRunSummary([cmd('npm test', 0), card('edit_file', { status: 'error' })], [file('a.ts', 'modified')])!.unverified).toBe(false);
  });

  it('keeps denied, cancelled and background commands, without calling them failures, and shortens long commands', () => {
    const long = `node -e "${'x'.repeat(300)}"`;
    const s = buildRunSummary(
      [
        cmd('rm -rf build', null, { status: 'denied', exitCode: undefined }),
        card('start_process', { input: 'npm run dev', status: 'done' }),
        cmd(long, 0),
        card('run_command', { input: 'npm test', status: 'awaiting-approval' }),
      ],
      [],
    )!;
    expect(s.commands.map((c) => [c.status, c.background])).toEqual([
      ['denied', false],
      ['done', true],
      ['done', false],
    ]);
    expect(s.commands[2]!.command).toHaveLength(160);
    expect(s.commands[2]!.command.endsWith('…')).toBe(true);
    expect(s.warnings).toEqual([]);
  });

  it('collapses many deprecated packages into one warning', () => {
    const output = ['a@1', 'b@2', 'c@3', 'd@4', 'a@1'].map((p) => `npm warn deprecated ${p}: old`).join('\n');
    expect(buildRunSummary([cmd('npm install', 0, { output })], [])!.warnings).toEqual(['Deprecated packages: a@1, b@2, c@3 and 1 more.']);
  });
});
