import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processTool, runCommandTool, startProcessTool } from '../../src/tools/shell/tools';
import { availableShells, createToolEnv, type TestEnv } from '../helpers/toolContext';

const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));

const ECHO: Record<string, string> = {
  gitbash: 'echo "hello from $0" && pwd',
  bash: 'echo "hello from $0" && pwd',
  zsh: 'echo "hello from $0" && pwd',
  sh: 'echo "hello from $0" && pwd',
  powershell: 'Write-Output "hello from powershell"; (Get-Location).Path',
  cmd: 'echo hello from cmd && cd',
};

let env: TestEnv;

beforeEach(async () => {
  env = await createToolEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe.each(availableShells())('run_command with %s', (shell) => {
  it('runs in the workspace (path with spaces) and reports exit code 0', async () => {
    const r = await env.run(runCommandTool, { command: ECHO[shell]!, description: 'Say hello', shell });
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toMatch(/^Exit code 0\./);
    expect(r.content).toMatch(/hello from/);
    expect(r.content.toLowerCase().replace(/\\/g, '/')).toContain(path.basename(env.workspace).toLowerCase());
  });

  it('reports a failing exit code as an error', async () => {
    const r = await env.run(runCommandTool, { command: 'exit 3', description: 'Fail on purpose', shell });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/^Exit code 3\./);
  });
});

describe('run_command behaviour', () => {
  it('runs node with arguments containing spaces and quotes', async () => {
    await writeFile(path.join(env.workspace, 'args.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    const r = await env.run(runCommandTool, { command: `${node} args.js "a b" c`, description: 'Print args' });
    expect(r.content).toContain('["a b","c"]');
  });

  it('kills commands that exceed the timeout, including child processes', async () => {
    const started = Date.now();
    const r = await env.run(runCommandTool, { command: `${node} -e "setInterval(() => {}, 1000)"`, description: 'Hang', timeout_seconds: 2 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Timed out after 2s/);
    // Generous: this catches a command that is never killed, not a slow kill on a busy machine.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 45_000);

  it('stops when the user cancels', async () => {
    setTimeout(() => env.controller.abort(), 500);
    const r = await env.run(runCommandTool, { command: `${node} -e "setInterval(() => {}, 1000)"`, description: 'Hang' });
    expect(r.content).toMatch(/cancelled by the user/);
  });

  it('truncates long output and saves the full log in the scratchpad', async () => {
    const r = await env.run(runCommandTool, { command: `${node} -e "for (let i = 0; i < 5000; i++) console.log('row ' + i)"`, description: 'Lots of output' });
    expect(r.content).toMatch(/omitted/);
    expect(r.content).toContain('row 0');
    expect(r.content).toContain('row 4999');
    const log = /full output \(\d+ characters\) is in (.+?)\. Use/.exec(r.content)?.[1];
    expect(log && existsSync(log)).toBe(true);
    expect((await readFile(log!, 'utf8')).split('\n').filter(Boolean)).toHaveLength(5000);
  });

  it('streams output updates to the card and strips ANSI colours', async () => {
    await env.run(runCommandTool, { command: `${node} -e "console.log('\\x1b[31mred\\x1b[0m')"`, description: 'Colour' });
    expect(env.updates.some((u) => u.output === 'red')).toBe(true);
    expect(env.updates.at(-1)?.exitCode).toBe(0);
  });

  it('rejects unknown shells with the list of available ones', async () => {
    const r = await env.run(runCommandTool, { command: 'echo x', description: 'x', shell: 'fish' });
    expect(r.content).toMatch(/not available/);
  });
});

describe('background processes', () => {
  it('starts a server, waits for its port, reads output and stops it', async () => {
    await writeFile(
      path.join(env.workspace, 'server.js'),
      "const s = require('http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', () => { console.log('listening on ' + s.address().port); });",
    );
    const start = await env.run(startProcessTool, { command: `${node} server.js`, description: 'Start test server', wait_for: 'listening on \\d+' });
    expect(start.isError, start.content).toBeFalsy();
    expect(start.content).toMatch(/Process p1 is running \(output matched wait_for\)/);
    const list = await env.run(processTool, { action: 'list' });
    expect(list.content).toMatch(/p1\trunning/);
    const more = await env.run(processTool, { action: 'output', id: 'p1', all: true });
    expect(more.content).toMatch(/listening on/);
    expect((await env.run(processTool, { action: 'stop' })).content).toMatch(/id is required/);
    const stop = await env.run(processTool, { action: 'stop', id: 'p1' });
    expect(stop.content).toBe('Stopped process p1.');
    expect(env.processes.get('p1')?.exitCode).not.toBeUndefined();
  });

  it('reports a process that exits immediately', async () => {
    const r = await env.run(startProcessTool, { command: `${node} -e "console.log('bye'); process.exit(2)"`, description: 'Exit early', wait_for: 'never' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/exited with code 2/);
  });

  it('stopAll cleans up every running process', async () => {
    await env.run(startProcessTool, { command: `${node} -e "setInterval(() => {}, 1000)"`, description: 'Idle 1' });
    await env.run(startProcessTool, { command: `${node} -e "setInterval(() => {}, 1000)"`, description: 'Idle 2' });
    expect(env.processes.runningCount()).toBe(2);
    await env.processes.stopAll();
    expect(env.processes.list()).toHaveLength(0);
  });
});
