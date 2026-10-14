export class EgressBlockedError extends Error {
  constructor(readonly url: string, reason: string) {
    super(`Blocked outbound request to ${url}: ${reason}`);
    this.name = 'EgressBlockedError';
  }
}

export class InvalidBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBaseUrlError';
  }
}

export interface BaseUrl {
  origin: string;
  pathPrefix: string;
  href: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127(?:\.\d{1,3}){3}$/.test(h) || h.endsWith('.localhost');
}

export function parseBaseUrl(raw: string): BaseUrl {
  const trimmed = raw.trim();
  if (!trimmed) throw new InvalidBaseUrlError('The Open WebUI base URL is not set.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidBaseUrlError(`"${trimmed}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidBaseUrlError('The base URL must start with http:// or https://.');
  }
  if (url.username || url.password) {
    throw new InvalidBaseUrlError('The base URL must not contain credentials. Use the "Set API Key" command instead.');
  }
  if (url.search || url.hash) {
    throw new InvalidBaseUrlError('The base URL must not contain a query string or fragment.');
  }
  const pathPrefix = url.pathname.replace(/\/+$/, '');
  return { origin: url.origin, pathPrefix, href: `${url.origin}${pathPrefix}` };
}

export function isInsecureRemote(base: BaseUrl): boolean {
  const url = new URL(base.origin);
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}

export interface EgressRequest {
  method?: 'GET' | 'POST' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 3;

export class Egress {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly getBaseUrl: () => string,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  base(): BaseUrl {
    return parseBaseUrl(this.getBaseUrl());
  }

  resolve(path: string): string {
    if (!path.startsWith('/')) throw new EgressBlockedError(path, 'only paths relative to the base URL are allowed');
    const base = this.base();
    const url = `${base.href}${path}`;
    this.assertAllowed(url, base);
    return url;
  }

  async request(path: string, req: EgressRequest = {}): Promise<Response> {
    const base = this.base();
    let url = this.resolve(path);
    for (let hop = 0; ; hop++) {
      const res = await this.fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body,
        signal: req.signal,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
      const location = res.headers.get('location');
      if (!location) return res;
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, url).toString();
      this.assertAllowed(next, base);
      if (hop + 1 >= MAX_REDIRECTS) throw new EgressBlockedError(next, 'too many redirects');
      url = next;
    }
  }

  private assertAllowed(target: string, base: BaseUrl): void {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new EgressBlockedError(target, 'invalid URL');
    }
    if (url.origin !== base.origin) {
      throw new EgressBlockedError(target, `only ${base.origin} is allowed`);
    }
    if (url.username || url.password) throw new EgressBlockedError(target, 'credentials in URL');
    const path = url.pathname;
    if (base.pathPrefix && path !== base.pathPrefix && !path.startsWith(`${base.pathPrefix}/`)) {
      throw new EgressBlockedError(target, `path must stay under ${base.pathPrefix}`);
    }
  }
}
