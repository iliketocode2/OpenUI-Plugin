import * as vscode from 'vscode';
import { ChatController } from './agent/controller';
import { ApiKeyStore } from './config/secrets';
import { onSettingsChanged, readSettings } from './config/settings';
import { Egress } from './net/egress';
import { OwuiClient } from './owui/client';
import { SOVEREIGNTY_NOTICE } from './shared/notice';
import { ChatViewProvider } from './ui/chatViewProvider';

export interface TestApi {
  controller: ChatController;
  keys: ApiKeyStore;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const keys = new ApiKeyStore(context.secrets);
  const egress = new Egress(() => readSettings().baseUrl);
  const client = new OwuiClient(egress, () => keys.get(), {
    stallTimeoutMs: () => readSettings().stallTimeoutSeconds * 1000,
    maxRetries: () => readSettings().maxRetries,
  });
  const controller = new ChatController(client, keys, context.globalState);

  const setApiKey = async () => {
    await keys.promptAndStore();
  };
  const openSettings = async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
  };
  const provider = new ChatViewProvider(context.extensionUri, controller, { setApiKey, openSettings });

  context.subscriptions.push(
    keys,
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider),
    vscode.commands.registerCommand('owuiAgent.setApiKey', setApiKey),
    vscode.commands.registerCommand('owuiAgent.clearApiKey', () => keys.clear()),
    vscode.commands.registerCommand('owuiAgent.newSession', () => controller.newSession()),
    vscode.commands.registerCommand('owuiAgent.refreshModels', () => controller.refresh()),
    vscode.commands.registerCommand('owuiAgent.stop', () => controller.stop()),
    vscode.commands.registerCommand('owuiAgent.showSovereigntyNotice', async () => {
      await controller.resetNotice();
      await vscode.window.showInformationMessage('Data sovereignty', { modal: true, detail: SOVEREIGNTY_NOTICE.join('\n\n') });
    }),
    keys.onDidChange(() => void controller.refresh()),
    onSettingsChanged(() => void controller.refresh()),
  );

  return context.extensionMode === vscode.ExtensionMode.Test ? { controller, keys } : undefined;
}

export function deactivate(): void {}
