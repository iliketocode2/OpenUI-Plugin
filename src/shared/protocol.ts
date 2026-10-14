export type SovereigntyLevel = 'local' | 'unverified' | 'none';

export interface ModelView {
  id: string;
  name: string;
  local: boolean;
  vision: boolean;
  contextSize: number;
  contextSource: 'setting' | 'server' | 'assumed';
}

export interface UsageView {
  promptTokens: number;
  contextSize: number;
  contextSource: 'setting' | 'server' | 'assumed';
  estimated: boolean;
}

export type TranscriptItem =
  | { id: string; kind: 'user'; text: string; ts: number }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      reasoning: string;
      ts: number;
      streaming: boolean;
      interrupted?: string;
      stopped?: boolean;
    }
  | { id: string; kind: 'error'; text: string; ts: number; action?: 'setApiKey' | 'openSettings' | 'retry' }
  | { id: string; kind: 'warning'; text: string; ts: number };

export interface ConnectionView {
  baseUrl: string;
  baseUrlError?: string;
  insecure: boolean;
  hasKey: boolean;
  status: 'unknown' | 'connecting' | 'ok' | 'error';
  error?: string;
  serverVersion?: string;
}

export interface ViewState {
  connection: ConnectionView;
  models: ModelView[];
  selectedModel?: string;
  busy: boolean;
  transcript: TranscriptItem[];
  usage?: UsageView;
  sovereignty: SovereigntyLevel;
  noticeAcknowledged: boolean;
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'delta'; id: string; kind: 'content' | 'reasoning'; text: string }
  | { type: 'focusInput' };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'selectModel'; id: string }
  | { type: 'setModelLocal'; id: string; local: boolean }
  | { type: 'newSession' }
  | { type: 'setApiKey' }
  | { type: 'openSettings' }
  | { type: 'refreshModels' }
  | { type: 'acknowledgeNotice' }
  | { type: 'retry' }
  | { type: 'openLink'; href: string };
