import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';

export function scratchRoot(globalStorage: string): string {
  return path.join(globalStorage, 'scratch');
}

export async function createScratchpad(globalStorage: string, sessionId: string): Promise<string> {
  const dir = path.join(scratchRoot(globalStorage), `${new Date().toISOString().slice(0, 10)}-${sessionId.slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function pruneScratchpads(globalStorage: string, retentionDays: number, keep: string[] = []): Promise<number> {
  const root = scratchRoot(globalStorage);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of entries) {
    const dir = path.join(root, name);
    if (keep.includes(dir)) continue;
    try {
      const st = await stat(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      continue;
    }
  }
  return removed;
}
