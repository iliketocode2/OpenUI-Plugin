import template from '../../prompts/system.md';

export interface PromptContext {
  os: string;
  shell: string;
  shells: string;
  date: string;
  workspace: string;
  scratchpad: string;
  mode: string;
}

const HEADER = /^<!--\s*owui-agent system prompt v([\d.]+)\s*-->\s*\n/;

export const SYSTEM_PROMPT_VERSION = HEADER.exec(template)?.[1] ?? 'unknown';

export const MODE_TEXT: Record<string, string> = {
  ask: 'ask-before-acting (the user approves each file change and each command that is not allow-listed)',
  auto: 'auto-accept edits (file changes inside the workspace apply immediately; commands still need approval unless allow-listed)',
};

export function renderSystemPrompt(ctx: PromptContext, extraSections: string[] = []): string {
  const body = template.replace(HEADER, '');
  const filled = body
    .replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
      const value = (ctx as unknown as Record<string, string | undefined>)[key];
      return value ?? whole;
    })
    .trim();
  return [filled, ...extraSections.filter(Boolean)].join('\n\n');
}
