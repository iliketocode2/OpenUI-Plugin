import { useState } from 'preact/hooks';
import type { TodoItem, TranscriptItem } from '../../src/shared/protocol';
import { post, returnFocusToComposer } from './api';

type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>;

const OTHER = '\u0000other';

export function QuestionCard({ item }: { item: QuestionItem }) {
  const [selected, setSelected] = useState<string[][]>(() => item.questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => item.questions.map(() => ''));
  if (item.status !== 'open') {
    return (
      <div class="question question-done">
        {item.questions.map((q, i) => (
          <div key={i} class="qa">
            <div class="q-text">{q.question}</div>
            <div class="q-answer">{item.status === 'cancelled' ? 'No answer' : (item.answers?.[i] ?? []).join(', ') || 'No answer'}</div>
          </div>
        ))}
      </div>
    );
  }
  const toggle = (qi: number, value: string, multi: boolean) => {
    setSelected((prev) => prev.map((s, i) => (i !== qi ? s : multi ? (s.includes(value) ? s.filter((v) => v !== value) : [...s, value]) : [value])));
  };
  const answers = item.questions.map((_q, i) => (selected[i] ?? []).map((v) => (v === OTHER ? (other[i] ?? '').trim() : v)).filter(Boolean));
  const complete = answers.every((a) => a.length > 0);
  return (
    <form
      class="question"
      aria-label="Questions from the agent"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete) {
          post({ type: 'answer', id: item.id, answers });
          returnFocusToComposer();
        }
      }}
    >
      {item.questions.map((q, qi) => {
        const multi = !!q.multiSelect;
        const options = q.options ?? [];
        const name = `${item.id}-${qi}`;
        return (
          <fieldset key={qi} class="q-field">
            <legend>
              {q.header && <span class="q-header">{q.header}</span>} {q.question}
            </legend>
            {options.map((opt) => (
              <label key={opt} class="q-option">
                <input type={multi ? 'checkbox' : 'radio'} name={name} checked={selected[qi]?.includes(opt)} onChange={() => toggle(qi, opt, multi)} />
                {opt}
              </label>
            ))}
            <label class="q-option q-other">
              {options.length > 0 && (
                <input type={multi ? 'checkbox' : 'radio'} name={name} checked={selected[qi]?.includes(OTHER)} onChange={() => toggle(qi, OTHER, multi)} aria-label="Other answer" />
              )}
              <input
                type="text"
                class="q-other-text"
                placeholder={options.length ? 'Other…' : 'Your answer'}
                value={other[qi]}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  setOther((prev) => prev.map((o, i) => (i === qi ? v : o)));
                  if (v && !selected[qi]?.includes(OTHER)) toggle(qi, OTHER, multi);
                }}
              />
            </label>
          </fieldset>
        );
      })}
      <div class="actions">
        <button class="btn" type="submit" disabled={!complete}>
          Answer
        </button>
      </div>
    </form>
  );
}

const TODO_ICON: Record<TodoItem['status'], string> = { pending: '○', in_progress: '◐', completed: '●' };

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <details class="todos" open>
      <summary>
        Tasks {done}/{todos.length}
      </summary>
      <ol>
        {todos.map((t, i) => (
          <li key={i} class={`todo todo-${t.status}`}>
            <span class="todo-icon" aria-label={t.status.replace('_', ' ')} role="img">
              {TODO_ICON[t.status]}
            </span>
            <span>{t.content}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
