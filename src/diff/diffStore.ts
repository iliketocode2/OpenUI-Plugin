export interface DiffEntry {
  id: string;
  absolute: string;
  display: string;
  before: string;
  after: string;
}

const MAX_ENTRIES = 200;

export class DiffStore {
  private readonly entries = new Map<string, DiffEntry>();

  put(entry: DiffEntry): void {
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
  }

  get(id: string): DiffEntry | undefined {
    return this.entries.get(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
