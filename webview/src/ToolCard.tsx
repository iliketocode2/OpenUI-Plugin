import { useEffect, useRef, useState } from 'preact/hooks';
import type { ApprovalDecision, TranscriptItem } from '../../src/shared/protocol';
import { post } from './api';

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const STATUS: Record<ToolItem['status'], { icon: string; label: string }> = {
  pending: { icon: '…', label: 'Preparing' },
  'awaiting-approval': { icon: '?', label: 'Waiting for your approval' },
  running: { icon: '◌', label: 'Running' },
  done: { icon: '✓', label: 'Done' },
  error: { icon: '✗', label: 'Failed' },
  denied: { icon: '⊘', label: 'Denied' },
  cancelled: { icon: '■', label: 'Cancelled' },
};

function defaultOpen(item: ToolItem): boolean {
  if (item.status === 'awaiting-approval' || item.status === 'error') return true;
  if (item.status === 'running' && item.input) return true;
  return false;
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(() => defaultOpen(item));
  const prevStatus = useRef(item.status);
  useEffect(() => {
    if (prevStatus.current !== item.status) {
      if (item.status === 'awaiting-approval' || item.status === 'error') setOpen(true);
      if (item.status === 'done' && prevStatus.current === 'running' && !item.input) setOpen(false);
      prevStatus.current = item.status;
    }
  }, [item.status, item.input]);
  const s = STATUS[item.status];
  const hasBody = !!(item.input || item.output || item.diff || item.image || item.description || item.approval);
  return (
    <div class={`tool tool-${item.status}`}>
      <button class="tool-head" aria-expanded={hasBody ? open : undefined} onClick={() => hasBody && setOpen(!open)} disabled={!hasBody}>
        <span class={`tool-icon icon-${item.status}`} role="img" aria-label={s.label} title={s.label}>
          {s.icon}
        </span>
        <span class="tool-title">{item.title}</span>
        {item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0 && <span class="tool-exit">exit {item.exitCode}</span>}
        {hasBody && <span class="chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasBody && (
        <div class="tool-body">
          {item.input && (
            <div class="io">
              <span class="io-label">IN</span>
              <pre class="io-text">{item.input}</pre>
            </div>
          )}
          {item.diff && <Diff text={item.diff} />}
          {item.image && <img class="tool-image" src={item.image} alt={item.title} />}
          {item.diffId && (
            <div class="actions tool-actions">
              <button class="btn btn-secondary btn-small" onClick={() => post({ type: 'openDiff', diffId: item.diffId! })}>
                Open diff
              </button>
            </div>
          )}
          {item.output && (
            <div class="io">
              <span class="io-label">OUT</span>
              <pre class="io-text">{item.output}</pre>
            </div>
          )}
        </div>
      )}
      {item.approval && item.status === 'awaiting-approval' && <Approval id={item.id} approval={item.approval} />}
    </div>
  );
}

function Diff({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre class="diff" aria-label="Proposed changes">
      {lines.map((l, i) => {
        const cls = l.startsWith('@@') ? 'd-hunk' : l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : 'd-ctx';
        return (
          <span key={i} class={cls}>
            {l}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function Approval({ id, approval }: { id: string; approval: NonNullable<ToolItem['approval']> }) {
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => allowRef.current?.focus(), []);
  const decide = (decision: ApprovalDecision) => post({ type: 'approve', id, decision });
  const danger = approval.warnings.length > 0 && approval.kind === 'command';
  return (
    <div class={`approval ${danger ? 'approval-danger' : ''}`} role="group" aria-label="Approval required">
      <p class="approval-q">{approval.question}</p>
      {approval.warnings.length > 0 && (
        <ul class="approval-warnings">
          {approval.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {feedback === undefined ? (
        <div class="actions">
          <button ref={allowRef} class="btn" onClick={() => decide({ decision: 'allow' })}>
            {approval.kind === 'edit' || approval.kind === 'write' ? 'Apply' : 'Allow'}
          </button>
          {approval.allowAlways && (
            <button class="btn btn-secondary" onClick={() => decide({ decision: 'allowAlways' })} title="Adds this prefix to owuiAgent.commands.allowlist for this workspace">
              Always allow <code>{approval.allowAlways}</code>
            </button>
          )}
          <button class="btn btn-secondary" onClick={() => decide({ decision: 'deny' })}>
            Deny
          </button>
          <button class="btn btn-secondary" onClick={() => setFeedback('')}>
            Deny with feedback…
          </button>
        </div>
      ) : (
        <form
          class="feedback"
          onSubmit={(e) => {
            e.preventDefault();
            decide({ decision: 'deny', feedback: feedback.trim() });
          }}
        >
          <label class="sr-only" for={`fb-${id}`}>
            Tell the agent what to do instead
          </label>
          <textarea
            id={`fb-${id}`}
            rows={2}
            value={feedback}
            placeholder="Tell the agent what to do instead"
            onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)}
            ref={(el) => el?.focus()}
          />
          <div class="actions">
            <button class="btn" type="submit" disabled={!feedback.trim()}>
              Send and deny
            </button>
            <button class="btn btn-secondary" type="button" onClick={() => setFeedback(undefined)}>
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
