import { render, type RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { SOVEREIGNTY_NOTICE } from '../../src/shared/notice';
import type { AgentMode, HistoryEntry, ToWebview, ToolCardUpdate, TranscriptItem, ViewState } from '../../src/shared/protocol';
import { post, vscode } from './api';
import { renderMarkdown } from './markdown';
import { HistoryPanel } from './History';
import { PlanCard, ReviewCard, RewindControl } from './PlanReview';
import { QuestionCard, TodoPanel } from './Question';
import { ToolCard } from './ToolCard';

type Action =
  | { type: 'state'; state: ViewState }
  | { type: 'delta'; id: string; kind: 'content' | 'reasoning'; text: string }
  | { type: 'toolUpdate'; id: string; patch: ToolCardUpdate };

function reducer(state: ViewState | undefined, action: Action): ViewState | undefined {
  if (action.type === 'state') return action.state;
  if (!state) return state;
  const transcript = state.transcript.map((item) => {
    if (item.id !== action.id) return item;
    if (action.type === 'toolUpdate') return item.kind === 'tool' ? { ...item, ...action.patch } : item;
    if (item.kind !== 'assistant') return item;
    const next = { ...item, interrupted: undefined };
    if (action.kind === 'content') next.text += action.text;
    else next.reasoning += action.text;
    return next;
  });
  return { ...state, transcript };
}

function App() {
  const [state, dispatch] = useReducer(reducer, undefined);
  const [announcement, setAnnouncement] = useState('');
  const [history, setHistory] = useState<{ open: boolean; entries?: HistoryEntry[]; query: string }>({ open: false, query: '' });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const insertRef = useRef<(text: string) => void>(() => undefined);

  useEffect(() => {
    const onMessage = (e: MessageEvent<ToWebview>) => {
      const msg = e.data;
      if (msg.type === 'state' || msg.type === 'delta' || msg.type === 'toolUpdate') dispatch(msg);
      else if (msg.type === 'focusInput') inputRef.current?.focus();
      else if (msg.type === 'insertText') insertRef.current(msg.text);
      else if (msg.type === 'showHistory') setHistory((h) => ({ ...h, open: true }));
      else if (msg.type === 'history') setHistory((h) => ({ ...h, entries: msg.entries, query: msg.query }));
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const busy = state?.busy ?? false;
  const prevBusy = useRef(busy);
  const waiting = state?.transcript.some((t) => (t.kind === 'tool' && t.status === 'awaiting-approval') || (t.kind === 'question' && t.status === 'open')) ?? false;
  useEffect(() => {
    if (waiting) setAnnouncement('The agent is waiting for your input.');
  }, [waiting]);
  useEffect(() => {
    if (busy && !prevBusy.current) setAnnouncement('Agent is working.');
    if (!busy && prevBusy.current) {
      const last = state?.transcript[state.transcript.length - 1];
      setAnnouncement(last?.kind === 'error' ? `Error: ${last.text}` : 'Agent finished.');
    }
    prevBusy.current = busy;
  }, [busy, state]);

  if (!state) return <div class="loading">Loading…</div>;

  return (
    <div class="app">
      <Header state={state} />
      {!state.noticeAcknowledged && <Notice />}
      <Connection state={state} />
      {history.open ? (
        <HistoryPanel
          entries={history.entries}
          query={history.query}
          currentId={state.sessionId}
          onClose={() => {
            setHistory((h) => ({ ...h, open: false }));
            inputRef.current?.focus();
          }}
        />
      ) : (
        <Transcript items={state.transcript} busy={busy} />
      )}
      <TodoPanel todos={state.todos} />
      <Composer busy={busy} disabled={!state.selectedModel} mode={state.mode} inputRef={inputRef} insertRef={insertRef} />
      <div class="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function Header({ state }: { state: ViewState }) {
  const selected = state.models.find((m) => m.id === state.selectedModel);
  return (
    <header class="header">
      <div class="row">
        <label class="sr-only" for="model">
          Model
        </label>
        <select
          id="model"
          class="model-select"
          value={state.selectedModel ?? ''}
          disabled={!state.models.length || state.busy}
          onChange={(e) => post({ type: 'selectModel', id: (e.target as HTMLSelectElement).value })}
        >
          {!state.models.length && <option value="">No models</option>}
          {state.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <Sovereignty level={state.sovereignty} />
        <WebBadge web={state.web} />
      </div>
      {selected && (
        <div class="row meta">
          <label class="checkbox" title="Check this only if the model runs on hardware or infrastructure you control.">
            <input
              type="checkbox"
              checked={selected.local}
              onChange={(e) => post({ type: 'setModelLocal', id: selected.id, local: (e.target as HTMLInputElement).checked })}
            />
            Runs on infrastructure I control
          </label>
          <label class="checkbox" title="Turning thinking off asks Ollama models to skip their reasoning phase. Much faster, but planning quality may drop.">
            <input
              type="checkbox"
              checked={selected.thinking}
              onChange={(e) => post({ type: 'setModelThinking', id: selected.id, thinking: (e.target as HTMLInputElement).checked })}
            />
            Thinking
          </label>
          <ContextMeter state={state} />
        </div>
      )}
    </header>
  );
}

function Sovereignty({ level }: { level: ViewState['sovereignty'] }) {
  if (level === 'none') return null;
  const local = level === 'local';
  return (
    <span
      class={`badge ${local ? 'badge-ok' : 'badge-warn'}`}
      title={
        local
          ? 'You marked this model as running on infrastructure you control. Prompts go only to your Open WebUI.'
          : 'Prompts go only to your Open WebUI, but this model is not marked as local. It may be proxied to a cloud provider.'
      }
    >
      <span aria-hidden="true">●</span> {local ? 'Local' : 'Unverified'}
    </span>
  );
}

const WEB_LABEL: Record<ViewState['web']['verification'], { text: (engine?: string) => string; ok: boolean; hint: string }> = {
  verified: { text: () => 'Web: SearXNG ✓', ok: true, hint: 'Web search is on and Open WebUI reports a SearXNG engine. Queries still reach the internet through it; each one is shown to you first.' },
  confirmed: { text: () => 'Web: SearXNG', ok: true, hint: 'Web search is on. You confirmed in settings that Open WebUI uses SearXNG; the extension could not check it.' },
  unverified: { text: () => 'Web: unverified', ok: false, hint: 'Web search is on, but the search engine Open WebUI uses could not be checked.' },
  'other-engine': { text: (e) => `Web: ${e ?? 'third-party'}`, ok: false, hint: 'Open WebUI sends web searches to a third-party engine.' },
  'disabled-on-server': { text: () => 'Web: off in Open WebUI', ok: false, hint: 'Web search is turned off in Open WebUI.' },
  unavailable: { text: () => 'Web: unavailable', ok: false, hint: 'This Open WebUI version does not offer web search.' },
};

function WebBadge({ web }: { web: ViewState['web'] }) {
  if (!web.enabled) return null;
  const l = WEB_LABEL[web.verification];
  return (
    <span class={`badge ${l.ok ? 'badge-ok' : 'badge-warn'}`} title={[l.hint, web.detail].filter(Boolean).join(' ')}>
      {l.text(web.engine)}
    </span>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function ContextMeter({ state }: { state: ViewState }) {
  const u = state.usage;
  if (!u) return null;
  const assumed = u.contextSource === 'assumed';
  const pct = Math.min(100, Math.round((u.promptTokens / u.contextSize) * 100));
  const title =
    `${u.estimated ? 'About ' : ''}${u.promptTokens} of ${u.contextSize} tokens used (${pct}%). ` +
    (assumed
      ? 'Open WebUI does not report this model\'s context length, so 4096 is assumed. Set "Context Length" in the model\'s Advanced Params in Open WebUI, or set contextSize in the owuiAgent.models setting.'
      : u.contextSource === 'server'
        ? 'Context length reported by Open WebUI.'
        : 'Context length from your owuiAgent.models setting.');
  return (
    <span class="context" title={title}>
      <meter min={0} max={u.contextSize} low={u.contextSize * 0.6} high={u.contextSize * 0.8} optimum={0} value={u.promptTokens} aria-label="Context used" />
      <span class="context-label">
        {u.estimated ? '~' : ''}
        {formatTokens(u.promptTokens)} / {formatTokens(u.contextSize)}
        {assumed ? '?' : ''}
      </span>
    </span>
  );
}

function Notice() {
  return (
    <section class="notice" aria-labelledby="notice-title">
      <h2 id="notice-title">Data sovereignty</h2>
      {SOVEREIGNTY_NOTICE.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <button class="btn" onClick={() => post({ type: 'acknowledgeNotice' })}>
        Got it
      </button>
    </section>
  );
}

function Connection({ state }: { state: ViewState }) {
  const c = state.connection;
  return (
    <>
      {c.insecure && (
        <div class="banner banner-warn" role="alert">
          {c.baseUrl} uses plain HTTP on a non-local address. Your API key and prompts travel unencrypted on the network.
        </div>
      )}
      {c.status === 'error' && (
        <div class="banner banner-error" role="alert">
          <p>{c.baseUrlError ?? c.error}</p>
          <div class="actions">
            {!c.hasKey && (
              <button class="btn" onClick={() => post({ type: 'setApiKey' })}>
                Set API key
              </button>
            )}
            <button class="btn btn-secondary" onClick={() => post({ type: 'openSettings' })}>
              Open settings
            </button>
            <button class="btn btn-secondary" onClick={() => post({ type: 'refreshModels' })}>
              Retry
            </button>
          </div>
        </div>
      )}
      {c.status === 'connecting' && !state.models.length && <div class="banner">Connecting to {c.baseUrl}…</div>}
    </>
  );
}

function Transcript({ items, busy }: { items: TranscriptItem[]; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) post({ type: 'openLink', href });
    }
  };
  return (
    <main class="transcript" ref={ref} onScroll={onScroll} onClick={onClick} aria-label="Conversation" tabIndex={0}>
      {!items.length && <p class="empty">Ask a question to start.</p>}
      {items.map((item) => (
        <Item key={item.id} item={item} busy={busy} />
      ))}
    </main>
  );
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Item({ item, busy }: { item: TranscriptItem; busy: boolean }) {
  switch (item.kind) {
    case 'user':
      return (
        <article class="msg msg-user" aria-label="You">
          <div class="msg-head">
            <span class="who">You</span>
            <time>{time(item.ts)}</time>
            {item.checkpoint && <RewindControl itemId={item.id} disabled={busy} />}
          </div>
          <div class="msg-body plain">{item.text}</div>
        </article>
      );
    case 'assistant':
      return <AssistantItem item={item} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'question':
      return <QuestionCard item={item} />;
    case 'plan':
      return <PlanCard item={item} />;
    case 'review':
      return <ReviewCard item={item} />;
    case 'error':
      return (
        <div class="banner banner-error" role="alert">
          <p>{item.text}</p>
          {item.action && (
            <div class="actions">
              {item.action === 'setApiKey' && (
                <button class="btn" onClick={() => post({ type: 'setApiKey' })}>
                  Set API key
                </button>
              )}
              {item.action === 'openSettings' && (
                <button class="btn" onClick={() => post({ type: 'openSettings' })}>
                  Open settings
                </button>
              )}
              {item.action === 'retry' && (
                <button class="btn" onClick={() => post({ type: 'retry' })}>
                  Retry
                </button>
              )}
              {item.action === 'continue' && (
                <button class="btn" onClick={() => post({ type: 'continue' })}>
                  Continue
                </button>
              )}
            </div>
          )}
        </div>
      );
    case 'notice':
      return (
        <div class="notice-line" role="note">
          {item.text}
        </div>
      );
    case 'warning':
      return (
        <div class="banner banner-warn" role="note">
          {item.text}
        </div>
      );
  }
}

function AssistantItem({ item }: { item: Extract<TranscriptItem, { kind: 'assistant' }> }) {
  const html = useMemo(() => renderMarkdown(item.text), [item.text]);
  const thinking = item.streaming && !item.text;
  return (
    <article class="msg msg-assistant" aria-label="Assistant" aria-busy={item.streaming}>
      <div class="msg-head">
        <span class="who">Assistant</span>
        <time>{time(item.ts)}</time>
        {item.stopped && <span class="tag">Stopped</span>}
      </div>
      {item.reasoning && (
        <details class="reasoning">
          <summary>{thinking ? 'Thinking…' : `Reasoning (${formatTokens(Math.round(item.reasoning.length / 4))} tokens approx.)`}</summary>
          <div class="reasoning-body plain">{item.reasoning}</div>
        </details>
      )}
      {thinking && !item.reasoning && <div class="pending">Waiting for the model…</div>}
      {item.text && <div class="msg-body markdown" dangerouslySetInnerHTML={{ __html: html }} />}
      {item.interrupted && <div class="interrupted">{item.interrupted}</div>}
    </article>
  );
}

const MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: 'plan', label: 'Plan', hint: 'Read-only: the agent investigates, asks questions and writes a plan for you to approve before it changes anything.' },
  { id: 'ask', label: 'Ask before edits', hint: 'Every file change and every command that is not allow-listed asks for approval.' },
  { id: 'auto', label: 'Auto-accept edits', hint: 'File changes inside the workspace apply immediately. Commands still ask unless allow-listed.' },
  { id: 'review', label: 'Auto-accept, review at end', hint: 'File changes apply immediately; when the agent finishes you keep or revert each changed file. Commands still ask unless allow-listed.' },
];

function Composer({
  busy,
  disabled,
  mode,
  inputRef,
  insertRef,
}: {
  busy: boolean;
  disabled: boolean;
  mode: AgentMode;
  inputRef: RefObject<HTMLTextAreaElement>;
  insertRef: RefObject<(text: string) => void>;
}) {
  const [text, setText] = useState(() => {
    const saved = vscode.getState() as { draft?: string } | undefined;
    return saved?.draft ?? '';
  });
  useEffect(() => vscode.setState({ draft: text }), [text]);
  insertRef.current = (insert: string) => {
    setText((prev) => (prev && !prev.endsWith('\n') && !prev.endsWith(' ') ? `${prev}\n${insert}` : `${prev}${insert}`));
    inputRef.current?.focus();
  };
  const currentMode = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  const send = () => {
    if (busy || disabled || !text.trim()) return;
    post({ type: 'send', text });
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault();
      post({ type: 'stop' });
    }
  };
  return (
    <footer class="composer">
      <label class="sr-only" for="prompt">
        Message
      </label>
      <textarea
        id="prompt"
        ref={inputRef}
        rows={3}
        value={text}
        placeholder="Ask anything (Ctrl+Enter to send, /compact to shrink the context)"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
      />
      <div class="composer-actions">
        <label class="sr-only" for="mode">
          Permission mode
        </label>
        <select id="mode" class="mode-select" value={mode} title={currentMode.hint} onChange={(e) => post({ type: 'setMode', mode: (e.target as HTMLSelectElement).value as AgentMode })}>
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span class="hint">{busy ? 'Esc to stop' : 'Ctrl+Enter to send'}</span>
        {busy ? (
          <button class="btn btn-danger" onClick={() => post({ type: 'stop' })}>
            Stop
          </button>
        ) : (
          <button class="btn" onClick={send} disabled={disabled || !text.trim()}>
            Send
          </button>
        )}
      </div>
    </footer>
  );
}

render(<App />, document.getElementById('root')!);
