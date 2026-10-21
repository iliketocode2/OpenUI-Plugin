import { realpathSync } from 'node:fs';
import * as path from 'node:path';

export type PathZone = 'workspace' | 'scratchpad' | 'outside';

export interface ResolvedPath {
  absolute: string;
  zone: PathZone;
  root?: string;
  display: string;
  sensitive: boolean;
  /** Git or VS Code configuration: writing it can make Git or the editor run programs or change the agent's permissions. */
  control?: boolean;
}

const SENSITIVE = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)$/i,
  /(^|[\\/])\.(ssh|aws|gnupg|docker|kube)([\\/]|$)/i,
  /(^|[\\/])(credentials|secrets?)(\.[a-z]+)?$/i,
];

const CONTROL = /(^|[\\/])\.(git|vscode)([\\/]|$)/i;

/** Globs (ripgrep syntax) that keep directory-wide searches away from the files SENSITIVE matches. */
export const SENSITIVE_GLOBS = ['.env', '.env.*', '*.{pem,key,p12,pfx,keystore,jks,kdbx}', 'id_{rsa,dsa,ecdsa,ed25519}', 'id_{rsa,dsa,ecdsa,ed25519}.pub', '.{npmrc,pypirc,netrc,git-credentials}', '.{ssh,aws,gnupg,docker,kube}', '{credentials,secret,secrets}', '{credentials,secret,secrets}.*'];

export function isSensitivePath(p: string): boolean {
  return SENSITIVE.some((re) => re.test(p));
}

export class PathGuard {
  private readonly caseInsensitive: boolean;

  constructor(
    private readonly roots: () => string[],
    private readonly scratchpad: string,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.caseInsensitive = platform === 'win32' || platform === 'darwin';
    this.windows = platform === 'win32';
  }

  private readonly windows: boolean;

  workspaceRoots(): string[] {
    return this.roots();
  }

  primaryRoot(): string | undefined {
    return this.roots()[0];
  }

  resolve(input: string, base?: string): ResolvedPath {
    const trimmed = input.trim().replace(/^["']|["']$/g, '');
    if (!trimmed) throw new Error('A path is required.');
    const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') ? path.join(homeDir(), trimmed.slice(1)) : trimmed;
    const from = base ?? this.primaryRoot() ?? this.scratchpad;
    const absolute = canonical(path.resolve(from, expanded));
    // NTFS alternate data streams (file.txt::$DATA, file.txt:hidden) bypass name-based checks.
    if (this.windows && absolute.replace(/^\\\\[?.]\\/, '').slice(2).includes(':')) throw new Error(`Paths with ":" after the drive letter are not supported: ${input}`);
    return this.classify(absolute);
  }

  classify(absolute: string): ResolvedPath {
    const real = realOrNearest(absolute);
    // Check the link target too, so a link named notes.txt that points at .env still counts as sensitive.
    const flags = { sensitive: isSensitivePath(absolute) || isSensitivePath(real), control: CONTROL.test(absolute) || CONTROL.test(real) };
    for (const root of this.roots()) {
      const r = realOrNearest(root);
      if (this.within(real, r)) return { absolute, zone: 'workspace', root, display: displayPath(absolute, root), ...flags };
    }
    const sp = realOrNearest(this.scratchpad);
    if (this.within(real, sp)) {
      return { absolute, zone: 'scratchpad', root: this.scratchpad, display: `<scratchpad>/${toSlash(path.relative(this.scratchpad, absolute))}`, ...flags };
    }
    return { absolute, zone: 'outside', display: absolute, ...flags };
  }

  private within(child: string, parent: string): boolean {
    const c = this.caseInsensitive ? child.toLowerCase() : child;
    const p = this.caseInsensitive ? parent.toLowerCase() : parent;
    if (c === p) return true;
    const rel = path.relative(p, c);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '/';
}

function canonical(p: string): string {
  const n = path.normalize(p);
  return n.length > 1 && /[\\/]$/.test(n) && !/^[A-Za-z]:\\$/.test(n) ? n.slice(0, -1) : n;
}

function realOrNearest(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function toSlash(p: string): string {
  return p.split(path.sep).join('/');
}

export function displayPath(absolute: string, root: string): string {
  const rel = path.relative(root, absolute);
  return rel ? toSlash(rel) : '.';
}
