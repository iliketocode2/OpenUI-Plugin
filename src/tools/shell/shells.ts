import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export type ShellId = 'gitbash' | 'powershell' | 'cmd' | 'bash' | 'zsh' | 'sh';

export interface ShellSpec {
  id: ShellId;
  label: string;
  executable: string;
  args(command: string): string[];
  verbatim: boolean;
  syntax: 'posix' | 'powershell' | 'cmd';
}

function which(name: string, platform: NodeJS.Platform): string[] {
  try {
    const out = execFileSync(platform === 'win32' ? 'where.exe' : 'which', platform === 'win32' ? [name] : ['-a', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function findGitBash(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (platform !== 'win32') return undefined;
  const candidates: string[] = [];
  for (const git of which('git', platform)) {
    let dir = path.dirname(git);
    for (let i = 0; i < 3; i++) {
      candidates.push(path.join(dir, 'bin', 'bash.exe'));
      dir = path.dirname(dir);
    }
  }
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  return candidates.find((c) => !/[\\/]system32[\\/]/i.test(c) && existsSync(c));
}

const UTF8_PS = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;';

export class ShellRegistry {
  private cache: ShellSpec[] | undefined;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  available(): ShellSpec[] {
    this.cache ??= this.detect();
    return this.cache;
  }

  get(id: string | undefined): ShellSpec | undefined {
    const shells = this.available();
    if (!id) return shells[0];
    return shells.find((s) => s.id === id);
  }

  pick(preferred: string | undefined): ShellSpec {
    const shell = this.get(preferred) ?? this.available()[0];
    if (!shell) throw new Error('No usable shell was found on this machine.');
    return shell;
  }

  private detect(): ShellSpec[] {
    const out: ShellSpec[] = [];
    if (this.platform === 'win32') {
      const bash = findGitBash(this.platform);
      if (bash) out.push(posixShell('gitbash', 'Git Bash', bash));
      const pwsh = which('pwsh', this.platform)[0];
      const system = process.env.SystemRoot ?? 'C:\\Windows';
      const winps = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const ps = pwsh ?? (existsSync(winps) ? winps : which('powershell', this.platform)[0]);
      if (ps) {
        out.push({
          id: 'powershell',
          label: pwsh ? 'PowerShell 7' : 'Windows PowerShell',
          executable: ps,
          args: (c) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${UTF8_PS}${c}`],
          verbatim: false,
          syntax: 'powershell',
        });
      }
      const comspec = process.env.ComSpec ?? path.join(system, 'System32', 'cmd.exe');
      out.push({ id: 'cmd', label: 'Command Prompt', executable: comspec, args: (c) => ['/d', '/s', '/c', `"${c}"`], verbatim: true, syntax: 'cmd' });
      return out;
    }
    for (const [id, label] of [
      ['bash', 'bash'],
      ['zsh', 'zsh'],
      ['sh', 'sh'],
    ] as const) {
      const exe = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].map((d) => path.join(d, id)).find((p) => existsSync(p)) ?? which(id, this.platform)[0];
      if (exe) out.push(posixShell(id, label, exe));
    }
    return out;
  }
}

function posixShell(id: ShellId, label: string, executable: string): ShellSpec {
  return { id, label, executable, args: (c) => (id === 'gitbash' || id === 'bash' ? ['--noprofile', '--norc', '-c', c] : ['-c', c]), verbatim: false, syntax: 'posix' };
}
