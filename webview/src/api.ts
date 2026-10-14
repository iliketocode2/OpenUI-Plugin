import type { FromWebview } from '../../src/shared/protocol';

interface VsCodeApi {
  postMessage(msg: FromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

export function post(msg: FromWebview): void {
  vscode.postMessage(msg);
}

export function returnFocusToComposer(): void {
  requestAnimationFrame(() => document.getElementById('prompt')?.focus());
}
