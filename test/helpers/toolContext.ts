import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AskUserQuestion, TodoItem, ToolCardUpdate } from '../../src/shared/protocol';
import { BrowserSession } from '../../src/browser/session';
import { Egress } from '../../src/net/egress';
import { OwuiWeb } from '../../src/owui/web';
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
  createdDirs: string[];
  processes: ProcessManager;
  controller: AbortController;
  run<A>(tool: Tool<A>, args: A): Promise<ToolResult & { access?: string; card?: ToolCardUpdate }>;
  cleanup(): Promise<void>;
}

const shells = new ShellRegistry();

export async function createToolEnv(
  opts: { ripgrep?: string; vision?: boolean; shell?: string; answers?: (q: AskUserQuestion[]) => string[][]; baseUrl?: string; apiKey?: string } = {},
): Promise<TestEnv> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'owui tools ws '));
  const scratchpad = await mkdtemp(path.join(tmpdir(), 'owui tools scratch '));
  const updates: ToolCardUpdate[] = [];
  const todos: TodoItem[][] = [];
  const createdDirs: string[] = [];
  const processes = new ProcessManager();
  const controller = new AbortController();
  let browser: BrowserSession | undefined;
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
    skills: [],
    workspaceDirCreated: (dir) => createdDirs.push(dir),
    browser: () => (browser ??= new BrowserSession({ profileDir: path.join(scratchpad, '.browser-profile'), channel: 'auto', allowExternal: false, extraHosts: [] })),
    web: new OwuiWeb(new Egress(() => opts.baseUrl ?? 'http://127.0.0.1:9'), async () => opts.apiKey ?? 'sk-test'),
  };
  return {
    workspace,
    scratchpad,
    ctx,
    updates,
    todos,
    createdDirs,
    processes,
    controller,
    async run(tool, args) {
      const prepared = await tool.prepare(args, ctx);
      if (!isPrepared(prepared)) return prepared;
      const result = await prepared.execute();
      return { ...result, access: prepared.access.kind, ...(prepared.card ? { card: prepared.card } : {}) };
    },
    async cleanup() {
      await browser?.close();
      await processes.stopAll();
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchpad, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export function availableShells(): string[] {
  return shells.available().map((s) => s.id);
}
