import type { AgentMode } from '../shared/protocol';
import type { ToolDefinition } from '../owui/types';
import { listDirTool, readFileTool } from './fs/read';
import { globTool, grepTool } from './fs/search';
import { editFileTool, writeFileTool } from './fs/write';
import { askUserTool, exitPlanModeTool, todoWriteTool, viewImageTool } from './interactive';
import { browserInteractTool, browserTool } from './browser';
import { loadSkillTool, updateMemoryTool } from './knowledge';
import { webFetchTool, webSearchTool } from './web';
import { listProcessesTool, readProcessOutputTool, runCommandTool, startProcessTool, stopProcessTool } from './shell/tools';
import type { Tool } from './types';

export const ALL_TOOLS: Tool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  startProcessTool,
  readProcessOutputTool,
  stopProcessTool,
  listProcessesTool,
  viewImageTool,
  todoWriteTool,
  askUserTool,
  exitPlanModeTool,
  loadSkillTool,
  updateMemoryTool,
  webSearchTool,
  webFetchTool,
  browserTool,
  browserInteractTool,
] as unknown as Tool[];

export const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
export const BROWSER_TOOLS = new Set(['browser', 'browser_interact']);

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

  definitions(tools: Tool[]): ToolDefinition[] {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> } }));
  }
}

export function toolsForMode(tools: Tool[], mode: AgentMode): Tool[] {
  if (mode === 'plan') return tools.filter((t) => t.category === 'read' || t.category === 'interactive');
  return tools.filter((t) => t.name !== 'exit_plan_mode');
}
