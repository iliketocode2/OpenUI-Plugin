export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(HttpError.describe(status, body));
    this.name = 'HttpError';
  }

  static describe(status: number, body: string): string {
    let detail = body.trim();
    try {
      const j = JSON.parse(body) as { detail?: unknown; error?: { message?: unknown } | unknown; message?: unknown };
      const d = j.detail ?? (typeof j.error === 'object' && j.error ? (j.error as { message?: unknown }).message : j.error) ?? j.message;
      if (typeof d === 'string') detail = d;
    } catch {
      // body is not JSON
    }
    return `HTTP ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
  }

  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }

  get toolsUnsupported(): boolean {
    return this.status >= 400 && this.status < 500 && /does not support tools|tools? (?:is|are) not supported|tool[_ ]?calling/i.test(this.body);
  }
}

export class StallError extends Error {
  constructor(
    seconds: number,
    readonly beforeFirstResponse = false,
  ) {
    super(
      beforeFirstResponse
        ? `The model did not start responding within ${seconds}s, so the request was aborted. On CPU-only servers, loading the model or reading a long prompt can take minutes; raise owuiAgent.request.firstResponseTimeoutSeconds if this keeps happening.`
        : `The model sent nothing for ${seconds}s, so the request was aborted.`,
    );
    this.name = 'StallError';
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('No Open WebUI API key is set. Run "OWUI Agent: Set API Key".');
    this.name = 'MissingApiKeyError';
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || (e as { code?: string }).code === 'ABORT_ERR');
}
