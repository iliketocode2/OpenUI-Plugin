import type { AskUserQuestion, PlanAnswer, ToolCardUpdate, TodoItem } from '../shared/protocol';
import type { PathGuard, ResolvedPath } from '../workspace/paths';
import type { ProcessManager } from './shell/processManager';
import type { ShellRegistry } from './shell/shells';

export type ToolCategory = 'read' | 'edit' | 'command' | 'interactive';

export interface JsonSchema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  minItems?: number;
  additionalProperties?: boolean;
}

export interface ImageAttachment {
  path: string;
  mime: string;
  base64: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  images?: ImageAttachment[];
}

export interface ToolSettings {
  commandTimeoutSeconds: number;
  maxOutputChars: number;
  defaultShell: string | undefined;
}

export interface ToolContext {
  signal: AbortSignal;
  callId: string;
  paths: PathGuard;
  shells: ShellRegistry;
  processes: ProcessManager;
  scratchpad: string;
  ripgrep: string | undefined;
  settings: ToolSettings;
  modelVision: boolean;
  update(patch: ToolCardUpdate): void;
  ask(questions: AskUserQuestion[]): Promise<string[][]>;
  setTodos(todos: TodoItem[]): void;
  beforeWrite(absolute: string): Promise<void>;
  presentPlan(plan: string): Promise<PlanDecision>;
}

export type PlanDecision = PlanAnswer;

export type Access =
  | { kind: 'none' }
  | { kind: 'read'; paths: ResolvedPath[] }
  | { kind: 'write'; paths: ResolvedPath[] }
  | { kind: 'command'; command: string; cwd: ResolvedPath; background: boolean };

export interface FilePreview {
  absolute: string;
  display: string;
  before: string;
  after: string;
}

export interface Prepared {
  access: Access;
  card?: ToolCardUpdate;
  preview?: FilePreview;
  execute(): Promise<ToolResult>;
}

export interface Tool<A = Record<string, unknown>> {
  name: string;
  category: ToolCategory;
  description: string;
  parameters: JsonSchema;
  title(args: A): string;
  prepare(args: A, ctx: ToolContext): Promise<Prepared | ToolResult>;
}

export function isPrepared(v: Prepared | ToolResult): v is Prepared {
  return typeof (v as Prepared).execute === 'function';
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function ok(content: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content, ...extra };
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}
