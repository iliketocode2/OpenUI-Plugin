import template from '../../prompts/system.md';

export interface PromptContext {
  os: string;
  shell: string;
  shells: string;
  date: string;
  workspace: string;
  scratchpad: string;
}

const HEADER = /^<!--\s*owui-agent system prompt v([\d.]+)\s*-->\s*\n/;

export const SYSTEM_PROMPT_VERSION = HEADER.exec(template)?.[1] ?? 'unknown';

/** Sent as a note at the start of a user message whenever the mode differs from the last one the model was told about. */
export const MODE_TEXT: Record<string, string> = {
  plan:
    'plan (read-only). You can read, search and ask questions, but not edit files or run commands. Investigate, then reply with a numbered Markdown plan (goal, files to change, how you will verify it, risks) and stop. The user switches mode when they want you to implement it.',
  ask: 'ask before acting. The user approves each file change and each command that is not allow-listed.',
  auto: 'auto-accept edits. File changes inside the workspace apply immediately; commands still need approval unless allow-listed.',
  review: 'auto-accept edits with review at the end. File changes apply immediately and the user reviews every changed file when you finish; commands still need approval unless allow-listed.',
};

export function modeNote(mode: string): string {
  return `[Permission mode: ${MODE_TEXT[mode] ?? mode}]`;
}

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
