import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fail, ok, type Tool, type ToolContext } from '../types';
import { cleanOutput, truncateMiddle } from './output';
import type { ShellSpec } from './shells';
import { killTree, spawnShell } from './spawn';

const UPDATE_MS = 300;
const DISPLAY_CHARS = 6000;

function shellParam(): { type: 'string'; enum: string[]; description: string } {
  return {
    type: 'string',
    enum: ['gitbash', 'powershell', 'cmd', 'bash', 'zsh', 'sh'],
    description: 'Shell to use; defaults to the configured shell. Only shells listed in the environment section are available.',
  };
}

function pickShell(ctx: ToolContext, requested: string | undefined): ShellSpec | string {
  if (requested) {
    const s = ctx.shells.get(requested);
    if (!s) return `Shell "${requested}" is not available. Available: ${ctx.shells.available().map((x) => x.id).join(', ')}.`;
    return s;
  }
  return ctx.shells.pick(ctx.settings.defaultShell);
}

interface RunArgs {
  command: string;
  description: string;
  shell?: string;
  cwd?: string;
  timeout_seconds?: number;
}

export const runCommandTool: Tool<RunArgs> = {
  name: 'run_command',
  category: 'command',
  description:
    'Run a shell command and wait for it to finish. Use for builds, tests, type-checks, linters, package installs and quick checks (which/where, --version). Not for servers or watchers: use start_process. Commands run non-interactively with no stdin, so pass flags like --yes.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'Five to ten words explaining what the command does, shown to the user.' },
      shell: shellParam(),
      cwd: { type: 'string', description: 'Working directory; defaults to the workspace root.' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600 },
    },
    required: ['command', 'description'],
  },
  title: (a) => a.description || a.command,
  async prepare(args, ctx) {
    const shell = pickShell(ctx, args.shell);
    if (typeof shell === 'string') return fail(shell);
    const cwd = ctx.paths.resolve(args.cwd ?? '.');
    return {
      access: { kind: 'command', command: args.command, cwd, background: false },
      card: { title: args.description || args.command, description: args.description, input: args.command },
      execute: () => runCommand(args, shell, cwd.absolute, ctx),
    };
  },
};

