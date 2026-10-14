import * as vscode from 'vscode';
import type { ModelOverride } from '../owui/models';

export const SECTION = 'owuiAgent';

export interface Settings {
  baseUrl: string;
  defaultModel: string;
  models: Record<string, ModelOverride>;
  stallTimeoutSeconds: number;
  maxRetries: number;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    baseUrl: c.get<string>('baseUrl', 'http://localhost:3000'),
    defaultModel: c.get<string>('defaultModel', ''),
    models: c.get<Record<string, ModelOverride>>('models', {}),
    stallTimeoutSeconds: c.get<number>('request.stallTimeoutSeconds', 300),
    maxRetries: c.get<number>('request.maxRetries', 3),
  };
}

export async function updateModelOverride(id: string, patch: Partial<ModelOverride>): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const current = c.get<Record<string, ModelOverride>>('models', {});
  const next = { ...current, [id]: { ...current[id], ...patch } };
  await c.update('models', next, vscode.ConfigurationTarget.Global);
}

export function onSettingsChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) listener();
  });
}
