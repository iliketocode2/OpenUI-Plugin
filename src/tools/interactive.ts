import { readFile, stat } from 'node:fs/promises';
import type { AskUserQuestion, TodoItem } from '../shared/protocol';
import { fail, ok, type JsonSchema, type Tool } from './types';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const viewImageTool: Tool<{ path: string }> = {
  name: 'view_image',
  category: 'read',
  description: 'Look at a local png, jpg, gif or webp image, such as a screenshot. It is attached to your next turn.',
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

const TODO_STATUS: JsonSchema = { type: 'string', enum: ['pending', 'in_progress', 'completed'] };

interface TodoUpdate {
  item: number;
  status: TodoItem['status'];
}

export const todoWriteTool: Tool<{ todos?: TodoItem[]; update?: TodoUpdate[] }> = {
  name: 'todo_write',
  category: 'interactive',
  description:
    'The task list shown to the user, for tasks with three or more steps. Create it with `todos` (every step, one in_progress). ' +
    'After that, change statuses with `update` instead of resending the list, e.g. update: [{"item": 2, "status": "completed"}, {"item": 3, "status": "in_progress"}]. ' +
    'Send it in the same turn as your next tool call rather than on its own.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        maxItems: 50,
        description: 'The whole list: to create it, or when the steps themselves change.',
        items: {
          type: 'object',
          properties: { content: { type: 'string' }, status: TODO_STATUS },
          required: ['content', 'status'],
        },
      },
      update: {
        type: 'array',
        maxItems: 50,
        description: 'Status changes by item number, counting from 1.',
        items: {
          type: 'object',
          properties: { item: { type: 'integer', minimum: 1 }, status: TODO_STATUS },
          required: ['item', 'status'],
        },
      },
    },
  },
  title: () => 'Update task list',
  async prepare(args, ctx) {
    if (!args.todos === !args.update) {
      return fail('Pass either `todos` (the whole list) or `update` (status changes by item number), not both or neither.');
    }
    let todos: TodoItem[];
    if (args.todos) {
      todos = args.todos;
    } else {
      const current = ctx.todos();
      if (!current.length) return fail('There is no task list yet. Create it with `todos` first.');
      const bad = args.update!.filter((u) => !Number.isInteger(u.item) || u.item < 1 || u.item > current.length).map((u) => u.item);
      if (bad.length) return fail(`The task list has ${current.length} item(s); there is no item ${bad.join(', ')}. Items count from 1.`);
      todos = current.map((t) => ({ ...t }));
      for (const u of args.update!) todos[u.item - 1]!.status = u.status;
    }
    return {
      access: { kind: 'none' },
      async execute() {
        ctx.setTodos(todos);
        const done = todos.filter((t) => t.status === 'completed').length;
        ctx.update({ title: `Task list — ${done}/${todos.length} done` });
        // The list lives in the conversation rather than the system prompt, so changing it never invalidates the prompt cache.
        // It is numbered so the model can refer to items in later updates.
        const mark = (s: TodoItem['status']) => (s === 'completed' ? 'x' : s === 'in_progress' ? '~' : ' ');
        return ok(`Task list (${done}/${todos.length} done):\n${todos.map((t, i) => `${i + 1}. [${mark(t.status)}] ${t.content}`).join('\n')}`);
      },
    };
  },
};

export const askUserTool: Tool<{ questions: AskUserQuestion[] }> = {
  name: 'ask_user',
  category: 'interactive',
  description:
    'Ask the user 1-4 questions and wait. Offer 2-4 short options when there are clear choices. Only for decisions that change what you build and that you cannot find out yourself.',
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
            header: { type: 'string', description: 'Label, max 12 characters.' },
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
