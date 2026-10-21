import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SerializedCheckpoint } from '../storage/history';

/**
 * Rewind undoes the agent's own file edits (write_file, edit_file, update_memory) by restoring the content each file
 * had before the agent first touched it after a checkpoint. Changes made by shell commands are not tracked.
 */
export interface Checkpoint {
  id: string;
  label: string;
  ts: number;
  /** Per file: the backup path, null if the file did not exist, or UNBACKED if it could not be backed up. */
  originals: Map<string, string | null>;
  /** Per file: a hash of the content the agent last wrote, to notice edits made after the agent's. */
  written: Map<string, string | null>;
}

/** Marks a file that existed but was too large or not a regular file, so it must never be deleted or overwritten. */
export const UNBACKED = '\0unbacked';

export interface PlannedChange {
  absolute: string;
  action: 'restore' | 'delete' | 'skip';
  /** The file changed after the agent's last write, so rewinding loses those later edits. */
  changedSince?: boolean;
}

export interface RewindResult {
  restored: string[];
  deleted: string[];
  skipped: string[];
  failed: string[];
}

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export class CheckpointManager {
  private readonly checkpoints: Checkpoint[] = [];

  constructor(private readonly backupDir: string) {}

  list(): readonly Checkpoint[] {
    return this.checkpoints;
  }

  get(id: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === id);
  }

  current(): Checkpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  begin(label: string): Checkpoint {
    const cp: Checkpoint = { id: randomUUID(), label, ts: Date.now(), originals: new Map(), written: new Map() };
    this.checkpoints.push(cp);
    return cp;
  }

  async recordBeforeWrite(absolute: string): Promise<void> {
    const cp = this.current();
    if (!cp || cp.originals.has(absolute)) return;
    try {
      const st = await stat(absolute);
      if (!st.isFile() || st.size > MAX_BACKUP_BYTES) {
        cp.originals.set(absolute, UNBACKED);
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

  async recordAfterWrite(absolute: string): Promise<void> {
    const cp = this.current();
    if (cp) cp.written.set(absolute, await contentHash(absolute));
  }

  agentChangesSince(id: string): PlannedChange[] {
    const start = this.checkpoints.findIndex((c) => c.id === id);
    if (start === -1) return [];
    const first = new Map<string, string | null>();
    for (const cp of this.checkpoints.slice(start)) {
      for (const [abs, backup] of cp.originals) if (!first.has(abs)) first.set(abs, backup);
    }
    return [...first].map(([absolute, backup]) => ({ absolute, action: backup === UNBACKED ? 'skip' : backup === null ? 'delete' : 'restore' }));
  }

  /** What a rewind to `id` would do, including which files were edited after the agent's last write. */
  async plan(id: string): Promise<PlannedChange[]> {
    if (!this.get(id)) throw new Error('Unknown checkpoint.');
    const changes = this.agentChangesSince(id);
    for (const c of changes) {
      const expected = this.lastWritten(c.absolute);
      if (expected !== undefined && (await contentHash(c.absolute)) !== expected) c.changedSince = true;
    }
    return changes;
  }

  async rewind(id: string): Promise<RewindResult> {
    const changes = await this.plan(id);
    const result: RewindResult = { restored: [], deleted: [], skipped: [], failed: [] };
    for (const c of changes) {
      if (c.action === 'skip') {
        result.skipped.push(c.absolute);
        continue;
      }
      try {
        if (await this.revertFile(id, c.absolute)) (c.action === 'delete' ? result.deleted : result.restored).push(c.absolute);
      } catch {
        result.failed.push(c.absolute);
      }
    }
    this.checkpoints.splice(this.checkpoints.findIndex((c) => c.id === id));
    return result;
  }

  /** Restores one file to its state at checkpoint `id`. Returns false when there is nothing to restore it from. */
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
    if (backup === undefined || backup === UNBACKED) return false;
    if (backup === null) {
      await rm(absolute, { force: true });
    } else {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, await readFile(backup));
    }
    return true;
  }

  serialize(): SerializedCheckpoint[] {
    return this.checkpoints.map((c) => ({ id: c.id, label: c.label, ts: c.ts, originals: [...c.originals], written: [...c.written] }));
  }

  restore(saved: SerializedCheckpoint[]): void {
    this.checkpoints.splice(
      0,
      this.checkpoints.length,
      ...saved.map((c) => ({ id: c.id, label: c.label, ts: c.ts, originals: new Map(c.originals), written: new Map(c.written ?? []) })),
    );
  }

  private lastWritten(absolute: string): string | null | undefined {
    for (let i = this.checkpoints.length - 1; i >= 0; i--) {
      const hash = this.checkpoints[i]!.written.get(absolute);
      if (hash !== undefined) return hash;
    }
    return undefined;
  }
}

async function contentHash(absolute: string): Promise<string | null> {
  try {
    return createHash('sha1').update(await readFile(absolute)).digest('hex');
  } catch {
    return null;
  }
}
