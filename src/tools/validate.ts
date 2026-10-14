import type { JsonSchema } from './types';

export function validateArgs(schema: JsonSchema, value: unknown, path = 'arguments'): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type) {
    const actual = typeOf(value);
    const okType = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!okType) {
      errors.push(`${path} must be ${schema.type === 'integer' ? 'an integer' : `a${/^[aeiou]/.test(schema.type) ? 'n' : ''} ${schema.type}`}, got ${actual}`);
      return;
    }
  }
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} allows at most ${schema.maxItems} item(s)`);
    if (schema.items) value.forEach((v, i) => check(schema.items!, v, `${path}[${i}]`, errors));
  }
  if (schema.type === 'object' && typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (obj[key] === undefined || obj[key] === null) errors.push(`${path}.${key} is required`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = schema.properties?.[key];
      if (sub) {
        if (v !== undefined && v !== null) check(sub, v, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not a known parameter`);
      }
    }
  }
}

export function coerceArgs(schema: JsonSchema, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const v = out[key];
    if (v === null) {
      delete out[key];
      continue;
    }
    if (typeof v === 'string' && (sub.type === 'integer' || sub.type === 'number') && v.trim() !== '' && !Number.isNaN(Number(v))) {
      out[key] = Number(v);
    } else if (typeof v === 'string' && sub.type === 'boolean' && (v === 'true' || v === 'false')) {
      out[key] = v === 'true';
    } else if (typeof v === 'string' && (sub.type === 'array' || sub.type === 'object') && /^\s*[[{]/.test(v)) {
      try {
        out[key] = JSON.parse(v);
      } catch {
        // leave as-is; validation reports the type error
      }
    }
  }
  return out;
}

export function parseArguments(raw: string): { value?: Record<string, unknown>; error?: string } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!text) return { value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { error: 'Tool arguments must be a JSON object.' };
    return { value: v as Record<string, unknown> };
  } catch (e) {
    return { error: `Tool arguments are not valid JSON (${(e as Error).message}). Send a single JSON object.` };
  }
}
