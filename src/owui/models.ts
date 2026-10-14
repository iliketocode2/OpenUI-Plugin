export type ToolMode = 'auto' | 'native' | 'text';

export interface ServerModel {
  id: string;
  name: string;
  ownedBy?: string;
  vision?: boolean;
  usageCapability?: boolean;
  contextSize?: number;
}

export interface ModelOverride {
  toolMode?: ToolMode;
  contextSize?: number;
  vision?: boolean;
  local?: boolean;
  thinking?: boolean;
}

export type ContextSource = 'setting' | 'server' | 'assumed';

export interface ResolvedModel {
  id: string;
  name: string;
  vision: boolean;
  contextSize: number;
  contextSource: ContextSource;
  toolMode: ToolMode;
  local: boolean;
  thinking?: boolean;
  usageCapability?: boolean;
}

export const ASSUMED_CONTEXT = 4096;

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined;
}

export function parseModelList(body: unknown): ServerModel[] {
  const root = obj(body);
  const list = Array.isArray(body) ? body : Array.isArray(root?.data) ? (root.data as unknown[]) : [];
  const out: ServerModel[] = [];
  for (const raw of list) {
    const m = obj(raw);
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const info = obj(m.info);
    const meta = obj(info?.meta);
    const caps = obj(meta?.capabilities);
    const params = obj(info?.params);
    const options = obj(params?.options);
    const model: ServerModel = { id: m.id, name: typeof m.name === 'string' && m.name ? m.name : m.id };
    if (typeof m.owned_by === 'string') model.ownedBy = m.owned_by;
    if (typeof caps?.vision === 'boolean') model.vision = caps.vision;
    if (typeof caps?.usage === 'boolean') model.usageCapability = caps.usage;
    const ctx = positiveInt(params?.num_ctx) ?? positiveInt(options?.num_ctx);
    if (ctx) model.contextSize = ctx;
    out.push(model);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveModel(server: ServerModel, override: ModelOverride | undefined): ResolvedModel {
  let contextSize = ASSUMED_CONTEXT;
  let contextSource: ContextSource = 'assumed';
  if (override?.contextSize) {
    contextSize = override.contextSize;
    contextSource = 'setting';
  } else if (server.contextSize) {
    contextSize = server.contextSize;
    contextSource = 'server';
  }
  const resolved: ResolvedModel = {
    id: server.id,
    name: server.name,
    vision: override?.vision ?? server.vision ?? false,
    contextSize,
    contextSource,
    toolMode: override?.toolMode ?? 'auto',
    local: override?.local ?? false,
  };
  if (server.usageCapability !== undefined) resolved.usageCapability = server.usageCapability;
  if (override?.thinking !== undefined) resolved.thinking = override.thinking;
  return resolved;
}
