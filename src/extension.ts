import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentController } from './agent/controller';
import { installExampleSkill, openProjectMemory } from './commands/knowledge';
import { ApiKeyStore } from './config/secrets';
import { onSettingsChanged, readSettings } from './config/settings';
import { PersistentState } from './config/state';
import { Egress } from './net/egress';
import { OwuiClient } from './owui/client';
import { OwuiWeb } from './owui/web';
import { SOVEREIGNTY_NOTICE } from './shared/notice';
import { HistoryStore } from './storage/history';
import { pruneScratchpads } from './storage/scratchpad';
import { ToolRegistry } from './tools/registry';
import { ShellRegistry } from './tools/shell/shells';
import { ChatViewProvider } from './ui/chatViewProvider';
import { DIFF_SCHEME, DiffContentProvider } from './ui/diffView';
import { PathGuard } from './workspace/paths';
import { locateRipgrep } from './workspace/ripgrep';

export interface TestApi {
  controller: AgentController;
  keys: ApiKeyStore;
  provider: ChatViewProvider;
  setConfirm(fn: (message: string, detail: string, action: string) => Promise<boolean>): void;
}

let shutdown: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const globalStorage = context.globalStorageUri.fsPath;
  const workspaceData = context.storageUri?.fsPath ?? path.join(globalStorage, 'no-workspace');
  const globalState = new PersistentState(context.globalState);
  const workspaceState = new PersistentState(context.workspaceState);
  const keys = new ApiKeyStore(context.secrets);
  const egress = new Egress(() => readSettings().baseUrl);
  const client = new OwuiClient(egress, () => keys.get(), {
    stallTimeoutMs: () => readSettings().stallTimeoutSeconds * 1000,
    firstResponseTimeoutMs: () => readSettings().firstResponseTimeoutSeconds * 1000,
    maxRetries: () => readSettings().maxRetries,
  });
  let confirmImpl = async (message: string, detail: string, action: string) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action;
  const workspaceRoots = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const controller = new AgentController({
    client,
    keys,
    globalState,
    globalStorage,
    tools: new ToolRegistry(),
    shells: new ShellRegistry(),
    paths: (scratchpad) => new PathGuard(workspaceRoots, scratchpad),
    ripgrep: locateRipgrep(vscode.env.appRoot),
    workspaceStorage: context.storageUri?.fsPath,
    checkpointsEnabled: () => readSettings().checkpointsEnabled,
    confirm: (message, detail, action) => confirmImpl(message, detail, action),
    history: new HistoryStore(path.join(workspaceData, 'sessions')),
    backupsRoot: path.join(workspaceData, 'backups'),
    web: new OwuiWeb(egress, () => keys.get()),
    workspaceState,
    userSkillsDir: () => readSettings().userSkillsDir,
  });

  const setApiKey = async () => {
    await keys.promptAndStore();
  };
  const openSettings = async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
  };
  const provider = new ChatViewProvider(context.extensionUri, controller, { setApiKey, openSettings });

  context.subscriptions.push(
    keys,
    controller,
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, new DiffContentProvider(() => controller.diffs)),
    vscode.commands.registerCommand('owuiAgent.setApiKey', setApiKey),
    vscode.commands.registerCommand('owuiAgent.clearApiKey', () => keys.clear()),
    vscode.commands.registerCommand('owuiAgent.newSession', () => controller.newSession()),
    vscode.commands.registerCommand('owuiAgent.refreshModels', () => controller.refresh()),
    vscode.commands.registerCommand('owuiAgent.stop', () => controller.stop()),
    vscode.commands.registerCommand('owuiAgent.showSovereigntyNotice', async () => {
      await controller.resetNotice();
      await vscode.window.showInformationMessage('Data sovereignty', { modal: true, detail: SOVEREIGNTY_NOTICE.join('\n\n') });
    }),
    vscode.commands.registerCommand('owuiAgent.addSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const sel = editor.selection;
      const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
      const text = editor.document.getText(sel.isEmpty ? undefined : sel);
      const range = sel.isEmpty ? '' : `:${sel.start.line + 1}-${sel.end.line + 1}`;
      const fence = text.includes('```') ? '````' : '```';
      return provider.insertText(`${rel}${range}\n${fence}${editor.document.languageId}\n${text}\n${fence}\n`);
    }),
    vscode.commands.registerCommand('owuiAgent.showHistory', () => provider.showHistory()),
    vscode.commands.registerCommand('owuiAgent.compact', () => controller.compact()),
    vscode.commands.registerCommand('owuiAgent.openMemory', () => openProjectMemory((dir) => controller.workspaceDirCreated(dir))),
    vscode.commands.registerCommand('owuiAgent.installExampleSkill', () => installExampleSkill(context.extensionPath, readSettings().userSkillsDir)),
    vscode.commands.registerCommand('owuiAgent.addFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
      if (!targets.length) return;
      return provider.insertText(`${targets.map((u) => `@${vscode.workspace.asRelativePath(u, false).split(path.sep).join('/')}`).join(' ')} `);
    }),
    keys.onDidChange(() => void controller.refresh()),
    onSettingsChanged(() => void controller.refresh()),
  );

  shutdown = async () => {
    await controller.flush();
    await Promise.all([globalState.flush(), workspaceState.flush()]);
  };
  void controller.pruneOrphanBackups();
  void pruneScratchpads(globalStorage, readSettings().scratchpadRetentionDays, [controller.currentSession.scratchpad]);
  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        controller,
        keys,
        provider,
        setConfirm: (fn) => {
          confirmImpl = fn;
        },
      }
    : undefined;
}

export function deactivate(): Promise<void> | undefined {
  return shutdown?.();
}
