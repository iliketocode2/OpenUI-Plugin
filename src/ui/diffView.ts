import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DiffStore } from '../diff/diffStore';

export const DIFF_SCHEME = 'owui-diff';

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly store: () => DiffStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const [id, side] = uri.query.split('&side=');
    const entry = this.store().get(decodeURIComponent(id ?? ''));
    if (!entry) return '';
    return side === 'before' ? entry.before : entry.after;
  }
}

export async function openDiff(store: DiffStore, id: string): Promise<void> {
  const entry = store.get(id);
  if (!entry) {
    void vscode.window.showWarningMessage('This diff is no longer available.');
    return;
  }
  const name = path.basename(entry.absolute);
  const make = (side: 'before' | 'after') => vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${side}/${name}`, query: `${encodeURIComponent(id)}&side=${side}` });
  await vscode.commands.executeCommand('vscode.diff', make('before'), make('after'), `${entry.display} (agent change)`, { preview: true });
}
