import type { AgentMode, ApprovalRequest } from '../shared/protocol';
import type { Access } from '../tools/types';
import { assessCommand, isAllowlisted, suggestAllowEntry } from './commandPolicy';

export type PolicyDecision = { kind: 'allow' } | { kind: 'ask'; request: ApprovalRequest };

export interface PolicyInput {
  mode: AgentMode;
  access: Access;
  allowlist: string[];
}

export function decide({ mode, access, allowlist }: PolicyInput): PolicyDecision {
  switch (access.kind) {
    case 'none':
      return { kind: 'allow' };
    case 'read': {
      const outside = access.paths.filter((p) => p.zone === 'outside');
      const sensitive = access.paths.filter((p) => p.sensitive);
      if (!outside.length && !sensitive.length) return { kind: 'allow' };
      const target = (outside[0] ?? sensitive[0])!;
      const warnings: string[] = [];
      if (outside.length) warnings.push('This path is outside the workspace and the scratchpad.');
      if (sensitive.length) warnings.push('This file may contain secrets.');
      warnings.push('Its contents will be sent to the model.');
      return { kind: 'ask', request: { kind: 'read', question: `Allow the agent to read ${target.display}?`, warnings } };
    }
    case 'write': {
      const outside = access.paths.filter((p) => p.zone === 'outside');
      const sensitive = access.paths.filter((p) => p.sensitive);
      const scratchOnly = access.paths.every((p) => p.zone === 'scratchpad');
      const target = access.paths[0]!;
      if (outside.length) {
        return {
          kind: 'ask',
          request: { kind: 'write', question: `Allow a change to ${target.display}?`, warnings: ['This file is outside the workspace and the scratchpad.'] },
        };
      }
      if (sensitive.length) {
        return { kind: 'ask', request: { kind: 'edit', question: `Apply this change to ${target.display}?`, warnings: ['This file may contain secrets or credentials.'] } };
      }
      if (scratchOnly || mode === 'auto') return { kind: 'allow' };
      return { kind: 'ask', request: { kind: 'edit', question: `Apply this change to ${target.display}?`, warnings: [] } };
    }
    case 'command': {
      const a = assessCommand(access.command);
      const warnings = [...a.warnings];
      if (access.cwd.zone === 'outside') warnings.push(`Runs in ${access.cwd.display}, outside the workspace.`);
      if (!warnings.length && access.cwd.zone !== 'outside' && isAllowlisted(access.command, allowlist)) return { kind: 'allow' };
      if (a.complex) warnings.push('Contains command substitution or unbalanced quotes; review it carefully.');
      const request: ApprovalRequest = {
        kind: 'command',
        question: access.background ? 'Start this background process?' : 'Run this command?',
        warnings,
      };
      const entry = warnings.length ? undefined : suggestAllowEntry(access.command);
      if (entry) request.allowAlways = entry;
      return { kind: 'ask', request };
    }
  }
}
