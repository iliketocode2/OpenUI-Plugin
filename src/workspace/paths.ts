import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

export type PathZone = 'workspace' | 'scratchpad' | 'outside';

export interface ResolvedPath {
  absolute: string;
  zone: PathZone;
  root?: string;
  display: string;
  sensitive: boolean;
  /** Git, VS Code or OWUI Agent configuration: writing it can make Git or the editor run programs, change the agent's
   * permissions, or plant memory and skills that later sessions load as instructions. */
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

const CONTROL = /(^|[\\/])\.(git|vscode|owui)([\\/]|$)/i;

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
      if (this.within(real, r)) return { absolute, zone: 'workspace', root, display: this.relativeName(absolute, real, root, r), ...flags };
    }
    const sp = realOrNearest(this.scratchpad);
    if (this.within(real, sp)) {
      return { absolute, zone: 'scratchpad', root: this.scratchpad, display: `<scratchpad>/${this.relativeName(absolute, real, this.scratchpad, sp)}`, ...flags };
    }
    return { absolute, zone: 'outside', display: absolute, ...flags };
  }

  /** The name of a file under `root` relative to it. `absolute` may be spelled through the root as VS Code reports
   * it (/var/…, C:\Users\RUNNER~1\…) or through its real path (/private/var/…); the link's own name is kept when it
   * is inside the root. Only a file reached through a link from elsewhere is named by where it really is. */
  private relativeName(absolute: string, real: string, root: string, realRoot: string): string {
    if (this.within(absolute, root)) return displayPath(absolute, root);
    if (this.within(absolute, realRoot)) return displayPath(absolute, realRoot);
    return displayPath(real, realRoot);
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

/** The one spelling of a file's path: the true case on case-insensitive disks, with links resolved. Two paths to the
 * same file give the same result, also for a file that does not exist yet. */
export function realPath(p: string): string {
  return realOrNearest(canonical(p));
}

/** Links followed before giving up, as the OS does for a cycle. */
const MAX_LINKS = 40;

/** Where `p` really is, or would be once created: the real path of its nearest existing ancestor plus the rest.
 * A dangling link has no real path, but writing through it creates its target, so its target is followed too. */
function realOrNearest(p: string, links = 0): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const target = links < MAX_LINKS ? linkTarget(cur) : undefined;
      if (target) return realOrNearest(path.join(target, ...[...tail].reverse()), links + 1);
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function linkTarget(p: string): string | undefined {
  try {
    if (!lstatSync(p).isSymbolicLink()) return undefined;
    return path.resolve(path.dirname(p), readlinkSync(p));
  } catch {
    return undefined;
  }
}

export function toSlash(p: string): string {
  return p.split(path.sep).join('/');
}

export function displayPath(absolute: string, root: string): string {
  const rel = path.relative(root, absolute);
  return rel ? toSlash(rel) : '.';
}
