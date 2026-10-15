import * as vscode from 'vscode';

const KEY = 'owuiAgent.apiKey';
const OWN_WRITE_ECHO_MS = 3000;

export class ApiKeyStore {
  private cached: string | undefined;
  private loaded = false;
  private version = 0;
  private ownWriteUntil = 0;
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  readonly onDidChange = this.emitter.event;

  constructor(private readonly secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete' | 'onDidChange'>) {
    this.subscription = secrets.onDidChange((e) => {
      if (e.key !== KEY || Date.now() < this.ownWriteUntil) return;
      this.version++;
      this.loaded = false;
      this.emitter.fire();
    });
  }

  async get(): Promise<string | undefined> {
    if (!this.loaded) {
      const version = this.version;
      const value = await this.secrets.get(KEY);
      if (version === this.version) {
        this.cached = value;
        this.loaded = true;
      }
      return version === this.version ? value : this.get();
    }
    return this.cached;
  }

  async set(value: string): Promise<void> {
    await this.write(value.trim());
  }

  async clear(): Promise<void> {
    await this.write(undefined);
  }

  private async write(value: string | undefined): Promise<void> {
    this.version++;
    this.cached = value;
    this.loaded = true;
    this.ownWriteUntil = Date.now() + OWN_WRITE_ECHO_MS;
    if (value === undefined) await this.secrets.delete(KEY);
    else await this.secrets.store(KEY, value);
    this.ownWriteUntil = Date.now() + OWN_WRITE_ECHO_MS;
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