async function runCommand(args: RunArgs, shell: ShellSpec, cwd: string, ctx: ToolContext) {
  const timeoutMs = Math.min(args.timeout_seconds ?? ctx.settings.commandTimeoutSeconds, 3600) * 1000;
  await mkdir(ctx.scratchpad, { recursive: true });
  const logPath = path.join(ctx.scratchpad, `cmd-${ctx.callId}.log`);
  const log = createWriteStream(logPath);
  const child = spawnShell(shell, args.command, cwd);
  let output = '';
  let total = 0;
  let lastUpdate = 0;
  let timedOut = false;
  let pendingUpdate: ReturnType<typeof setTimeout> | undefined;
  const headLimit = ctx.settings.maxOutputChars;
  const pushUpdate = () => {
    pendingUpdate = undefined;
    lastUpdate = Date.now();
    ctx.update({ output: output.length > DISPLAY_CHARS ? `…\n${output.slice(-DISPLAY_CHARS)}` : output });
  };
  const onData = (d: Buffer) => {
    log.write(d);
    const text = cleanOutput(d.toString('utf8'));
    total += text.length;
    output += text;
    if (output.length > headLimit * 4) output = truncateMiddle(output, headLimit * 2).text;
    if (Date.now() - lastUpdate > UPDATE_MS) pushUpdate();
    else pendingUpdate ??= setTimeout(pushUpdate, UPDATE_MS);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const timer = setTimeout(() => {
    timedOut = true;
    void killTree(child);
  }, timeoutMs);
  const onAbort = () => void killTree(child);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('error', (e) => {
      output += `\n[failed to start ${shell.label}: ${e.message}]`;
      resolve(-1);
    });
    child.once('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  if (pendingUpdate) clearTimeout(pendingUpdate);
  ctx.signal.removeEventListener('abort', onAbort);
  await new Promise<void>((r) => log.end(() => r()));
  const t = truncateMiddle(output.trimEnd(), headLimit);
  ctx.update({ output: t.text.length > DISPLAY_CHARS ? `…\n${t.text.slice(-DISPLAY_CHARS)}` : t.text, exitCode });
  if (ctx.signal.aborted) return fail(`Command cancelled by the user.\n${t.text}`);
  const status = timedOut ? `Timed out after ${timeoutMs / 1000}s and was killed.` : `Exit code ${exitCode}.`;
  const full = t.truncated ? `\n[Output truncated; the full output (${total} characters) is in ${logPath}. Use read_file or grep on it.]` : '';
  const body = t.text ? `\n${t.text}` : '\n(no output)';
  const result = `${status}${body}${full}`;
  return exitCode === 0 && !timedOut ? ok(result) : { content: result, isError: true };
}

interface StartArgs {
  command: string;
  description: string;
  shell?: string;
  cwd?: string;
  wait_for?: string;
  wait_for_port?: number;
  wait_seconds?: number;
}

export const startProcessTool: Tool<StartArgs> = {
  name: 'start_process',
  category: 'command',
  description:
    'Start a long-running background process (dev server, watcher, static server). Returns an id. Optionally wait until the output matches wait_for (regex) or wait_for_port accepts connections on localhost. All processes are stopped when the session ends.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'Five to ten words, shown to the user.' },
      shell: shellParam(),
      cwd: { type: 'string' },
      wait_for: { type: 'string', description: 'Regex to wait for in the output, e.g. "ready|listening".' },
      wait_for_port: { type: 'integer', minimum: 1, maximum: 65535 },
      wait_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Maximum wait (default 60).' },
    },
    required: ['command', 'description'],
  },
  title: (a) => a.description || a.command,
  async prepare(args, ctx) {
    const shell = pickShell(ctx, args.shell);
    if (typeof shell === 'string') return fail(shell);
    let pattern: RegExp | undefined;
    if (args.wait_for) {
      try {
        pattern = new RegExp(args.wait_for, 'i');
      } catch (e) {
        return fail(`wait_for is not a valid regex: ${(e as Error).message}`);
      }
    }
    const cwd = ctx.paths.resolve(args.cwd ?? '.');
    return {
      access: { kind: 'command', command: args.command, cwd, background: true },
      card: { title: `${args.description || args.command} (background)`, description: args.description, input: args.command },
      async execute() {
        const proc = ctx.processes.start(shell, args.command, cwd.absolute, args.description);
        let status = 'started';
        if (pattern || args.wait_for_port) {
          const opts: { pattern?: RegExp; port?: number; timeoutMs: number; signal?: AbortSignal } = { timeoutMs: (args.wait_seconds ?? 60) * 1000, signal: ctx.signal };
          if (pattern) opts.pattern = pattern;
          if (args.wait_for_port) opts.port = args.wait_for_port;
          status = await ctx.processes.waitFor(proc.id, opts);
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
        const out = truncateMiddle(proc.output.sinceLastRead(), ctx.settings.maxOutputChars);
        ctx.update({ output: out.text.slice(-DISPLAY_CHARS), summary: `id ${proc.id}` });
        const exited = proc.exitCode !== undefined;
        const head = exited
          ? `Process ${proc.id} exited with code ${proc.exitCode}.`
          : `Process ${proc.id} is running (${status === 'matched' ? 'output matched wait_for' : status === 'port' ? `port ${args.wait_for_port} is accepting connections` : status === 'timeout' ? 'still waiting: wait condition not met before timeout' : 'started'}).`;
        return exited ? fail(`${head}\n${out.text}`) : ok(`${head}\nOutput so far:\n${out.text || '(none)'}`);
      },
    };
  },
};

interface IdArgs {
  id: string;
}

export const readProcessOutputTool: Tool<IdArgs & { all?: boolean }> = {
  name: 'read_process_output',
  category: 'read',
  description: 'Read output from a background process: new output since the last read, or all buffered output with all=true.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' }, all: { type: 'boolean' } },
    required: ['id'],
  },
  title: (a) => `Read output of ${a.id}`,
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const p = ctx.processes.get(args.id);
        if (!p) return fail(`No process with id ${args.id}. Use list_processes.`);
        const text = args.all ? p.output.all() : p.output.sinceLastRead();
        const t = truncateMiddle(text, ctx.settings.maxOutputChars);
        const state = p.exitCode === undefined ? 'running' : `exited with code ${p.exitCode}`;
        ctx.update({ title: `Output of ${p.id} (${p.description || p.command})`, output: t.text.slice(-DISPLAY_CHARS) });
        return ok(`Process ${p.id} is ${state}.\n${t.text || '(no new output)'}`);
      },
    };
  },
};

export const stopProcessTool: Tool<IdArgs> = {
  name: 'stop_process',
  category: 'command',
  description: 'Stop a background process and its child processes.',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  title: (a) => `Stop ${a.id}`,
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const p = ctx.processes.get(args.id);
        if (!p) return fail(`No process with id ${args.id}.`);
        await ctx.processes.stop(args.id);
        ctx.update({ title: `Stopped ${p.id} (${p.description || p.command})` });
        return ok(`Stopped process ${p.id}.`);
      },
    };
  },
};

export const listProcessesTool: Tool<Record<string, never>> = {
  name: 'list_processes',
  category: 'read',
  description: 'List background processes started in this session.',
  parameters: { type: 'object', properties: {} },
  title: () => 'List background processes',
  async prepare(_args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const list = ctx.processes.list();
        if (!list.length) return ok('No background processes.');
        return ok(
          list
            .map((p) => `${p.id}\t${p.exitCode === undefined ? 'running' : `exited (${p.exitCode})`}\t${Math.round((Date.now() - p.startedAt) / 1000)}s\t${p.command}`)
            .join('\n'),
        );
      },
    };
  },
};
