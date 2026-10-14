import { Egress } from '../../src/net/egress';
import { OwuiWeb } from '../../src/owui/web';
import { formatSearchResults, wrapUntrusted } from '../../src/tools/web';

const BASE = (process.env.OWUI_BASE_URL ?? 'http://localhost:8090').replace(/\/+$/, '');
const KEY = process.env.OWUI_API_KEY;
const QUERY = process.env.OWUI_WEB_QUERY ?? 'vitest vi.mock ES modules documentation';
const URL_TO_FETCH = process.env.OWUI_WEB_URL ?? 'https://vitest.dev/guide/mocking.html';

function line(status: 'PASS' | 'WARN' | 'FAIL', name: string, detail: string): void {
  process.stdout.write(`[${status}] ${name} — ${detail}\n`);
}

async function main(): Promise<void> {
  if (!KEY) {
    process.stdout.write('OWUI_API_KEY is not set.\n');
    process.exit(2);
  }
  const web = new OwuiWeb(new Egress(() => BASE), async () => KEY);
  let failed = 0;

  const info = await web.engineInfo();
  if (info.status === 'ok') {
    const ok = info.enabled && info.engine.toLowerCase() === 'searxng';
    line(ok ? 'PASS' : 'WARN', 'engine detection', `web search ${info.enabled ? 'on' : 'OFF'}, engine "${info.engine}"`);
  } else line('WARN', 'engine detection', JSON.stringify(info));

  try {
    const started = Date.now();
    const r = await web.search(QUERY);
    const text = formatSearchResults(QUERY, r.results);
    line(r.results.length ? 'PASS' : 'WARN', 'web search', `${r.results.length} results in ${Date.now() - started}ms; page content included: ${r.withContent}; first: ${r.results[0]?.link ?? '-'}`);
    process.stdout.write(`${text.slice(0, 900)}\n…\n`);
  } catch (e) {
    failed++;
    line('FAIL', 'web search', (e as Error).message);
  }

  try {
    const started = Date.now();
    const content = await web.fetchPage(URL_TO_FETCH);
    line('PASS', 'web fetch', `${content.length} characters in ${Date.now() - started}ms`);
    process.stdout.write(`${wrapUntrusted(URL_TO_FETCH, content.replace(/\s+/g, ' ').slice(0, 300))}\n`);
  } catch (e) {
    failed++;
    line('FAIL', 'web fetch', (e as Error).message);
  }
  process.exitCode = failed ? 1 : 0;
}

void main();
