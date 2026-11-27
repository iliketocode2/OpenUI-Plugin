import { render, type RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { SOVEREIGNTY_NOTICE } from '../../src/shared/notice';
import type { AgentMode, HistoryEntry, ToWebview, TranscriptItem, ViewState } from '../../src/shared/protocol';
import { post, vscode } from './api';
import { renderMarkdown } from './markdown';
import { HistoryPanel } from './History';
import { ReviewCard, RewindControl } from './Review';
import { SummaryCard } from './Summary';
import { QuestionCard, TodoPanel } from './Question';
import { ToolCard } from './ToolCard';
import { reducer } from './state';


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
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeHistory = () => {
    setHistory((h) => ({ ...h, open: false }));
    inputRef.current?.focus();
  };
  // Set while rendering, so it is current as soon as the panel is on screen; the panel's own focus effect runs later.
  const historyOpenRef = useRef(history.open);
  historyOpenRef.current = history.open;
  const closeHistoryRef = useRef(closeHistory);
  closeHistoryRef.current = closeHistory;
  // While the history is open, Esc closes it wherever focus is (the search box, the composer, or nothing after a
  // click on blank space) and goes no further, so it can never stop the agent. Capture runs before every other handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !historyOpenRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      closeHistoryRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  // Esc stops the agent from anywhere in the view, unless something else used the key first: closing the history,
  // or a text field. A VS Code keybinding would fire for those too, and stop a run by accident.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !busyRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      post({ type: 'stop' });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
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
          onClose={closeHistory}
        />
      ) : (
        <Transcript items={state.transcript} busy={busy} planReady={planReady(state)} />
      )}
      <TodoPanel todos={state.todos} />
      <Composer busy={busy} disabled={!state.selectedModel} warming={state.warmUp?.status === 'warming'} mode={state.mode} inputRef={inputRef} insertRef={insertRef} />
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
        {state.warmUp && <WarmUpChip warm={state.warmUp} model={selected?.name ?? state.warmUp.modelId} />}
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

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function WarmUpChip({ warm, model }: { warm: NonNullable<ViewState['warmUp']>; model: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (warm.status !== 'warming') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [warm.status, warm.startedAt]);
  if (warm.status === 'failed') {
    return (
      <span class="badge badge-warn warmup" title={`Could not load ${model} in advance${warm.error ? `: ${warm.error}` : ''}. The first message may be slow.`}>
        Warm-up failed
      </span>
    );
  }
  return (
    <span
      class="badge warmup warmup-active"
      role="status"
      title={`The server is loading ${model} and reading the agent's instructions, so the first reply does not have to wait for them. You can send a message now; it is answered when this finishes.`}
    >
      <span class="spinner" aria-hidden="true" />
      Loading model… <span class="warmup-clock">{clock(now - warm.startedAt)}</span>
    </span>
  );
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

function ContextMeter({ state }: { state: ViewState }) {
  const u = state.usage;
  if (!u) return null;
  const pct = Math.min(100, Math.round((u.promptTokens / u.contextSize) * 100));
  const model = state.models.find((m) => m.id === state.selectedModel);
  const max = model?.maxContext ? ` The model supports up to ${model.maxContext.toLocaleString()}.` : '';
  const title =
    `${u.estimated ? 'About ' : ''}${u.promptTokens} of ${u.contextSize} tokens used (${pct}%). ` +
    (u.contextSource === 'default'
      ? `Default context size, sent to Ollama as num_ctx.${max} Click to change it.`
      : u.contextSource === 'server'
        ? `Context size from the model's parameters in Open WebUI, sent to Ollama as num_ctx.${max} Click to override it.`
        : `Context size you set for this model, sent to Ollama as num_ctx.${max} Click to change it.`);
  return (
    <button class="context" title={title} aria-label={`Context: ${title}`} disabled={!model} onClick={() => model && post({ type: 'setContextSize', id: model.id })}>
      <meter min={0} max={u.contextSize} low={u.contextSize * 0.6} high={u.contextSize * 0.8} optimum={0} value={u.promptTokens} aria-hidden="true" />
      <span class="context-label">
        {u.estimated ? '~' : ''}
        {formatTokens(u.promptTokens)} / {formatTokens(u.contextSize)}
      </span>
    </button>
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

/** A plan-mode run has ended with the agent's answer, which should be its plan. */
function planReady(state: ViewState): boolean {
  if (state.mode !== 'plan' || state.busy) return false;
  const last = state.transcript[state.transcript.length - 1];
  return last?.kind === 'assistant' && !last.streaming && !last.stopped && !!last.text.trim();
}

function Transcript({ items, busy, planReady }: { items: TranscriptItem[]; busy: boolean; planReady: boolean }) {
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
      {planReady && (
        <div class="plan-actions">
          <button class="btn" onClick={() => post({ type: 'implementPlan' })} title="Switch back to the mode you used before planning and ask the agent to carry out this plan.">
            Implement this plan
          </button>
          <span class="hint">or reply to change the plan</span>
        </div>
      )}
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
    case 'review':
      return <ReviewCard item={item} />;
    case 'summary':
      return <SummaryCard item={item} />;
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
              {item.action === 'setContextSize' && (
                <button class="btn" onClick={() => post({ type: 'setContextSize', id: '' })}>
                  Set context size
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
  { id: 'plan', label: 'Plan', hint: 'Read-only: the agent investigates, asks questions and replies with a plan. Switch mode when you want it implemented.' },
  { id: 'ask', label: 'Ask before edits', hint: 'Every file change and every command that is not allow-listed asks for approval.' },
  { id: 'auto', label: 'Auto-accept edits', hint: 'File changes inside the workspace apply immediately. Commands still ask unless allow-listed. Allow-listed commands such as npm test then run code the agent can change without asking, so use this only in repositories you trust.' },
  { id: 'review', label: 'Auto-accept, review at end', hint: 'File changes apply immediately; when the agent finishes you keep or revert each changed file. Commands still ask unless allow-listed. Allow-listed commands such as npm test then run code the agent can change without asking, so use this only in repositories you trust.' },
];

function Composer({
  busy,
  disabled,
  warming,
  mode,
  inputRef,
  insertRef,
}: {
  busy: boolean;
  disabled: boolean;
  warming: boolean;
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
        placeholder={
          warming
            ? 'The model is loading. You can send now; the reply starts once it has loaded.'
            : 'Ask anything (Ctrl+Enter to send, /plan to plan first, /compact to shrink the context)'
        }
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
