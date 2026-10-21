import { spawn, type ChildProcess } from 'node:child_process';
import type { ShellSpec } from './shells';

export function commandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GCM_INTERACTIVE: 'never',
    NO_UPDATE_NOTIFIER: '1',
    // npm assumes --yes when stdin is not a terminal, which would let npx download and run packages without asking.
    npm_config_yes: 'false',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    FORCE_COLOR: '0',
  };
}

export function spawnShell(shell: ShellSpec, command: string, cwd: string): ChildProcess {
  return spawn(shell.executable, shell.args(command), {
    cwd,
    env: commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: shell.verbatim,
    detached: process.platform !== 'win32',
  });
}

export function killTree(child: ChildProcess, graceMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    const pid = child.pid;
    const done = () => resolve();
    child.once('exit', done);
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
      killer.on('exit', () => setTimeout(done, 200));
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already exited
      }
      done();
    }, graceMs).unref();
  });
}
