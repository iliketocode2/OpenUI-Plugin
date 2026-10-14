import * as esbuild from 'esbuild';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../src/ui/html';

const ROOT = join(__dirname, '..', '..');

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const NETWORK_IMPORT = /(?:from\s+|require\(\s*|import\(\s*)['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|undici|ws)['"]/;
const NETWORK_GLOBAL = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|new\s+(?:XMLHttpRequest|WebSocket|EventSource)\b|\bimportScripts\b/;

describe('static egress rules', () => {
  const sources = [...files(join(ROOT, 'src'), ['.ts', '.tsx']), ...files(join(ROOT, 'webview', 'src'), ['.ts', '.tsx'])];

  it('only src/net may import network modules or call network APIs', () => {
    const offenders: string[] = [];
    for (const f of sources) {
      const rel = relative(ROOT, f).split(sep).join('/');
      if (rel.startsWith('src/net/')) continue;
      const text = readFileSync(f, 'utf8');
      if (NETWORK_IMPORT.test(text) || NETWORK_GLOBAL.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the webview CSP blocks all connections, remote scripts, styles and frames', () => {
    const csp = contentSecurityPolicy('vscode-resource:', 'n0nce');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("script-src 'nonce-n0nce'");
    expect(csp).not.toMatch(/https?:|unsafe-inline|unsafe-eval|\*/);
  });

  describe('bundled output', () => {
    const out = mkdtempSync(join(tmpdir(), 'owui-egress-'));
    afterAll(() => rmSync(out, { recursive: true, force: true }));

    const ALLOWED_URLS = [
      // XML namespace identifiers used by preact; never fetched.
      /^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace|1998\/Math\/MathML|2000\/xmlns\/?)$/,
      // Loopback only: the default owuiAgent.baseUrl, the browser tool's example URL and its local refusing proxy.
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+\/?|:\$\{[^}]*)?$/,
      // markdown-it/linkify-it prefixes used to normalize link text into hrefs; never fetched.
      /^https?:\/\/$/,
      /^http:\/\/\$\{\w+(?:\.\w+)?\}$/,
      // highlight.js console warning text; never fetched.
      /^https:\/\/github\.com\/highlightjs\/highlight\.js\/(?:issues\/2277|wiki\/security)$/,
    ];

    it('contains no unexpected URL literals', async () => {
      await esbuild.build({
        entryPoints: { extension: join(ROOT, 'src/extension.ts'), webview: join(ROOT, 'webview/src/main.tsx') },
        outdir: out,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['vscode', 'playwright-core'],
        jsx: 'automatic',
        jsxImportSource: 'preact',
        loader: { '.md': 'text' },
        legalComments: 'none',
        minify: true,
        logLevel: 'silent',
      });
      const urls = new Set<string>();
      for (const f of ['extension.js', 'webview.js']) {
        const text = readFileSync(join(out, f), 'utf8');
        for (const m of text.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s'"`)<>\\]+/g)) urls.add(m[0].replace(/[.,;]+$/, ''));
      }
      const unexpected = [...urls].filter((u) => !ALLOWED_URLS.some((re) => re.test(u)));
      expect(unexpected).toEqual([]);
    });
  });
});
