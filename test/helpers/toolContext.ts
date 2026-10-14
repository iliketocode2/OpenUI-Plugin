import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AskUserQuestion, TodoItem, ToolCardUpdate } from '../../src/shared/protocol';
import { ProcessManager } from '../../src/tools/shell/processManager';
import { ShellRegistry } from '../../src/tools/shell/shells';
import { isPrepared, type Tool, type ToolContext, type ToolResult } from '../../src/tools/types';
import { PathGuard } from '../../src/workspace/paths';
import { locateRipgrep } from '../../src/workspace/ripgrep';

export function testRipgrep(): string | undefined {
  const base = path.join(__dirname, '..', '..', '.vscode-test');
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      const found = locateRipgrep(path.join(base, d, 'resources', 'app'));
      if (found && found.startsWith(base)) return found;
    }
  }
  return locateRipgrep(undefined);
}

export interface TestEnv {
  workspace: string;
  scratchpad: string;
  ctx: ToolContext;
  updates: ToolCardUpdate[];
  todos: TodoItem[][];
  processes: ProcessManager;
  controller: AbortController;
  run<A>(tool: Tool<A>, args: A): Promise<ToolResult & { access?: string; card?: ToolCardUpdate }>;
  cleanup(): Promise<void>;
}

const shells = new ShellRegistry();

export async function createToolEnv(opts: { ripgrep?: string; vision?: boolean; shell?: string; answers?: (q: AskUserQuestion[]) => string[][] } = {}): Promise<TestEnv> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'owui tools ws '));
  const scratchpad = await mkdtemp(path.join(tmpdir(), 'owui tools scratch '));
  const updates: ToolCardUpdate[] = [];
  const todos: TodoItem[][] = [];
  const processes = new ProcessManager();
  const controller = new AbortController();
  const ctx: ToolContext = {
    signal: controller.signal,
    callId: 'test',
    paths: new PathGuard(() => [workspace], scratchpad),
    shells,
    processes,
    scratchpad,
    ripgrep: opts.ripgrep,
    settings: { commandTimeoutSeconds: 30, maxOutputChars: 4000, defaultShell: opts.shell },
    modelVision: opts.vision ?? true,
    update: (p) => updates.push(p),
    ask: async (q) => opts.answers?.(q) ?? q.map(() => []),
    setTodos: (t) => todos.push(t),
    beforeWrite: async () => undefined,
    presentPlan: async () => ({ approved: true, mode: 'ask' }),
  };
  return {
    workspace,
    scratchpad,
    ctx,
    updates,
    todos,
    processes,
    controller,
    async run(tool, args) {
      const prepared = await tool.prepare(args, ctx);
      if (!isPrepared(prepared)) return prepared;
      const result = await prepared.execute();
      return { ...result, access: prepared.access.kind, ...(prepared.card ? { card: prepared.card } : {}) };
    },
    async cleanup() {
      await processes.stopAll();
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchpad, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function availableShells(): string[] {
  return shells.available().map((s) => s.id);
}
