import { useMemo, useState } from 'preact/hooks';
import type { AgentMode, RewindScope, TranscriptItem } from '../../src/shared/protocol';
import { post, returnFocusToComposer } from './api';
import { renderMarkdown } from './markdown';

type PlanItem = Extract<TranscriptItem, { kind: 'plan' }>;
type ReviewItem = Extract<TranscriptItem, { kind: 'review' }>;

const APPROVE: { mode: Exclude<AgentMode, 'plan'>; label: string }[] = [
  { mode: 'ask', label: 'Approve, ask before edits' },
  { mode: 'auto', label: 'Approve, auto-accept edits' },
  { mode: 'review', label: 'Approve, review at end' },
];

const MODE_LABEL: Record<AgentMode, string> = { plan: 'plan mode', ask: 'ask before edits', auto: 'auto-accept edits', review: 'review at end' };

export function PlanCard({ item }: { item: PlanItem }) {
  const html = useMemo(() => renderMarkdown(item.plan), [item.plan]);
  const [feedback, setFeedback] = useState<string | undefined>(undefined);
  return (
    <section class={`plan plan-${item.status}`} aria-label="Plan for approval">
      <div class="plan-head">
        <span class="plan-title">Plan</span>
        {item.status === 'approved' && <span class="tag">Approved · {MODE_LABEL[item.approvedMode ?? 'ask']}</span>}
        {item.status === 'revise' && <span class="tag">Changes requested</span>}
        {item.status === 'cancelled' && <span class="tag">Cancelled</span>}
      </div>
      <div class="markdown plan-body" dangerouslySetInnerHTML={{ __html: html }} />
      {item.status === 'revise' && item.feedback && <p class="plan-feedback">You asked: {item.feedback}</p>}
      {item.status === 'open' &&
        (feedback === undefined ? (
          <div class="actions">
            {APPROVE.map((a, i) => (
              <button
                key={a.mode}
                class={`btn ${i ? 'btn-secondary' : ''}`}
                onClick={() => {
                  post({ type: 'planDecision', id: item.id, answer: { approved: true, mode: a.mode } });
                  returnFocusToComposer();
                }}
              >
                {a.label}
              </button>
            ))}
            <button class="btn btn-secondary" onClick={() => setFeedback('')}>
              Keep planning…
            </button>
          </div>
        ) : (
          <form
            class="feedback"
            onSubmit={(e) => {
              e.preventDefault();
              if (feedback.trim()) {
                post({ type: 'planDecision', id: item.id, answer: { approved: false, feedback: feedback.trim() } });
                returnFocusToComposer();
              }
            }}
          >
            <label class="sr-only" for={`pf-${item.id}`}>
              What should change in the plan?
            </label>
            <textarea id={`pf-${item.id}`} rows={3} value={feedback} placeholder="What should change in the plan?" onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)} ref={(el) => el?.focus()} />
            <div class="actions">
              <button class="btn" type="submit" disabled={!feedback.trim()}>
                Send feedback
              </button>
              <button class="btn btn-secondary" type="button" onClick={() => setFeedback(undefined)}>
                Back
              </button>
            </div>
          </form>
        ))}
    </section>
  );
}

export function ReviewCard({ item }: { item: ReviewItem }) {
  const open = item.files.filter((f) => !f.decision).length;
  return (
    <section class="review" aria-label="Review changes">
      <div class="plan-head">
        <span class="plan-title">Review changes</span>
        <span class="tag">{open ? `${open} to review` : 'Done'}</span>
      </div>
      <ul class="review-files">
        {item.files.map((f) => (
          <li key={f.absolute} class="review-file">
            <span class={`review-action action-${f.action}`}>{f.action === 'added' ? 'A' : 'M'}</span>
            <button class="link" onClick={() => post({ type: 'openFile', path: f.absolute })} title={f.absolute}>
              {f.display}
            </button>
            <span class="review-buttons">
              {f.diffId && (
                <button class="btn btn-secondary btn-small" onClick={() => post({ type: 'openDiff', diffId: f.diffId! })}>
                  Diff
                </button>
              )}
              {f.decision ? (
                <span class="tag">{f.decision === 'kept' ? 'Kept' : 'Reverted'}</span>
              ) : (
                <>
                  <button class="btn btn-small" onClick={() => post({ type: 'review', id: item.id, absolute: f.absolute, decision: 'keep' })}>
                    Keep
                  </button>
                  <button class="btn btn-secondary btn-small" onClick={() => post({ type: 'review', id: item.id, absolute: f.absolute, decision: 'revert' })}>
                    Revert
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {open > 1 && (
        <div class="actions">
          <button class="btn" onClick={() => post({ type: 'review', id: item.id, decision: 'keep' })}>
            Keep all
          </button>
          <button class="btn btn-secondary" onClick={() => post({ type: 'review', id: item.id, decision: 'revert' })}>
            Revert all
          </button>
        </div>
      )}
    </section>
  );
}

export function RewindControl({ itemId, disabled }: { itemId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const go = (scope: RewindScope) => {
    setOpen(false);
    post({ type: 'rewind', itemId, scope });
  };
  if (!open) {
    return (
      <button class="link rewind" disabled={disabled} onClick={() => setOpen(true)} title={disabled ? 'Stop the agent to rewind' : 'Rewind to before this message'}>
        Rewind
      </button>
    );
  }
  return (
    <span class="rewind-menu" role="group" aria-label="Rewind options">
      <button class="btn btn-small" onClick={() => go('both')} ref={(el) => el?.focus()}>
        Code and conversation
      </button>
      <button class="btn btn-secondary btn-small" onClick={() => go('code')}>
        Code only
      </button>
      <button class="btn btn-secondary btn-small" onClick={() => go('conversation')}>
        Conversation only
      </button>
      <button class="btn btn-secondary btn-small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </span>
  );
}
