import type { Egress } from '../net/egress';
import { HttpError, MissingApiKeyError } from './errors';

export interface WebResult {
  title: string;
  link: string;
  snippet: string;
  content?: string;
}

export type EngineInfo =
  | { status: 'ok'; enabled: boolean; engine: string }
  | { status: 'forbidden' }
  | { status: 'missing' }
  | { status: 'error'; message: string };

export class WebAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAccessError';
  }
}

const SEARCH_PATH = '/api/v1/retrieval/process/web/search';
const FETCH_PATH = '/api/v1/retrieval/process/web';
const CONFIG_PATH = '/api/v1/retrieval/config';
const TIMEOUT_MS = 180_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class OwuiWeb {
  constructor(
    private readonly egress: Egress,
    private readonly apiKey: () => Promise<string | undefined>,
  ) {}

  async engineInfo(signal?: AbortSignal): Promise<EngineInfo> {
    try {
      const res = await this.request('GET', CONFIG_PATH, undefined, signal);
      if (res.status === 401 || res.status === 403) return { status: 'forbidden' };
      if (res.status === 404) return { status: 'missing' };
      if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
      const body = obj(await res.json());
      const web = obj(body?.web) ?? {};
      const search = obj(web.search);
      const enabled = web.ENABLE_WEB_SEARCH ?? search?.enable ?? web.ENABLE_RAG_WEB_SEARCH;
      const engine = web.WEB_SEARCH_ENGINE ?? search?.engine ?? web.RAG_WEB_SEARCH_ENGINE;
      return { status: 'ok', enabled: enabled === true, engine: str(engine) || 'unknown' };
    } catch (e) {
      if (e instanceof MissingApiKeyError) throw e;
      return { status: 'error', message: (e as Error).message };
    }
  }

  async search(query: string, signal?: AbortSignal): Promise<{ results: WebResult[]; withContent: boolean }> {
    const res = await this.request('POST', SEARCH_PATH, { queries: [query] }, signal);
    if (!res.ok) throw await this.describe(res, 'search');
    const body = obj(await res.json()) ?? {};
    const items = Array.isArray(body.items) ? body.items : [];
    const results: WebResult[] = items
      .map(obj)
      .filter((i): i is Json => !!i)
      .map((i) => ({ title: str(i.title), link: str(i.link) || str(i.url), snippet: str(i.snippet) || str(i.content) }))
      .filter((r) => r.link);
    const docs = Array.isArray(body.docs) ? body.docs.map(obj).filter((d): d is Json => !!d) : [];
    for (const d of docs) {
      const meta = obj(d.metadata) ?? {};
      const source = str(meta.source) || str(meta.url);
      const content = str(d.page_content) || str(d.content);
      const match = results.find((r) => r.link === source);
      if (match) match.content = content;
      else if (source) results.push({ title: str(meta.title), link: source, snippet: '', content });
    }
    return { results, withContent: docs.length > 0 };
  }

  async fetchPage(url: string, signal?: AbortSignal): Promise<string> {
    const res = await this.request('POST', `${FETCH_PATH}?process=false`, { url }, signal);
    if (!res.ok) throw await this.describe(res, 'fetch');
    const body = obj(await res.json()) ?? {};
    const file = obj(body.file);
    const data = obj(file?.data);
    const content = str(body.content) || str(data?.content);
    if (!content.trim()) throw new WebAccessError(`Open WebUI returned no readable content for ${url}.`);
    return content;
  }

  private async request(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const key = await this.apiKey();
    if (!key) throw new MissingApiKeyError();
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    return this.egress.request(path, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  private async describe(res: Response, what: 'search' | 'fetch'): Promise<Error> {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      return new WebAccessError(
        `Open WebUI refused the web ${what} (HTTP ${res.status}). Either web search is turned off in Open WebUI (Admin Panel → Settings → Web Search), your account lacks the "Web Search" permission, or the instance's API Key Endpoint Restrictions do not allow ${what === 'search' ? SEARCH_PATH : FETCH_PATH}.`,
      );
    }
    if (res.status === 404 || res.status === 405) {
      return new WebAccessError(`This Open WebUI version does not provide ${what === 'search' ? SEARCH_PATH : FETCH_PATH}. Update Open WebUI to use web ${what}.`);
    }
    return new HttpError(res.status, text);
  }
}
