import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { fail, ok, type Tool, type ToolContext } from '../types';
import { truncateMiddle } from './output';
import type { ShellSpec } from './shells';

const UPDATE_MS = 300;
const DISPLAY_CHARS = 6000;

/** The registry narrows this enum to the shells installed on this machine, or drops it when there is only one. */
function shellParam(): { type: 'string'; enum: string[]; description: string } {
  return { type: 'string', enum: ['gitbash', 'powershell', 'cmd', 'bash', 'zsh', 'sh'], description: 'Defaults to the configured shell.' };
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
  description: 'Run a command and wait for it to finish (builds, tests, linters, installs). No stdin: pass flags like --yes. For servers and watchers use start_process.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'Five to ten words, shown to the user.' },
      shell: shellParam(),
      cwd: { type: 'string', description: 'Defaults to the workspace root.' },
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
  const proc = ctx.processes.start(shell, args.command, cwd, args.description, { logPath, foreground: true });
  const show = () => tail(`${proc.output.all()}${proc.partial()}`);
  const live = throttle(() => ctx.update({ output: show() }), UPDATE_MS);
  const unwatch = ctx.processes.watch(proc.id, live.call);
  const outcome = await ctx.processes.wait(proc.id, timeoutMs, ctx.signal);
  if (outcome !== 'done') await ctx.processes.stop(proc.id);
  unwatch();
  live.cancel();
  ctx.processes.forget(proc.id);

  const t = truncateMiddle(proc.output.all().trimEnd(), ctx.settings.maxOutputChars);
  ctx.update({ output: tail(t.text), exitCode: proc.exitCode ?? null });
  if (outcome === 'aborted' || ctx.signal.aborted) return fail(`Command cancelled by the user.\n${t.text}`);
  const timedOut = outcome === 'timeout';
  const status = timedOut ? `Timed out after ${timeoutMs / 1000}s and was killed.` : `Exit code ${proc.exitCode}.`;
  const body = t.text ? `\n${t.text}` : '\n(no output)';
  const full = t.truncated ? `\n[Output truncated; the full output (${proc.output.length} characters) is in ${logPath}. Use read_file or grep on it.]` : '';
  const bg = proc.lingering && !timedOut
    ? '\n[The command exited, but a process it started in the background is still running; its later output is not captured. Use start_process for servers and watchers.]'
    : '';
  const result = `${status}${body}${full}${bg}`;
  return proc.exitCode === 0 && !timedOut ? ok(result) : fail(result);
}

/** The end of the output, as shown on the tool card. */
function tail(text: string): string {
  return text.length > DISPLAY_CHARS ? `…\n${text.slice(-DISPLAY_CHARS)}` : text;
}

/** Runs `fn` at most once per `ms`, and once more at the end of a burst. */
function throttle(fn: () => void, ms: number): { call: () => void; cancel: () => void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    timer = undefined;
    last = Date.now();
    fn();
  };
  return {
    call: () => {
      if (Date.now() - last > ms) run();
      else timer ??= setTimeout(run, ms);
    },
    cancel: () => clearTimeout(timer),
  };
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
  description: 'Start a background process (dev server, watcher) and return its id; manage it with the process tool. Optionally wait for an output regex or a localhost port.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'Five to ten words, shown to the user.' },
      shell: shellParam(),
      cwd: { type: 'string' },
      wait_for: { type: 'string', description: 'Output regex, e.g. "ready|listening".' },
      wait_for_port: { type: 'integer', minimum: 1, maximum: 65535 },
      wait_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Default 60.' },
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

interface ProcessArgs {
  action: 'output' | 'stop' | 'list';
  id?: string;
  all?: boolean;
}

export const processTool: Tool<ProcessArgs> = {
  name: 'process',
  category: 'read',
  description: 'Manage background processes from start_process: "output" returns new output (all=true for everything buffered), "stop" stops one and its children, "list" lists them.',
  parameters: {
    type: 'object',
    properties: { action: { type: 'string', enum: ['output', 'stop', 'list'] }, id: { type: 'string' }, all: { type: 'boolean' } },
    required: ['action'],
  },
  title: (a) => (a.action === 'list' ? 'List background processes' : a.action === 'stop' ? `Stop ${a.id}` : `Read output of ${a.id}`),
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        if (args.action === 'list') {
          const list = ctx.processes.list();
          if (!list.length) return ok('No background processes.');
          return ok(
            list
              .map((p) => `${p.id}\t${p.exitCode === undefined ? 'running' : `exited (${p.exitCode})`}\t${Math.round((Date.now() - p.startedAt) / 1000)}s\t${p.command}`)
              .join('\n'),
          );
        }
        if (!args.id) return fail(`id is required for action "${args.action}".`);
        const p = ctx.processes.get(args.id);
        if (!p) return fail(`No process with id ${args.id}. Use action "list".`);
        if (args.action === 'stop') {
          await ctx.processes.stop(args.id);
          ctx.update({ title: `Stopped ${p.id} (${p.description || p.command})` });
          return ok(`Stopped process ${p.id}.`);
        }
        const text = args.all ? p.output.all() : p.output.sinceLastRead();
        const t = truncateMiddle(text, ctx.settings.maxOutputChars);
        const state = p.exitCode === undefined ? 'running' : `exited with code ${p.exitCode}`;
        ctx.update({ title: `Output of ${p.id} (${p.description || p.command})`, output: t.text.slice(-DISPLAY_CHARS) });
        return ok(`Process ${p.id} is ${state}.\n${t.text || '(no new output)'}`);
      },
    };
  },
};
