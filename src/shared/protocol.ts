export type SovereigntyLevel = 'local' | 'unverified' | 'none';

export type AgentMode = 'plan' | 'ask' | 'auto' | 'review';

export type RewindScope = 'code' | 'conversation' | 'both';

export interface ModelView {
  id: string;
  name: string;
  local: boolean;
  vision: boolean;
  thinking: boolean;
  contextSize: number;
  contextSource: 'setting' | 'server' | 'default';
  maxContext?: number;
}

export interface UsageView {
  promptTokens: number;
  contextSize: number;
  contextSource: 'setting' | 'server' | 'default';
  estimated: boolean;
}

export type ToolStatus = 'pending' | 'awaiting-approval' | 'running' | 'done' | 'error' | 'denied' | 'cancelled';

export interface ApprovalRequest {
  kind: 'edit' | 'command' | 'read' | 'write' | 'web';
  question: string;
  warnings: string[];
  allowAlways?: string;
  editable?: { label: string; value: string };
}

export interface ApprovalDecision {
  decision: 'allow' | 'allowAlways' | 'deny';
  feedback?: string;
  edited?: string;
}

export interface WebStatusView {
  enabled: boolean;
  engine?: string;
  verification: 'verified' | 'confirmed' | 'unverified' | 'other-engine' | 'disabled-on-server' | 'unavailable';
  detail?: string;
}

export interface ToolCardUpdate {
  title?: string;
  status?: ToolStatus;
  description?: string;
  input?: string;
  output?: string;
  diff?: string;
  summary?: string;
  image?: string;
  exitCode?: number | null;
  diffId?: string;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  options?: string[];
  multiSelect?: boolean;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type TranscriptItem =
  | { id: string; kind: 'user'; text: string; ts: number; checkpoint?: string }
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
  | ({ id: string; kind: 'tool'; ts: number; tool: string; title: string; status: ToolStatus; approval?: ApprovalRequest } & ToolCardUpdate)
  | { id: string; kind: 'question'; ts: number; questions: AskUserQuestion[]; answers?: string[][]; status: 'open' | 'answered' | 'cancelled' }
  | { id: string; kind: 'review'; ts: number; checkpoint: string; files: ReviewFile[]; status: 'open' | 'done' }
  | { id: string; kind: 'error'; text: string; ts: number; action?: 'setApiKey' | 'openSettings' | 'retry' | 'continue' | 'setContextSize' }
  | { id: string; kind: 'warning'; text: string; ts: number }
  | { id: string; kind: 'notice'; text: string; ts: number };

export interface ReviewFile {
  absolute: string;
  display: string;
  action: 'modified' | 'added';
  decision?: 'kept' | 'reverted';
  diffId?: string;
}

export interface ConnectionView {
  baseUrl: string;
  baseUrlError?: string;
  insecure: boolean;
  hasKey: boolean;
  status: 'unknown' | 'connecting' | 'ok' | 'error';
  error?: string;
  serverVersion?: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  updated: number;
  messages: number;
  preview: string;
  match?: string;
}

export interface ViewState {
  sessionId: string;
  connection: ConnectionView;
  models: ModelView[];
  selectedModel?: string;
  busy: boolean;
  mode: AgentMode;
  transcript: TranscriptItem[];
  todos: TodoItem[];
  usage?: UsageView;
  sovereignty: SovereigntyLevel;
  noticeAcknowledged: boolean;
  web: WebStatusView;
}

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'delta'; id: string; kind: 'content' | 'reasoning'; text: string }
  | { type: 'toolUpdate'; id: string; patch: ToolCardUpdate }
  | { type: 'insertText'; text: string }
  | { type: 'history'; entries: HistoryEntry[]; query: string }
  | { type: 'showHistory' }
  | { type: 'focusInput' };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'selectModel'; id: string }
  | { type: 'setModelLocal'; id: string; local: boolean }
  | { type: 'setModelThinking'; id: string; thinking: boolean }
  | { type: 'setContextSize'; id: string }
  | { type: 'setMode'; mode: AgentMode }
  | { type: 'newSession' }
  | { type: 'setApiKey' }
  | { type: 'openSettings' }
  | { type: 'refreshModels' }
  | { type: 'acknowledgeNotice' }
  | { type: 'retry' }
  | { type: 'continue' }
  | { type: 'approve'; id: string; decision: ApprovalDecision }
  | { type: 'answer'; id: string; answers: string[][] }
  | { type: 'openFile'; path: string }
  | { type: 'openDiff'; diffId: string }
  | { type: 'rewind'; itemId: string; scope: RewindScope }
  | { type: 'review'; id: string; absolute?: string; decision: 'keep' | 'revert' }
  | { type: 'openLink'; href: string }
  | { type: 'listHistory'; query: string }
  | { type: 'resumeSession'; id: string }
  | { type: 'renameSession'; id: string }
  | { type: 'deleteSession'; id: string }
  | { type: 'exportSession'; id: string }
