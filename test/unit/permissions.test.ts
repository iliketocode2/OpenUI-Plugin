import { describe, expect, it } from 'vitest';
import { decide } from '../../src/agent/permissions';
import type { ResolvedPath } from '../../src/workspace/paths';

const p = (zone: ResolvedPath['zone'], display = 'src/a.ts', sensitive = false): ResolvedPath => ({ absolute: `/x/${display}`, zone, display, sensitive });

describe('permission policy', () => {
  it('allows reads inside the workspace and scratchpad; asks for outside or sensitive files', () => {
    expect(decide({ mode: 'ask', allowlist: [], access: { kind: 'read', paths: [p('workspace')] } }).kind).toBe('allow');
    expect(decide({ mode: 'ask', allowlist: [], access: { kind: 'read', paths: [p('scratchpad')] } }).kind).toBe('allow');
    const outside = decide({ mode: 'auto', allowlist: [], access: { kind: 'read', paths: [p('outside', '/etc/hosts')] } });
    expect(outside.kind).toBe('ask');
    const env = decide({ mode: 'auto', allowlist: [], access: { kind: 'read', paths: [p('workspace', '.env', true)] } });
    expect(env.kind === 'ask' && env.request.warnings.join(' ')).toMatch(/secrets/);
  });

  it('asks for workspace edits in ask mode and allows them in auto mode', () => {
    expect(decide({ mode: 'ask', allowlist: [], access: { kind: 'write', paths: [p('workspace')] } }).kind).toBe('ask');
    expect(decide({ mode: 'auto', allowlist: [], access: { kind: 'write', paths: [p('workspace')] } }).kind).toBe('allow');
  });

  it('always asks before changing Git or VS Code configuration, even in auto mode', () => {
    for (const mode of ['auto', 'review'] as const) {
      const d = decide({ mode, allowlist: [], access: { kind: 'write', paths: [{ ...p('workspace', '.vscode/settings.json'), control: true }] } });
      expect(d.kind).toBe('ask');
      expect(d.kind === 'ask' && d.request.warnings.join(' ')).toMatch(/run programs/);
    }
    expect(decide({ mode: 'ask', allowlist: [], access: { kind: 'read', paths: [{ ...p('workspace', '.git/config'), control: true }] } }).kind).toBe('allow');
  });

  it('allows scratchpad writes in every mode', () => {
    expect(decide({ mode: 'ask', allowlist: [], access: { kind: 'write', paths: [p('scratchpad')] } }).kind).toBe('allow');
  });

  it('always asks for writes outside the workspace, even in auto mode', () => {
    const d = decide({ mode: 'auto', allowlist: [], access: { kind: 'write', paths: [p('outside', 'C:\\Windows\\x')] } });
    expect(d.kind).toBe('ask');
    expect(d.kind === 'ask' && d.request.warnings[0]).toMatch(/outside/);
  });

  it('asks for commands unless allow-listed, and offers "always allow" only for safe ones', () => {
    const cwd = p('workspace', '.');
    const ask = decide({ mode: 'auto', allowlist: [], access: { kind: 'command', command: 'npm test', cwd, background: false } });
    expect(ask.kind === 'ask' && ask.request.allowAlways).toBe('npm test');
    expect(decide({ mode: 'ask', allowlist: ['npm test'], access: { kind: 'command', command: 'npm test', cwd, background: false } }).kind).toBe('allow');
    const push = decide({ mode: 'auto', allowlist: ['git'], access: { kind: 'command', command: 'git push', cwd, background: false } });
    expect(push.kind).toBe('ask');
    expect(push.kind === 'ask' && push.request.allowAlways).toBeUndefined();
    const outsideCwd = decide({ mode: 'auto', allowlist: ['npm test'], access: { kind: 'command', command: 'npm test', cwd: p('outside', 'C:\\other'), background: false } });
    expect(outsideCwd.kind).toBe('ask');
  });
});
