import { useState } from 'preact/hooks';
import type { RewindScope, TranscriptItem } from '../../src/shared/protocol';
import { post } from './api';

type ReviewItem = Extract<TranscriptItem, { kind: 'review' }>;

export function ReviewCard({ item }: { item: ReviewItem }) {
  const open = item.files.filter((f) => !f.decision).length;
  return (
    <section class="review" aria-label="Review changes">
      <div class="review-head">
        <span class="review-title">Review changes</span>
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
