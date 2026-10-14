import type { ToolDefinition, WireMessage } from './types';

export const DEFAULT_CHARS_PER_TOKEN = 3.5;
const PER_MESSAGE_OVERHEAD_CHARS = 16;
const IMAGE_TOKENS = 800;
const TRUNCATION_RATIO = 0.6;
const TRUNCATION_MIN_ESTIMATE = 1500;
const CALIBRATION_SAFE_FRACTION = 0.8;
const CALIBRATION_WEIGHT = 0.3;
const MIN_CPT = 1.5;
const MAX_CPT = 8;

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

export function tokensFor(size: PromptSize, charsPerToken: number): number {
  return Math.ceil(size.chars / charsPerToken) + size.images * IMAGE_TOKENS;
}

export interface CalibrationState {
  charsPerToken: number;
  samples: number;
}

export class TokenCalibrator {
  private readonly perModel = new Map<string, CalibrationState>();

  constructor(initial?: Record<string, CalibrationState>) {
    for (const [k, v] of Object.entries(initial ?? {})) this.perModel.set(k, v);
  }

  charsPerToken(model: string): number {
    return this.perModel.get(model)?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  }

  isCalibrated(model: string): boolean {
    return (this.perModel.get(model)?.samples ?? 0) > 0;
  }

  estimate(model: string, size: PromptSize): number {
    return tokensFor(size, this.charsPerToken(model));
  }

  observe(model: string, size: PromptSize, promptTokens: number, contextSize: number): boolean {
    const textTokens = promptTokens - size.images * IMAGE_TOKENS;
    if (textTokens <= 0 || size.chars < 200) return false;
    if (promptTokens >= contextSize * CALIBRATION_SAFE_FRACTION) return false;
    if (tokensFor(size, DEFAULT_CHARS_PER_TOKEN) >= contextSize * CALIBRATION_SAFE_FRACTION) return false;
    const observed = size.chars / textTokens;
    if (observed < MIN_CPT || observed > MAX_CPT) return false;
    const cur = this.perModel.get(model);
    const next = cur ? cur.charsPerToken * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT : observed;
    this.perModel.set(model, { charsPerToken: next, samples: (cur?.samples ?? 0) + 1 });
    return true;
  }

  snapshot(): Record<string, CalibrationState> {
    return Object.fromEntries(this.perModel);
  }
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
