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
  plan:
    'PLAN MODE. You can only read and search, ask questions and update the task list; you cannot edit files or run commands. Investigate the codebase and environment, ask clarifying questions with ask_user when a decision changes the design, then call exit_plan_mode with a complete Markdown plan (goal, approach, files to create or change, verification steps, risks). Do not start implementing until the plan is approved.',
  ask: 'ask-before-acting (the user approves each file change and each command that is not allow-listed)',
  auto: 'auto-accept edits (file changes inside the workspace apply immediately; commands still need approval unless allow-listed)',
  review:
    'auto-accept edits with review at the end (file changes apply immediately and the user reviews every changed file when you finish; commands still need approval unless allow-listed)',
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
