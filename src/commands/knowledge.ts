import { existsSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { INDEX_HEADER, MEMORY_DIR, MEMORY_INDEX, OWUI_DIR } from '../memory/projectMemory';

export async function openProjectMemory(onCreated: (dir: string) => void): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showWarningMessage('Open a folder to use project memory.');
    return;
  }
  const file = path.join(root, MEMORY_DIR, MEMORY_INDEX);
  if (!existsSync(file)) {
    const owuiExisted = existsSync(path.join(root, OWUI_DIR));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, INDEX_HEADER, 'utf8');
    if (!owuiExisted) onCreated(path.join(root, OWUI_DIR));
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

export async function installExampleSkill(extensionPath: string, userSkillsDir: string): Promise<void> {
  const source = path.join(extensionPath, 'examples', 'skills', 'dataviz');
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'For me (all workspaces)', description: userSkillsDir, target: path.join(userSkillsDir, 'dataviz') },
      ...(vscode.workspace.workspaceFolders?.[0]
        ? [{ label: 'For this workspace', description: path.join(OWUI_DIR, 'skills'), target: path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, OWUI_DIR, 'skills', 'dataviz') }]
        : []),
    ],
    { title: 'Install the example "dataviz" skill' },
  );
  if (!choice) return;
  if (existsSync(choice.target)) {
    const overwrite = await vscode.window.showWarningMessage(`${choice.target} already exists. Replace it?`, { modal: true }, 'Replace');
    if (overwrite !== 'Replace') return;
  }
  await mkdir(path.dirname(choice.target), { recursive: true });
  await cp(source, choice.target, { recursive: true, force: true });
  const open = await vscode.window.showInformationMessage(`Installed the dataviz skill to ${choice.target}. The agent sees it from the next message.`, 'Open SKILL.md');
  if (open) await vscode.window.showTextDocument(vscode.Uri.file(path.join(choice.target, 'SKILL.md')));
}
