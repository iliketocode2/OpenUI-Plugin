import type { AgentMode } from '../shared/protocol';
import type { ToolDefinition } from '../owui/types';
import { readFileTool } from './fs/read';
import { globTool, grepTool } from './fs/search';
import { editFileTool, writeFileTool } from './fs/write';
import { askUserTool, todoWriteTool, viewImageTool } from './interactive';
import { browserTool } from './browser';
import { loadSkillTool, updateMemoryTool } from './knowledge';
import { webFetchTool, webSearchTool } from './web';
import { processTool, runCommandTool, startProcessTool } from './shell/tools';
import type { JsonSchema, Tool } from './types';

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  startProcessTool,
  processTool,
  viewImageTool,
  todoWriteTool,
  askUserTool,
  loadSkillTool,
  updateMemoryTool,
  webSearchTool,
  webFetchTool,
  browserTool,
] as unknown as Tool[];

export const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
export const BROWSER_TOOLS = new Set(['browser']);

export interface ToolSelection {
  vision: boolean;
  hasSkills: boolean;
  enabled(name: string): boolean;
}

export class ToolRegistry {
  private readonly byName = new Map<string, Tool>();

  constructor(tools: Tool[] = ALL_TOOLS) {
    for (const t of tools) this.byName.set(t.name, t);
  }

  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  list(filter?: (t: Tool) => boolean): Tool[] {
    return [...this.byName.values()].filter((t) => !filter || filter(t));
  }

  /** The tools offered to the model. Chosen once per session so the request prefix stays identical across turns. */
  select(opts: ToolSelection): Tool[] {
    return this.list((t) => {
      if (t.name === 'view_image' && !opts.vision) return false;
      if (t.name === 'load_skill' && !opts.hasSkills) return false;
      return opts.enabled(t.name);
    });
  }

  definitions(tools: Tool[], opts: { shells?: string[] } = {}): ToolDefinition[] {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: withShells(t.parameters, opts.shells) as Record<string, unknown> } }));
  }
}

/** Narrows a `shell` enum to the installed shells, and drops the parameter when there is no choice to make. */
function withShells(schema: JsonSchema, shells: string[] | undefined): JsonSchema {
  const shell = schema.properties?.shell;
  if (!shells || !shell?.enum) return schema;
  const { shell: _omit, ...rest } = schema.properties!;
  if (shells.length < 2) return { ...schema, properties: rest };
  return { ...schema, properties: { ...rest, shell: { ...shell, enum: shell.enum.filter((s) => shells.includes(String(s))) } } };
}

/** Plan mode is read-only: it allows reading, searching and questions, and refuses the rest when called. */
export function allowedInMode(tool: Tool, mode: AgentMode): boolean {
  return mode !== 'plan' || tool.category === 'read' || tool.category === 'interactive';
}
