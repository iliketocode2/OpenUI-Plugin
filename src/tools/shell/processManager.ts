import type { ChildProcess } from 'node:child_process';
import { probeLoopbackPort } from '../../net/loopback';
import { OutputBuffer, cleanOutput } from './output';
import type { ShellSpec } from './shells';
import { killTree, spawnShell } from './spawn';

export interface ManagedProcess {
  id: string;
  command: string;
  description: string;
  cwd: string;
  shell: string;
  startedAt: number;
  exitCode: number | null | undefined;
  output: OutputBuffer;
}

interface Entry extends ManagedProcess {
  child: ChildProcess;
  exited: Promise<void>;
  listeners: Set<() => void>;
}

const BUFFER_CHARS = 200_000;

export class ProcessManager {
  private readonly procs = new Map<string, Entry>();
  private seq = 0;

  start(shell: ShellSpec, command: string, cwd: string, description: string): ManagedProcess {
    const child = spawnShell(shell, command, cwd);
    const id = `p${++this.seq}`;
    const output = new OutputBuffer(BUFFER_CHARS);
    const listeners = new Set<() => void>();
    const entry: Entry = {
      id,
      command,
      description,
      cwd,
      shell: shell.label,
      startedAt: Date.now(),
      exitCode: undefined,
      output,
      child,
      listeners,
      exited: new Promise((resolve) => {
        child.once('exit', (code, signal) => {
          entry.exitCode = code ?? (signal ? null : 0);
          listeners.forEach((l) => l());
          resolve();
        });
        child.once('error', (err) => {
          output.push(`\n[failed to start: ${err.message}]\n`);
          entry.exitCode = entry.exitCode ?? -1;
          listeners.forEach((l) => l());
          resolve();
        });
      }),
    };
    const onData = (d: Buffer) => {
      output.push(cleanOutput(d.toString('utf8')));
      listeners.forEach((l) => l());
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    this.procs.set(id, entry);
    return entry;
  }

  get(id: string): ManagedProcess | undefined {
    return this.procs.get(id);
  }

  list(): ManagedProcess[] {
    return [...this.procs.values()];
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
        if (opts.pattern && opts.pattern.test(entry.output.all())) finish('matched');
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

  async stop(id: string): Promise<boolean> {
    const entry = this.procs.get(id);
    if (!entry) return false;
    if (entry.exitCode === undefined) {
      await killTree(entry.child);
      await Promise.race([entry.exited, new Promise((r) => setTimeout(r, 3000))]);
    }
    return true;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
    this.procs.clear();
  }

  runningCount(): number {
    return [...this.procs.values()].filter((p) => p.exitCode === undefined).length;
  }
}
