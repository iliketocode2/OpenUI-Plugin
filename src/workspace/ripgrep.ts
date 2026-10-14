import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export function ripgrepCandidates(appRoot: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  const exe = platform === 'win32' ? 'rg.exe' : 'rg';
  const plat = `${platform}-${arch}`;
  const out: string[] = [];
  for (const nm of ['node_modules.asar.unpacked', 'node_modules']) {
    out.push(path.join(appRoot, nm, '@vscode', 'ripgrep-universal', 'bin', plat, exe));
    out.push(path.join(appRoot, nm, '@vscode', 'ripgrep', 'bin', exe));
  }
  return out;
}

export function locateRipgrep(appRoot: string | undefined): string | undefined {
  if (appRoot) {
    const found = ripgrepCandidates(appRoot).find((p) => existsSync(p));
    if (found) return found;
  }
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return undefined;
}

export interface RgResult {
  stdout: string;
  stderr: string;
  code: number | null;
  truncated: boolean;
}

export function runRipgrep(rg: string, args: string[], cwd: string, signal: AbortSignal, maxBytes = 2_000_000): Promise<RgResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxBytes) stdout += d.toString('utf8');
      else if (!truncated) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, truncated });
    });
  });
}
