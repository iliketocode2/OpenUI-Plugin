import { readFile, stat } from 'node:fs/promises';
import type { AskUserQuestion, TodoItem } from '../shared/protocol';
import { fail, ok, type Tool } from './types';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const viewImageTool: Tool<{ path: string }> = {
  name: 'view_image',
  category: 'read',
  description: 'Look at a local image (png, jpg, gif, webp), for example a screenshot you took. The image is attached to your next turn.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  title: (a) => `View ${a.path}`,
  async prepare(args, ctx) {
    const target = ctx.paths.resolve(args.path);
    return {
      access: { kind: 'read', paths: [target] },
      card: { title: `View ${target.display}` },
      async execute() {
        if (!ctx.modelVision) {
          return fail('The selected model is not marked as vision-capable, so it cannot see images. Describe what you need checked instead, or ask the user to pick a vision model.');
        }
        const ext = /\.[^.\\/]+$/.exec(target.absolute)?.[0]?.toLowerCase() ?? '';
        const mime = MIME[ext];
        if (!mime) return fail(`Unsupported image type "${ext}". Supported: ${Object.keys(MIME).join(', ')}.`);
        let size: number;
        try {
          size = (await stat(target.absolute)).size;
        } catch {
          return fail(`Image not found: ${target.display}`);
        }
        if (size > MAX_IMAGE_BYTES) return fail(`${target.display} is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB. Take a smaller screenshot or resize it.`);
        const base64 = (await readFile(target.absolute)).toString('base64');
        ctx.update({ image: `data:${mime};base64,${base64}` });
        return ok(`Loaded ${target.display} (${Math.round(size / 1024)} KB). It is attached to the next message.`, {
          images: [{ path: target.display, mime, base64 }],
        });
      },
    };
  },
};

export const todoWriteTool: Tool<{ todos: TodoItem[] }> = {
  name: 'todo_write',
  category: 'interactive',
  description:
    'Replace the task list shown to the user. Use it for any task with three or more steps: add all steps up front, keep exactly one in_progress, and mark each completed as soon as it is done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  title: () => 'Update task list',
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        ctx.setTodos(args.todos);
        const done = args.todos.filter((t) => t.status === 'completed').length;
        ctx.update({ title: `Task list — ${done}/${args.todos.length} done` });
        return ok(`Task list updated (${done}/${args.todos.length} completed).`);
      },
    };
  },
};

export const askUserTool: Tool<{ questions: AskUserQuestion[] }> = {
  name: 'ask_user',
  category: 'interactive',
  description:
    'Ask the user one to four questions and wait for the answers. Give 2-4 short options when there are clear choices (the user can always type their own answer). Use it when a decision changes what you build; do not ask about things you can find out yourself.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string', description: 'Very short label, max 12 characters.' },
            options: { type: 'array', maxItems: 4, items: { type: 'string' } },
            multiSelect: { type: 'boolean' },
          },
          required: ['question'],
        },
      },
    },
    required: ['questions'],
  },
  title: (a) => (a.questions.length === 1 ? 'Question for you' : `${a.questions.length} questions for you`),
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const answers = await ctx.ask(args.questions);
        const text = args.questions.map((q, i) => `Q: ${q.question}\nA: ${(answers[i] ?? []).join(', ') || '(no answer)'}`).join('\n\n');
        return ok(text);
      },
    };
  },
};

export const exitPlanModeTool: Tool<{ plan: string }> = {
  name: 'exit_plan_mode',
  category: 'interactive',
  description:
    'Plan mode only. Present your finished plan (Markdown) for the user to approve. Include the goal, the approach, the files you will create or change, how you will verify the work, and open risks. If approved you can start implementing; otherwise revise using the feedback.',
  parameters: { type: 'object', properties: { plan: { type: 'string', description: 'The complete plan in Markdown.' } }, required: ['plan'] },
  title: () => 'Plan for approval',
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const decision = await ctx.presentPlan(args.plan);
        if (decision.approved) {
          const how =
            decision.mode === 'ask'
              ? 'The user will approve each file change and command.'
              : decision.mode === 'review'
                ? 'File changes apply immediately and the user reviews them at the end; commands still need approval.'
                : 'File changes apply immediately; commands still need approval unless allow-listed.';
          return ok(`The user approved the plan. ${how} Implement it now, keeping the task list up to date.`);
        }
        return ok(`The user wants changes to the plan: ${decision.feedback}\nYou are still in plan mode. Revise the plan, then call exit_plan_mode again.`);
      },
    };
  },
};
