import { commandOutcome } from '../../src/shared/format';
import type { SummaryCommand, TranscriptItem } from '../../src/shared/protocol';
import { post } from './api';

type SummaryItem = Extract<TranscriptItem, { kind: 'summary' }>;

const ACTION = { added: 'A', modified: 'M', deleted: 'D' } as const;

function ok(c: SummaryCommand): boolean | undefined {
  if (c.background) return c.status === 'done' ? undefined : false;
  if (c.status === 'denied' || c.status === 'cancelled') return undefined;
  return c.status === 'done' && c.exitCode === 0;
}

/** The facts of a run, recorded by the extension, so the user does not have to trust the model's own report. */
export function SummaryCard({ item }: { item: SummaryItem }) {
  return (
    <section class="summary" aria-label="Run summary">
      <div class="summary-head">
        <span class="summary-title">Run summary</span>
        <span class="hint">recorded by the extension, not written by the model</span>
      </div>
      {item.files.length > 0 && (
        <>
          <h3 class="summary-label">
            {item.files.length} file{item.files.length === 1 ? '' : 's'} changed by the agent
          </h3>
          <ul class="summary-list">
            {item.files.map((f) => (
              <li key={f.absolute} class="summary-file">
                <span class={`review-action action-${f.action}`} title={f.action}>
                  {ACTION[f.action]}
                </span>
                {f.action === 'deleted' ? (
                  <span title={f.absolute}>{f.display}</span>
                ) : (
                  <button class="link" onClick={() => post({ type: 'openFile', path: f.absolute })} title={f.absolute}>
                    {f.display}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {item.commands.length > 0 && (
        <>
          <h3 class="summary-label">
            {item.commands.length} command{item.commands.length === 1 ? '' : 's'}
          </h3>
          <ul class="summary-list">
            {item.commands.map((c, i) => {
              const good = ok(c);
              return (
                <li key={i} class="summary-command">
                  <code>{c.command}</code>
                  <span class={good === true ? 'outcome-ok' : good === false ? 'outcome-bad' : 'hint'}>{commandOutcome(c)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(item.warnings.length > 0 || item.unverified) && (
        <ul class="summary-list summary-warnings" aria-label="Warnings">
          {item.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
          {item.unverified && <li>⚠ Nothing was run after the last file change, so it has not been checked.</li>}
        </ul>
      )}
      {item.commands.length > 0 && <p class="hint summary-note">Files that commands create or change (for example npm install) are not listed.</p>}
    </section>
  );
}
