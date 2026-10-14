import type { ToolDefinition } from './types';

export const OPEN_TAG = '<agent_tool>';
export const CLOSE_TAG = '</agent_tool>';
export const RESULT_TAG = '<tool_result';

export interface TextToolCall {
  raw: string;
  name?: string;
  arguments?: string;
  error?: string;
}

export interface ParseOutput {
  display: string;
  calls: TextToolCall[];
}

function partialSuffix(text: string, tags: string[]): number {
  let best = 0;
  for (const tag of tags) {
    for (let n = Math.min(text.length, tag.length - 1); n > best; n--) {
      if (tag.startsWith(text.slice(text.length - n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

export class TextToolParser {
  private pending = '';
  private inCall = false;
  private callBuf = '';
  private fence = false;
  private lineTail = '';
  private halted = false;
  readonly calls: TextToolCall[] = [];

  push(text: string): ParseOutput {
    const out: ParseOutput = { display: '', calls: [] };
    if (this.halted) return out;
    let buf = this.pending + text;
    this.pending = '';
    while (buf) {
      if (this.inCall) {
        const end = buf.indexOf(CLOSE_TAG);
        if (end === -1) {
          const hold = partialSuffix(buf, [CLOSE_TAG]);
          this.callBuf += buf.slice(0, buf.length - hold);
          this.pending = buf.slice(buf.length - hold);
          return out;
        }
        this.callBuf += buf.slice(0, end);
        buf = buf.slice(end + CLOSE_TAG.length);
        this.inCall = false;
        const call = parseCall(this.callBuf);
        this.callBuf = '';
        this.calls.push(call);
        out.calls.push(call);
        continue;
      }
      if (!this.fence) {
        const open = buf.indexOf(OPEN_TAG);
        const result = buf.indexOf(RESULT_TAG);
        const fenceAt = this.findFence(buf);
        const candidates = [open, result, fenceAt].filter((i) => i !== -1);
        const first = candidates.length ? Math.min(...candidates) : -1;
        if (first === -1) {
          const hold = partialSuffix(buf, [OPEN_TAG, RESULT_TAG, '```']);
          this.emit(out, buf.slice(0, buf.length - hold));
          this.pending = buf.slice(buf.length - hold);
          return out;
        }
        this.emit(out, buf.slice(0, first));
        buf = buf.slice(first);
        if (first === result) {
          this.halted = true;
          return out;
        }
        if (first === open) {
          buf = buf.slice(OPEN_TAG.length);
          this.inCall = true;
          continue;
        }
        this.fence = true;
        this.emit(out, '```');
        buf = buf.slice(3);
        continue;
      }
      const close = this.findFence(buf);
      if (close === -1) {
        const hold = partialSuffix(buf, ['```']);
        this.emit(out, buf.slice(0, buf.length - hold));
        this.pending = buf.slice(buf.length - hold);
        return out;
      }
      this.emit(out, buf.slice(0, close + 3));
      buf = buf.slice(close + 3);
      this.fence = false;
    }
    return out;
  }

  flush(): ParseOutput {
    const out: ParseOutput = { display: '', calls: [] };
    if (this.inCall) {
      const call = parseCall(this.callBuf + this.pending);
      this.calls.push(call);
      out.calls.push(call);
    } else if (!this.halted) {
      out.display = this.pending;
    }
    this.pending = '';
    this.callBuf = '';
    this.inCall = false;
    return out;
  }

  private findFence(buf: string): number {
    for (let i = buf.indexOf('```'); i !== -1; i = buf.indexOf('```', i + 3)) {
      const nl = buf.lastIndexOf('\n', i - 1);
      const prefix = nl === -1 ? this.lineTail + buf.slice(0, i) : buf.slice(nl + 1, i);
      if (/^[ \t]*$/.test(prefix)) return i;
    }
    return -1;
  }

  private emit(out: ParseOutput, text: string): void {
    if (!text) return;
    out.display += text;
    const nl = text.lastIndexOf('\n');
    this.lineTail = nl === -1 ? this.lineTail + text : text.slice(nl + 1);
  }
}

export function extractCallsIgnoringFences(content: string): TextToolCall[] {
  const calls: TextToolCall[] = [];
  const re = /<agent_tool>([\s\S]*?)<\/agent_tool>/g;
  for (const m of content.matchAll(re)) calls.push(parseCall(m[1] ?? ''));
  return calls;
}

export function parseCall(raw: string): TextToolCall {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { raw, error: `The tool call is not valid JSON (${(e as Error).message}). Write exactly one JSON object between ${OPEN_TAG} and ${CLOSE_TAG}.` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { raw, error: 'The tool call must be a JSON object with "name" and "arguments".' };
  const obj = parsed as { name?: unknown; arguments?: unknown; parameters?: unknown };
  if (typeof obj.name !== 'string' || !obj.name) return { raw, error: 'The tool call is missing "name".' };
  const args = obj.arguments ?? obj.parameters ?? {};
  return { raw, name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) };
}

export function describeToolsForText(tools: ToolDefinition[]): string {
  const lines = tools.map((t) => `- ${t.function.name}: ${t.function.description}\n  parameters: ${JSON.stringify(t.function.parameters)}`);
  return [
    '# Calling tools',
    `You have no native function calling. To use a tool, write a block exactly like this, then stop and wait:`,
    `${OPEN_TAG}`,
    '{"name": "read_file", "arguments": {"path": "src/index.ts"}}',
    `${CLOSE_TAG}`,
    'Rules:',
    '- One JSON object per block. You may write several blocks in one reply; they run in order.',
    `- Never write ${RESULT_TAG}> blocks yourself. Results arrive in the next message as ${RESULT_TAG} name="…"> blocks.`,
    '- Write a short note to the user before your tool blocks. Do not put tool blocks inside code fences.',
    '',
    'Available tools:',
    ...lines,
  ].join('\n');
}

export function formatToolResults(results: { name: string; id: string; content: string; isError?: boolean }[]): string {
  return results
    .map((r) => `${RESULT_TAG} name="${r.name}" id="${r.id}"${r.isError ? ' error="true"' : ''}>\n${r.content}\n</tool_result>`)
    .join('\n\n');
}
