import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SerializedCheckpoint } from '../storage/history';
import type { ShadowGit } from './shadowGit';

export interface Checkpoint {
  id: string;
  label: string;
  ts: number;
  sha?: string;
  snapshotError?: string;
  originals: Map<string, string | null>;
}

export interface PlannedChange {
  absolute: string;
  action: 'restore' | 'delete';
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  method: 'git' | 'backups';
}

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export class CheckpointManager {
  private readonly checkpoints: Checkpoint[] = [];

  constructor(
    private readonly shadow: ShadowGit | undefined,
    private readonly backupDir: string,
  ) {}

  list(): readonly Checkpoint[] {
    return this.checkpoints;
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  current(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  async begin(label: string): Promise<Checkpoint> {
    const cp: Checkpoint = { id: randomUUID(), label, ts: Date.now(), originals: new Map() };
    this.checkpoints.push(cp);
    if (this.shadow) {
      try {
        cp.sha = await this.shadow.snapshot(`before: ${label.slice(0, 200)}`);
      } catch (e) {
        cp.snapshotError = (e as Error).message;
      }
    } else {
      cp.snapshotError = 'snapshots are turned off, or no workspace folder is open';
    }
    return cp;
  }

  async recordBeforeWrite(absolute: string): Promise<void> {
    const cp = this.current();
    if (!cp || cp.originals.has(absolute)) return;
    try {
      const st = await stat(absolute);
      if (!st.isFile() || st.size > MAX_BACKUP_BYTES) {
        cp.originals.set(absolute, null);
        return;
      }
      const content = await readFile(absolute);
      const file = path.join(this.backupDir, cp.id, createHash('sha1').update(absolute).digest('hex'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      cp.originals.set(absolute, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') cp.originals.set(absolute, null);
      else throw e;
    }
  }

  agentChangesSince(id: string): PlannedChange[] {
    const first = new Map<string, string | null>();
    const start = this.checkpoints.findIndex((c) => c.id === id);
    if (start === -1) return [];
    for (const cp of this.checkpoints.slice(start)) {
      for (const [abs, backup] of cp.originals) if (!first.has(abs)) first.set(abs, backup);
    }
    return [...first].map(([absolute, backup]) => ({ absolute, action: backup === null ? 'delete' : 'restore' }));
  }

  async plan(id: string): Promise<{ changes: PlannedChange[]; method: 'git' | 'backups' }> {
    const cp = this.get(id);
    if (!cp) throw new Error('Unknown checkpoint.');
    if (cp.sha && this.shadow) {
      const now = await this.shadow.snapshot(`rewind preview to ${cp.id}`);
      const diff = await this.shadow.changes(cp.sha, now);
      return {
        method: 'git',
        changes: diff.map((f) => ({ absolute: path.join(this.shadow!.workTree, f.path), action: f.status === 'A' ? 'delete' : 'restore' })),
      };
    }
    return { method: 'backups', changes: this.agentChangesSince(id) };
  }

  async rewind(id: string): Promise<RewindResult> {
    const cp = this.get(id);
    if (!cp) throw new Error('Unknown checkpoint.');
    const { changes, method } = await this.plan(id);
    const restored: string[] = [];
    const deleted: string[] = [];
    if (method === 'git' && cp.sha && this.shadow) {
      const rel = changes.filter((c) => c.action === 'restore').map((c) => path.relative(this.shadow!.workTree, c.absolute));
      await this.shadow.restoreFiles(cp.sha, rel);
      restored.push(...changes.filter((c) => c.action === 'restore').map((c) => c.absolute));
      for (const c of changes.filter((x) => x.action === 'delete')) {
        await unlink(c.absolute).catch(() => undefined);
        deleted.push(c.absolute);
      }
    } else {
      for (const c of changes) {
        if (await this.revertFile(id, c.absolute)) (c.action === 'delete' ? deleted : restored).push(c.absolute);
      }
    }
    this.checkpoints.splice(this.checkpoints.findIndex((c) => c.id === id));
    return { restored, deleted, method };
  }

  async revertFile(id: string, absolute: string): Promise<boolean> {
    const start = this.checkpoints.findIndex((c) => c.id === id);
    if (start === -1) return false;
    let backup: string | null | undefined;
    for (const cp of this.checkpoints.slice(start)) {
      if (cp.originals.has(absolute)) {
        backup = cp.originals.get(absolute);
        break;
      }
    }
    if (backup === undefined) return false;
    if (backup === null) {
      await rm(absolute, { force: true });
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, await readFile(backup));
    }
    return true;
  }

  serialize(): SerializedCheckpoint[] {
    return this.checkpoints.map((c) => ({ id: c.id, label: c.label, ts: c.ts, ...(c.sha ? { sha: c.sha } : {}), originals: [...c.originals] }));
  }

  restore(saved: SerializedCheckpoint[]): void {
    this.checkpoints.splice(0, this.checkpoints.length, ...saved.map((c) => ({ id: c.id, label: c.label, ts: c.ts, ...(c.sha ? { sha: c.sha } : {}), originals: new Map(c.originals) })));
  }

  async purge(): Promise<void> {
    await rm(this.backupDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
