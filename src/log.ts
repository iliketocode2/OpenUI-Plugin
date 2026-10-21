/**
 * Diagnostics for the "OWUI Agent" output channel (VS Code caps and rotates its log files). Only short descriptions
 * go here: never request headers, the API key, prompts or file contents.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const noop: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let current: Logger = noop;

export function setLogger(logger: Logger | undefined): void {
  current = logger ?? noop;
}

export const log: Logger = {
  info: (m) => current.info(redact(m)),
  warn: (m) => current.warn(redact(m)),
  error: (m) => current.error(redact(m)),
};

export function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** A last line of defence in case an error message quotes a key or an Authorization header. */
export function redact(text: string): string {
  return text.replace(/(Bearer\s+)\S+/gi, '$1[redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]');
}
