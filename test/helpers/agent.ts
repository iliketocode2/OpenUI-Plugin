import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AgentSession, type RunContext } from '../../src/agent/session';
import { MODE_TEXT, renderSystemPrompt } from '../../src/agent/systemPrompt';
import { Egress } from '../../src/net/egress';
import { OwuiClient } from '../../src/owui/client';
import { resolveModel, type ModelOverride } from '../../src/owui/models';
import { TokenCalibrator } from '../../src/owui/tokens';
import type { AgentMode, ApprovalDecision, AskUserQuestion, TranscriptItem } from '../../src/shared/protocol';
import { ToolRegistry } from '../../src/tools/registry';
import { ProcessManager } from '../../src/tools/shell/processManager';
import { ShellRegistry } from '../../src/tools/shell/shells';
import { PathGuard } from '../../src/workspace/paths';

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

export interface HarnessOptions {
  baseUrl: string;
  apiKey: string;
  mode?: AgentMode;
  override?: ModelOverride;
  vision?: boolean;
  maxIterations?: number;
  allowlist?: string[];
  approve?: (item: ToolItem) => ApprovalDecision | undefined;
  answer?: (questions: AskUserQuestion[]) => string[][] | undefined;
  ripgrep?: string;
  modelId?: string;
  stallMs?: number;
  firstResponseMs?: number;
  maxRetries?: number;
}

export interface Harness {
  session: AgentSession;
  ctx: RunContext;
  workspace: string;
  scratchpad: string;
  approvalsSeen: ToolItem[];
  warnings: string[];
  textModeSwitches: number;
  allowlist: string[];
  cleanup(): Promise<void>;
}

export async function createHarness(opts: HarnessOptions): Promise<Harness> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'owui agent ws '));
  const scratchpad = await mkdtemp(path.join(tmpdir(), 'owui agent scratch '));
  const shells = new ShellRegistry();
  const client = new OwuiClient(new Egress(() => opts.baseUrl), async () => opts.apiKey, {
    stallTimeoutMs: () => opts.stallMs ?? 10_000,
    firstResponseTimeoutMs: () => opts.firstResponseMs ?? opts.stallMs ?? 10_000,
    maxRetries: () => opts.maxRetries ?? 1,
    backoffBaseMs: 5,
    backoffMaxMs: 10,
  });
  const allowlist = [...(opts.allowlist ?? [])];
  const approvalsSeen: ToolItem[] = [];
  const handled = new Set<string>();
  const warnings: string[] = [];
  let mode: AgentMode = opts.mode ?? 'ask';
  const harness = {} as Harness;
  const session: AgentSession = new AgentSession(
    { client, tools: new ToolRegistry(), shells, paths: new PathGuard(() => [workspace], scratchpad), processes: new ProcessManager(), scratchpad, ripgrep: opts.ripgrep },
    {
      changed: () => {
        for (const item of session.transcript) {
          if (handled.has(item.id)) continue;
          if (item.kind === 'tool' && item.status === 'awaiting-approval') {
            handled.add(item.id);
            approvalsSeen.push(structuredClone(item));
            const decision = opts.approve ? opts.approve(item) : { decision: 'allow' as const };
            if (decision) queueMicrotask(() => session.resolveApproval(item.id, decision));
          } else if (item.kind === 'question' && item.status === 'open') {
            handled.add(item.id);
            const answers = opts.answer?.(item.questions);
            if (answers) queueMicrotask(() => session.resolveQuestion(item.id, answers));
          }
        }
      },
      delta: () => undefined,
      toolUpdate: () => undefined,
      usage: () => undefined,
    },
  );
  const model = resolveModel({ id: opts.modelId ?? 'mock-model', name: opts.modelId ?? 'Mock Model', contextSize: 32768, vision: opts.vision ?? false }, opts.override);
  const ctx: RunContext = {
    model,
    toolMode: model.toolMode === 'text' ? 'text' : 'native',
    systemPrompt: (m) =>
      renderSystemPrompt({ os: 'test', shell: 'default', shells: shells.available().map((s) => s.id).join(', '), date: '2026-10-14', workspace, scratchpad, mode: MODE_TEXT[m] ?? m }),
    calibrator: new TokenCalibrator(),
    mode: () => mode,
    allowlist: () => allowlist,
    toolSettings: { commandTimeoutSeconds: 30, maxOutputChars: 8000, defaultShell: undefined },
    maxIterations: opts.maxIterations ?? 20,
    warnOnce: (_k, text) => warnings.push(text),
    onToolsUnsupported: () => {
      harness.textModeSwitches++;
    },
    addAllowlistEntry: async (e) => {
      allowlist.push(e);
    },
  };
  Object.assign(harness, {
    session,
    ctx,
    workspace,
    scratchpad,
    approvalsSeen,
    warnings,
    textModeSwitches: 0,
    allowlist,
    setMode: (m: AgentMode) => (mode = m),
    async cleanup() {
      await session.dispose();
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      await rm(scratchpad, { recursive: true, force: true }).catch(() => undefined);
    },
  });
  return harness;
}

export function tools(session: AgentSession): ToolItem[] {
  return session.transcript.filter((t): t is ToolItem => t.kind === 'tool');
}
