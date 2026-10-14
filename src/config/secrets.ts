import * as vscode from 'vscode';

const KEY = 'owuiAgent.apiKey';

export class ApiKeyStore {
  private cached: string | undefined;
  private loaded = false;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChange = this.emitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.subscription = secrets.onDidChange((e) => {
      if (e.key === KEY) {
        this.loaded = false;
        this.emitter.fire();
      }
    });
  }

  async get(): Promise<string | undefined> {
    if (!this.loaded) {
      this.cached = await this.secrets.get(KEY);
      this.loaded = true;
    }
    return this.cached;
  }

  async set(value: string): Promise<void> {
    await this.secrets.store(KEY, value.trim());
    this.cached = value.trim();
    this.loaded = true;
    this.emitter.fire();
  }

  async clear(): Promise<void> {
    await this.secrets.delete(KEY);
    this.cached = undefined;
    this.loaded = true;
    this.emitter.fire();
  }

  async promptAndStore(): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: 'Open WebUI API Key',
      prompt: 'Create one in Open WebUI under Settings > Account > API keys. It is stored in your OS keychain via VS Code SecretStorage.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-…',
      validateInput: (v) => (v.trim() ? undefined : 'The key cannot be empty.'),
    });
    if (value === undefined) return false;
    await this.set(value);
    return true;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
