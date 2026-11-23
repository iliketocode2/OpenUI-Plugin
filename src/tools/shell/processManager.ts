import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { probeLoopbackPort } from '../../net/loopback';
import { OutputBuffer, OutputDecoder } from './output';
import type { ShellSpec } from './shells';
import { killTree, spawnShell } from './spawn';

export interface ManagedProcess {
  id: string;
  command: string;
  description: string;
  cwd: string;
  shell: string;
  startedAt: number;
  /** undefined while the shell runs; null when a signal ended it. */
  exitCode: number | null | undefined;
  /** The shell exited, but a process it left in the background still holds its output open. */
  lingering: boolean;
  output: OutputBuffer;
  /** The unfinished last line of output, for live display. */
  partial(): string;
}

interface Entry extends ManagedProcess {
  child: ChildProcess;
  /** Resolves once the output is complete: when the streams close, or shortly after the shell exits. */
  done: Promise<void>;
  listeners: Set<() => void>;
}

export interface StartOptions {
  /** Also write the raw output to this file. */
  logPath?: string;
  /** A command the caller waits for and then forgets (run_command); it is not listed with the background processes. */
  foreground?: boolean;
}

export type WaitResult = 'done' | 'timeout' | 'aborted';

const BUFFER_CHARS = 200_000;
/** How long to wait for output to finish after the shell exits. 'close' waits for every process holding stdout or
 * stderr, so a child left running in the background (`cmd &`, `start /b`) would otherwise hold it forever. */
const CLOSE_GRACE_MS = 500;

/** Starts, watches and stops every command the agent runs, in the foreground or the background. */
export class ProcessManager {
  private readonly procs = new Map<string, Entry>();
  private seq = 0;
  private foregroundSeq = 0;

  start(shell: ShellSpec, command: string, cwd: string, description: string, opts: StartOptions = {}): ManagedProcess {
    const child = spawnShell(shell, command, cwd);
    const id = opts.foreground ? `run${++this.foregroundSeq}` : `p${++this.seq}`;
    const output = new OutputBuffer(BUFFER_CHARS);
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((l) => l());
    const log = opts.logPath ? createWriteStream(opts.logPath) : undefined;
    log?.on('error', () => undefined);
    // One decoder per stream, so a half-written stdout line never merges with a stderr line.
    const streams: [Readable | null, OutputDecoder][] = [
      [child.stdout, new OutputDecoder()],
      [child.stderr, new OutputDecoder()],
    ];
    let settled = false;
    for (const [stream, decoder] of streams) {
      stream?.on('data', (d: Buffer) => {
        if (!settled) log?.write(d);
        const text = decoder.push(d);
        if (text) output.push(text);
        notify();
      });
    }
    const entry: Entry = {
      id,
      command,
      description,
      cwd,
      shell: shell.label,
      startedAt: Date.now(),
      exitCode: undefined,
      lingering: false,
      output,
      partial: () => streams.map(([, d]) => d.partial).filter(Boolean).join('\n'),
      child,
      listeners,
      done: new Promise((resolve) => {
        const settle = () => {
          if (settled) return;
          settled = true;
          for (const [, decoder] of streams) {
            const rest = decoder.flush();
            if (rest) output.push(rest);
          }
          log?.end();
          notify();
          resolve();
        };
        child.once('close', settle);
        child.once('error', (err) => {
          output.push(`\n[failed to start ${shell.label}: ${err.message}]\n`);
          entry.exitCode ??= -1;
          settle();
        });
        child.once('exit', (code, signal) => {
          entry.exitCode = code ?? (signal ? null : 0);
          notify();
          setTimeout(() => {
            if (settled) return;
            // Keep reading (a full pipe would block the leftover process), but stop it holding the extension open.
            entry.lingering = true;
            for (const [stream] of streams) (stream as { unref?: () => void } | null)?.unref?.();
            settle();
          }, CLOSE_GRACE_MS).unref();
        });
      }),
    };
    this.procs.set(id, entry);
    return entry;
  }

  get(id: string): ManagedProcess | undefined {
    return this.procs.get(id);
  }

  /** Background processes, for the process tool. */
  list(): ManagedProcess[] {
    return [...this.procs.values()].filter((p) => !p.id.startsWith('run'));
  }

  /** Calls `listener` whenever the process produces output or exits; returns a function that unsubscribes. */
  watch(id: string, listener: () => void): () => void {
    const entry = this.procs.get(id);
    entry?.listeners.add(listener);
    return () => entry?.listeners.delete(listener);
  }

  /** Waits until the process has exited and its output is complete. */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const entry = this.procs.get(id);
    if (!entry) return 'done';
    if (signal?.aborted) return 'aborted';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        entry.done.then(() => 'done' as const),
        new Promise<WaitResult>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
        new Promise<WaitResult>((resolve) => {
          onAbort = () => resolve('aborted');
          signal?.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  async waitFor(id: string, opts: { pattern?: RegExp; port?: number; timeoutMs: number; signal?: AbortSignal }): Promise<'matched' | 'port' | 'exited' | 'timeout' | 'aborted'> {
    const entry = this.procs.get(id);
    if (!entry) return 'exited';
    const deadline = Date.now() + opts.timeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: 'matched' | 'port' | 'exited' | 'timeout' | 'aborted') => {
        if (settled) return;
        settled = true;
        entry.listeners.delete(check);
        clearInterval(portTimer);
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const check = () => {
        if (opts.pattern && opts.pattern.test(`${entry.output.all()}${entry.partial()}`)) finish('matched');
        else if (entry.exitCode !== undefined) finish('exited');
      };
      const onAbort = () => finish('aborted');
      const portTimer = setInterval(() => {
        if (opts.port !== undefined) void probeLoopbackPort(opts.port).then((up) => up && finish('port'));
      }, 500);
      const timer = setTimeout(() => finish('timeout'), Math.max(0, deadline - Date.now()));
      entry.listeners.add(check);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  /** Stops the process and what it started. Also used after the shell exited: on POSIX that ends leftover children. */
  async stop(id: string): Promise<boolean> {
    const entry = this.procs.get(id);
    if (!entry) return false;
    const running = entry.exitCode === undefined;
    if (!running && !entry.lingering) return true;
    await killTree(entry.child);
    if (running) await Promise.race([entry.done, new Promise((r) => setTimeout(r, 3000))]);
    return true;
  }

  /** Drops a finished foreground process from the table. */
  forget(id: string): void {
    this.procs.delete(id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
    this.procs.clear();
  }
}
