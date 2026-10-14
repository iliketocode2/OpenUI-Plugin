import { useEffect, useRef, useState } from 'preact/hooks';
import type { HistoryEntry } from '../../src/shared/protocol';
import { post } from './api';

function when(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(ts);
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function HistoryPanel({ entries, query, currentId, onClose }: { entries: HistoryEntry[] | undefined; query: string; currentId: string; onClose(): void }) {
  const [text, setText] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const current = entries !== undefined && query === text ? entries : undefined;
  useEffect(() => {
    const t = setTimeout(() => post({ type: 'listHistory', query: text }), 250);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <section
      class="history"
      aria-label="Conversation history"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div class="history-head">
        <label class="sr-only" for="history-search">
          Search conversations
        </label>
        <input id="history-search" ref={inputRef} type="search" placeholder="Search conversations" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        <button class="btn btn-secondary" onClick={onClose}>
          Back to chat
        </button>
      </div>
      {current === undefined ? (
        <p class="empty">Loading…</p>
      ) : !current.length ? (
        <p class="empty">{text.trim() ? 'No conversations match.' : 'No saved conversations yet.'}</p>
      ) : (
        <ul class="history-list">
          {current.map((e) => (
            <li key={e.id} class={`history-item ${e.id === currentId ? 'history-current' : ''}`}>
              <button
                class="history-open"
                onClick={() => {
                  post({ type: 'resumeSession', id: e.id });
                  onClose();
                }}
                aria-label={`Open ${e.title}`}
              >
                <span class="history-title">
                  {e.title}
                  {e.id === currentId && <span class="tag">current</span>}
                </span>
                <span class="history-meta">
                  {when(e.updated)} · {e.messages} message{e.messages === 1 ? '' : 's'}
                </span>
                {(e.match ?? e.preview) && <span class="history-preview">{e.match ?? e.preview}</span>}
              </button>
              <span class="history-actions">
                <button class="btn btn-secondary btn-small" onClick={() => post({ type: 'renameSession', id: e.id })}>
                  Rename
                </button>
                <button class="btn btn-secondary btn-small" onClick={() => post({ type: 'exportSession', id: e.id })}>
                  Export
                </button>
                <button class="btn btn-secondary btn-small" onClick={() => post({ type: 'deleteSession', id: e.id })}>
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
