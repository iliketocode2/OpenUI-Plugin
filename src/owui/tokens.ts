import type { ToolDefinition, WireMessage } from './types';

/** Deliberately low (English prose is closer to 4-5), so estimates err towards too many tokens. Only the part of a
 * prompt the server has not counted yet is estimated this way; see AgentSession.estimateRequest. */
export const CHARS_PER_TOKEN = 3.5;
const PER_MESSAGE_OVERHEAD_CHARS = 16;
const IMAGE_TOKENS = 800;
const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 1500;
/** Share of the context window one tool result may fill. */
const TOOL_OUTPUT_SHARE = 0.2;

export interface PromptSize {
  chars: number;
  images: number;
}

export function measurePrompt(messages: WireMessage[], tools?: ToolDefinition[]): PromptSize {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += PER_MESSAGE_OVERHEAD_CHARS;
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length;
        else images++;
      }
    }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return { chars, images };
}

export function tokensFor(size: PromptSize): number {
  return Math.ceil(size.chars / CHARS_PER_TOKEN) + size.images * IMAGE_TOKENS;
}

/** The characters one tool result may use: every tool sizes its output from this, so no result needs cutting twice. */
export function toolOutputChars(contextSize: number): number {
  return Math.max(4000, Math.min(40_000, Math.round(contextSize * TOOL_OUTPUT_SHARE * CHARS_PER_TOKEN)));
}

export type TruncationVerdict =
  | { kind: 'ok'; ratio: number }
  | { kind: 'suspect'; ratio: number; reason: string }
  | { kind: 'unknown' };

export function checkTruncation(estimate: number, promptTokens: number | undefined, contextSize: number): TruncationVerdict {
  if (promptTokens === undefined) return { kind: 'unknown' };
  const ratio = estimate > 0 ? promptTokens / estimate : 1;
  if (estimate > contextSize && promptTokens >= contextSize * 0.97 && promptTokens <= contextSize) {
    return { kind: 'suspect', ratio, reason: `the server counted ${promptTokens} prompt tokens, which is the model's context limit (${contextSize})` };
  }
  if (estimate >= TRUNCATION_MIN_ESTIMATE && ratio < TRUNCATION_RATIO) {
    return {
      kind: 'suspect',
      ratio,
      reason: `the server counted ${promptTokens} prompt tokens but about ${estimate} were sent`,
    };
  }
  return { kind: 'ok', ratio };
}

export type PreflightVerdict = { kind: 'ok' } | { kind: 'near'; fraction: number } | { kind: 'over'; fraction: number };

export function preflight(estimate: number, contextSize: number, reserveForOutput: number, nearFraction = 0.8): PreflightVerdict {
  const budget = Math.max(1, contextSize - reserveForOutput);
  const fraction = estimate / budget;
  if (fraction > 1) return { kind: 'over', fraction };
  if (fraction >= nearFraction) return { kind: 'near', fraction };
  return { kind: 'ok' };
}

export function outputReserve(contextSize: number): number {
  return Math.min(8192, Math.max(512, Math.round(contextSize * 0.25)));
}
