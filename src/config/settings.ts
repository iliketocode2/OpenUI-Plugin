import * as vscode from 'vscode';
import type { ModelOverride } from '../owui/models';

export const SECTION = 'owuiAgent';

export interface Settings {
  baseUrl: string;
  defaultModel: string;
  models: Record<string, ModelOverride>;
  stallTimeoutSeconds: number;
  firstResponseTimeoutSeconds: number;
  maxRetries: number;
  windowsShell: string;
  posixShell: string;
  commandTimeoutSeconds: number;
  commandAllowlist: string[];
  maxIterations: number;
  scratchpadRetentionDays: number;
  checkpointsEnabled: boolean;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    baseUrl: c.get<string>('baseUrl', 'http://localhost:3000'),
    defaultModel: c.get<string>('defaultModel', ''),
    models: c.get<Record<string, ModelOverride>>('models', {}),
    stallTimeoutSeconds: c.get<number>('request.stallTimeoutSeconds', 300),
    firstResponseTimeoutSeconds: c.get<number>('request.firstResponseTimeoutSeconds', 1200),
    maxRetries: c.get<number>('request.maxRetries', 3),
    windowsShell: c.get<string>('shell.windows', 'auto'),
    posixShell: c.get<string>('shell.posix', 'auto'),
    commandTimeoutSeconds: c.get<number>('commands.timeoutSeconds', 120),
    commandAllowlist: c.get<string[]>('commands.allowlist', []),
    maxIterations: c.get<number>('agent.maxIterations', 50),
    scratchpadRetentionDays: c.get<number>('scratchpad.retentionDays', 7),
    checkpointsEnabled: c.get<boolean>('checkpoints.enabled', true),
  };
}

export async function updateModelOverride(id: string, patch: Partial<ModelOverride>): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const current = c.get<Record<string, ModelOverride>>('models', {});
  const next = { ...current, [id]: { ...current[id], ...patch } };
  await c.update('models', next, vscode.ConfigurationTarget.Global);
}

export async function addAllowlistEntry(entry: string): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const inspected = c.inspect<string[]>('commands.allowlist');
  const current = (target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue) ?? [];
  if (current.includes(entry)) return;
  await c.update('commands.allowlist', [...current, entry], target);
}

export function onSettingsChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) listener();
  });
}
