import template from '../../prompts/system.md';

export interface PromptContext {
  os: string;
  date: string;
  workspace: string;
}

const HEADER = /^<!--\s*owui-agent system prompt v([\d.]+)\s*-->\s*\n/;

export const SYSTEM_PROMPT_VERSION = HEADER.exec(template)?.[1] ?? 'unknown';

export function renderSystemPrompt(ctx: PromptContext): string {
  const body = template.replace(HEADER, '');
  return body.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = (ctx as unknown as Record<string, string | undefined>)[key];
    return value ?? whole;
  }).trim();
}
