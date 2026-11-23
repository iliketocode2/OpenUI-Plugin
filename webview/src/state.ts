import type { ToolCardUpdate, ViewState } from '../../src/shared/protocol';

/** What the extension sends: a full state, or a piece of streamed text or a tool card change applied to it. */
export type Action =
  | { type: 'state'; state: ViewState }
  | { type: 'delta'; id: string; kind: 'content' | 'reasoning'; text: string }
  | { type: 'toolUpdate'; id: string; patch: ToolCardUpdate };

export function reducer(state: ViewState | undefined, action: Action): ViewState | undefined {
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
