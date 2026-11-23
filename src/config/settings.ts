import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ModelOverride } from '../owui/models';

const SECTION = 'owuiAgent';

export interface Settings {
  baseUrl: string;
  models: Record<string, ModelOverride>;
  stallTimeoutSeconds: number;
  firstResponseTimeoutSeconds: number;
  windowsShell: string;
  posixShell: string;
  commandTimeoutSeconds: number;
  commandAllowlist: string[];
  maxIterations: number;
  userSkillsDir: string;
  webEnabled: boolean;
  webAutoApproveSearches: boolean;
  browserEnabled: boolean;
  browserChannel: 'auto' | 'chrome' | 'msedge';
  browserExtraHosts: string[];
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    baseUrl: c.get<string>('baseUrl', 'http://localhost:3000'),
    models: c.get<Record<string, ModelOverride>>('models', {}),
    stallTimeoutSeconds: c.get<number>('request.stallTimeoutSeconds', 300),
    firstResponseTimeoutSeconds: c.get<number>('request.firstResponseTimeoutSeconds', 1200),
    windowsShell: c.get<string>('shell.windows', 'auto'),
    posixShell: c.get<string>('shell.posix', 'auto'),
    commandTimeoutSeconds: c.get<number>('commands.timeoutSeconds', 120),
    commandAllowlist: c.get<string[]>('commands.allowlist', []),
    maxIterations: c.get<number>('agent.maxIterations', 50),
    webEnabled: c.get<boolean>('web.enabled', false),
    webAutoApproveSearches: c.get<boolean>('web.autoApproveSearches', false),
    browserEnabled: c.get<boolean>('browser.enabled', false),
    browserChannel: c.get<'auto' | 'chrome' | 'msedge'>('browser.channel', 'auto'),
    browserExtraHosts: c.get<string[]>('browser.extraHosts', []),
    userSkillsDir: expandHome(c.get<string>('skills.userDir', '') || path.join(os.homedir(), '.owui-agent', 'skills')),
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
  // The allowlist is application-scoped, so only the user's own settings can hold it.
  const current = c.inspect<string[]>('commands.allowlist')?.globalValue ?? [];
  if (current.includes(entry)) return;
  await c.update('commands.allowlist', [...current, entry], vscode.ConfigurationTarget.Global);
}

/** Settings whose change needs a new connection to Open WebUI. The others only change what the view shows. */
const RECONNECT_SETTINGS = ['baseUrl', 'web.enabled'];

export function onSettingsChanged(listener: (reconnect: boolean) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) listener(RECONNECT_SETTINGS.some((k) => e.affectsConfiguration(`${SECTION}.${k}`)));
  });
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}
