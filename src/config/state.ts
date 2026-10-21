import type * as vscode from 'vscode';
import { describeError, log } from '../log';

export class PersistentState implements vscode.Memento {
  private readonly cache = new Map<string, unknown>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {}

  keys(): readonly string[] {
    return [...new Set([...this.memento.keys(), ...this.cache.keys()])];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.cache.has(key)) this.cache.set(key, this.memento.get<T>(key));
    const value = this.cache.get(key) as T | undefined;
    return value === undefined ? defaultValue : value;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.cache.set(key, value);
    this.queue = this.queue.then(() => this.memento.update(key, value)).catch((e: unknown) => log.error(`Could not save extension state (${key}): ${describeError(e)}`));
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
