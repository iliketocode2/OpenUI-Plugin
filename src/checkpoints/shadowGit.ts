import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

const LOCAL_SUBCOMMANDS = new Set(['init', 'config', 'add', 'commit', 'rev-parse', 'diff', 'checkout', 'show', 'cat-file', 'ls-files', 'status', 'log', 'version']);

const DEFAULT_EXCLUDES = [
  '.git/',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  'target/',
  '.gradle/',
  '.vscode-test/',
  'coverage/',
  '*.log',
];

export class GitUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitUnavailableError';
  }
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D';
  path: string;
}

export interface ShadowGitOptions {
  gitDir: string;
  workTree: string;
  git?: string;
  timeoutMs?: number;
}

export class ShadowGit {
  private readonly git: string;
  private readonly timeoutMs: number;
  private ready: Promise<void> | undefined;

  constructor(private readonly opts: ShadowGitOptions) {
    this.git = opts.git ?? 'git';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  get workTree(): string {
    return this.opts.workTree;
  }

  init(): Promise<void> {
    this.ready ??= this.doInit().catch((e) => {
      this.ready = undefined;
      throw e;
    });
    return this.ready;
  }

  async snapshot(message: string): Promise<string> {
    await this.init();
    await this.run(['add', '--all', '--ignore-errors', '--', '.']);
    await this.run(['commit', '--quiet', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', message]);
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async changes(from: string, to: string): Promise<ChangedFile[]> {
    const out = await this.run(['diff', '--name-status', '--no-renames', '-z', from, to]);
    const parts = out.split('\0').filter(Boolean);
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i]![0] as ChangedFile['status'];
      if (status === 'A' || status === 'M' || status === 'D') files.push({ status, path: parts[i + 1]! });
    }
    return files;
  }

  async fileAt(sha: string, relPath: string): Promise<string | undefined> {
    try {
      return await this.run(['show', `${sha}:${relPath.split(path.sep).join('/')}`]);
    } catch {
      return undefined;
    }
  }

  async restoreFiles(sha: string, relPaths: string[]): Promise<void> {
    if (!relPaths.length) return;
    const list = path.join(this.opts.gitDir, 'owui-restore-paths');
    await writeFile(list, relPaths.map((p) => p.split(path.sep).join('/')).join('\0'));
    await this.run(['checkout', sha, '--pathspec-from-file', list, '--pathspec-file-nul']);
  }

  private async doInit(): Promise<void> {
    try {
      await this.run(['version'], { bare: true });
    } catch (e) {
      throw new GitUnavailableError(`git is not available: ${(e as Error).message}`);
    }
    await mkdir(this.opts.gitDir, { recursive: true });
    const head = path.join(this.opts.gitDir, 'HEAD');
    let initialized = true;
    try {
      await readFile(head);
    } catch {
      initialized = false;
    }
    if (!initialized) await this.run(['init', '--quiet']);
    const hooks = path.join(this.opts.gitDir, 'owui-no-hooks');
    await mkdir(hooks, { recursive: true });
    for (const [k, v] of [
      ['user.name', 'OWUI Agent checkpoints'],
      ['user.email', 'checkpoints@localhost'],
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.longpaths', 'true'],
      ['core.quotepath', 'false'],
      ['core.hooksPath', hooks],
      ['core.fsmonitor', 'false'],
      ['commit.gpgsign', 'false'],
      ['gc.auto', '0'],
    ]) {
      await this.run(['config', '--local', k!, v!]);
    }
    await mkdir(path.join(this.opts.gitDir, 'info'), { recursive: true });
    await writeFile(path.join(this.opts.gitDir, 'info', 'exclude'), `${DEFAULT_EXCLUDES.join('\n')}\n`);
    await writeFile(path.join(this.opts.gitDir, 'owui-empty-gitconfig'), '');
  }

  run(args: string[], opts: { bare?: boolean } = {}): Promise<string> {
    const sub = args[0];
    if (!sub || !LOCAL_SUBCOMMANDS.has(sub)) return Promise.reject(new Error(`git ${sub ?? ''} is not allowed for checkpoints`));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(this.opts.gitDir, 'owui-empty-gitconfig'),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_ASKPASS: '',
      LC_ALL: 'C',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    if (!opts.bare) {
      env.GIT_DIR = this.opts.gitDir;
      env.GIT_WORK_TREE = this.opts.workTree;
    }
    for (const k of ['GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES']) delete env[k];
    return new Promise((resolve, reject) => {
      execFile(
        this.git,
        args,
        { cwd: this.opts.workTree, env, windowsHide: true, timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${sub} failed: ${(stderr || err.message).trim().slice(0, 500)}`));
          else resolve(stdout);
        },
      );
    });
  }
}
