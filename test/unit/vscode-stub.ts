export const workspace = {
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback, update: async () => undefined }),
  onDidChangeConfiguration: () => ({ dispose() {} }),
  workspaceFolders: undefined,
};

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of this.listeners) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
