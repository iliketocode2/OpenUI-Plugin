import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { MEMORY_DIR, MEMORY_INDEX, OWUI_DIR, looksLikeSecret, removeIndexLine, upsertIndexLine } from '../memory/projectMemory';
import { listSkillFiles } from '../skills/discovery';
import { changeSummary, computeDiff } from './fs/diffing';
import { fail, ok, type Tool } from './types';

async function readOr(file: string, fallback: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return fallback;
  }
}

interface MemoryArgs {
  topic: string;
  content?: string;
  summary?: string;
  delete?: boolean;
}

export const updateMemoryTool: Tool<MemoryArgs> = {
  name: 'update_memory',
  category: 'edit',
  description:
    'Save a durable project fact for future sessions: build and test commands, conventions, architecture decisions, environment quirks. Writes .owui/memory/<topic>.md and links it from MEMORY.md. Replace the whole topic content; set delete=true to remove a topic. Never store secrets.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Lowercase kebab-case topic name, e.g. "build-and-test".' },
      content: { type: 'string', description: 'Full Markdown content of the topic file.' },
      summary: { type: 'string', description: 'One-line summary for the index.' },
      delete: { type: 'boolean' },
    },
    required: ['topic'],
  },
  title: (a) => `${a.delete ? 'Forget' : 'Remember'} ${a.topic}`,
  async prepare(args, ctx) {
    const root = ctx.paths.primaryRoot();
    if (!root) return fail('No workspace folder is open, so there is nowhere to store project memory.');
    const topic = args.topic.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(topic) || topic === 'memory') return fail('topic must be lowercase kebab-case (letters, digits, hyphens), up to 49 characters, and not "memory".');
    if (!args.delete && !args.content?.trim()) return fail('content is required unless delete is true.');
    if (looksLikeSecret(`${args.content ?? ''}\n${args.summary ?? ''}`)) {
      return fail('The content or summary looks like it contains a secret (key, token, password or private key). Never store secrets in project memory; describe where the secret is configured instead.');
    }
    const dir = path.join(root, MEMORY_DIR);
    const topicFile = ctx.paths.resolve(path.join(dir, `${topic}.md`));
    const indexFile = ctx.paths.resolve(path.join(dir, MEMORY_INDEX));
    const beforeTopic = await readOr(topicFile.absolute, '');
    const beforeIndex = await readOr(indexFile.absolute, '');
    if (args.delete && !beforeTopic && !beforeIndex.includes(`(${topic}.md)`)) return fail(`There is no memory topic "${topic}".`);
    const afterTopic = args.delete ? '' : `${args.content!.trim()}\n`;
    const afterIndex = args.delete ? removeIndexLine(beforeIndex, topic) : upsertIndexLine(beforeIndex, topic, args.summary);
    const diff = computeDiff(beforeTopic, afterTopic);
    return {
      access: { kind: 'write', paths: [topicFile, indexFile] },
      card: { title: `${args.delete ? 'Forget' : 'Remember'} ${topic} — ${args.delete ? 'delete topic' : changeSummary(diff)}`, diff: diff.unified },
      preview: { absolute: topicFile.absolute, display: topicFile.display, before: beforeTopic, after: afterTopic },
      async execute() {
        const owuiExisted = existsSync(path.join(root, OWUI_DIR));
        await ctx.beforeWrite(topicFile.absolute);
        await ctx.beforeWrite(indexFile.absolute);
        await mkdir(dir, { recursive: true });
        if (args.delete) await rm(topicFile.absolute, { force: true });
        else await writeFile(topicFile.absolute, afterTopic, 'utf8');
        await writeFile(indexFile.absolute, afterIndex, 'utf8');
        if (!owuiExisted) ctx.workspaceDirCreated(path.join(root, OWUI_DIR));
        return ok(args.delete ? `Removed memory topic ${topic}.` : `Saved memory topic ${topic} (${topicFile.display}).`);
      },
    };
  },
};

export const loadSkillTool: Tool<{ name: string }> = {
  name: 'load_skill',
  category: 'read',
  description: 'Load the full instructions of a skill listed in the Skills section, plus the paths of its bundled files and scripts.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  title: (a) => `Load skill ${a.name}`,
  async prepare(args, ctx) {
    return {
      access: { kind: 'none' },
      async execute() {
        const skill = ctx.skills.find((s) => s.name === args.name) ?? ctx.skills.find((s) => s.name.toLowerCase() === args.name.toLowerCase());
        if (!skill) return fail(`No skill named "${args.name}". Available: ${ctx.skills.map((s) => s.name).join(', ') || 'none'}.`);
        const text = await readFile(skill.file, 'utf8');
        const files = await listSkillFiles(skill.dir);
        ctx.update({ title: `Load skill ${skill.name}` });
        return ok(
          `${text.trim()}\n\n---\nSkill folder: ${skill.dir}\n${files.length ? `Files (use absolute paths; run scripts with run_command):\n${files.map((f) => `- ${f}`).join('\n')}` : 'No other files.'}`,
        );
      },
    };
  },
};
