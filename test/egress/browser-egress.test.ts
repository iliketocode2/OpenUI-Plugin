import { existsSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/browser/session';

const PAGE = `<!doctype html><html><head><title>Fixture App</title>
<style>body{background:#fff;color:#111}@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style>
<script src="https://cdn.example.com/lib.js"></script></head>
<body><h1>Fixture App</h1><p id="msg">idle</p>
<img src="https://tracker.example.net/pixel.gif">
<form id="f"><input id="name"><button id="go" type="button" onclick="document.getElementById('msg').textContent='hello '+document.getElementById('name').value">Go</button></form>
<script>
console.log('app booted');
fetch('https://api.example.org/data').catch(() => console.warn('external fetch failed'));
fetch('/api/local').then(r => r.json()).then(j => console.log('local api ' + j.ok));
try { new WebSocket('wss://socket.example.com/live'); } catch (e) {}
document.title = 'Fixture App ' + (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') + ' ' + innerWidth;
setTimeout(() => { throw new Error('boom from app'); }, 10);
</script></body></html>`;

// CI sets this to keep Playwright's own log of every call and of the browser process, uploaded when the step fails.
// Playwright is loaded on the first launch, after this runs, and this file runs in a worker process of its own.
if (process.env.OWUI_BROWSER_DEBUG_LOG) {
  process.env.DEBUG = 'pw:api,pw:browser';
  process.env.DEBUG_FILE = process.env.OWUI_BROWSER_DEBUG_LOG;
}

/** Fails with the step's name, so a hang on a CI machine says which call never returned. */
function step<T>(name: string, promise: Promise<T>, ms = 45_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Step "${name}" did not finish within ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let server: http.Server;
let base: string;
let profileRoot: string;
let session: BrowserSession;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/api/local') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    if (req.url === '/leave') return void res.writeHead(302, { Location: 'https://evil.example.com/landing' }).end();
    if (req.url === '/missing') return void res.writeHead(404).end('nope');
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profileRoot = await mkdtemp(path.join(tmpdir(), 'owui browser '));
  session = new BrowserSession({ profileDir: path.join(profileRoot, 'profile'), channel: 'auto', extraHosts: [] });
}, 60_000);

afterAll(async () => {
  await session?.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(profileRoot, { recursive: true, force: true });
});

describe('browser tool egress (headless Chrome/Edge)', () => {
  it('loads a local page while blocking every non-local request', async () => {
    const nav = await session.navigate(`${base}/`);
    expect(nav.status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(nav.title).toMatch(/^Fixture App light 1280$/);
    const logs = { ...session.logs, blocked: [...session.logs.blocked] };
    const blockedHosts = new Set(logs.blocked.map((u) => new URL(u).hostname));
    expect([...blockedHosts].sort()).toEqual(['api.example.org', 'cdn.example.com', 'socket.example.com', 'tracker.example.net']);
    expect(logs.console.join('\n')).toContain('app booted');
    expect(logs.console.join('\n')).toContain('local api true');
    expect(logs.errors.join('\n')).toContain('boom from app');
    const pageHosts = ['api.example.org', 'cdn.example.com', 'socket.example.com', 'tracker.example.net'];
    expect(session.proxyAttempts.filter((a) => pageHosts.some((h) => a.includes(h)))).toEqual([]);
    expect(session.channelUsed).toMatch(/chrome|msedge/);
  }, 90_000);

  it('reads text, interacts, resizes and switches colour scheme', async () => {
    await session.type('#name', 'sovereign', false);
    await session.click('#go');
    expect(await session.text('#msg')).toBe('hello sovereign');
    await session.setViewport(390, 844);
    await session.setColorScheme('dark');
    await session.navigate(`${base}/`);
    expect((await session.text()).startsWith('Fixture App')).toBe(true);
    const shot = await session.screenshot(true);
    expect(shot.mime).toBe('image/png');
    expect(shot.data.subarray(1, 4).toString()).toBe('PNG');
    expect(shot.data.length).toBeGreaterThan(1000);
    const report = session.drainLogs();
    expect(report).toMatch(/Blocked requests to non-local hosts/);
    expect(session.drainLogs()).toBe('');
  }, 60_000);

  it('refuses non-local URLs and redirects that leave loopback', async () => {
    await expect(session.navigate('https://example.com/')).rejects.toThrow(/only opens local development servers/);
    await expect(session.navigate('file:///C:/Windows/win.ini')).rejects.toThrow(/Only http/);
    await expect(session.navigate(`${base}/leave`)).rejects.toThrow(/blocked|outside the allowed/);
    expect(session.proxyAttempts.some((a) => a.includes('evil.example.com'))).toBe(true);
    const missing = await session.navigate(`${base}/missing`);
    expect(missing.status).toBe(404);
  }, 60_000);

  it('routes everything that is not loopback to the refusing proxy, never to the network', async () => {
    const loopback = session.proxyAttempts.filter((a) => /^(https?:\/\/)?(localhost|127\.|\[::1\])/i.test(a));
    expect(loopback).toEqual([]);
  });

  it('explains when no dev server is running', async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    await expect(session.navigate(`http://127.0.0.1:${port}/`)).rejects.toThrow(/Nothing is listening/);
  }, 60_000);

  it('opens a new page after the page closes, and a new browser after the browser exits', async () => {
    type Context = { close(): Promise<void>; once(event: 'close', cb: () => void): void };
    const internals = session as unknown as { page: { close(): Promise<void> }; context: Context; proxy: unknown };
    await step('first navigate', session.navigate(`${base}/`));
    const proxyBefore = internals.proxy;
    await step('page.close', internals.page.close());
    expect((await step('navigate after the page closed', session.navigate(`${base}/`))).status).toBe(200);
    expect(internals.proxy).toBe(proxyBefore);

    // The browser goes away (as when the user closes it). Its process can take a minute to exit on a busy machine, and
    // context.close() waits for that, so wait only for the close event: the session must not wait for the exit either.
    const ctx = internals.context;
    const closed = new Promise<void>((resolve) => ctx.once('close', resolve));
    void ctx.close().catch(() => undefined);
    await step('browser close event', closed);
    expect((await step('navigate after the browser exited', session.navigate(`${base}/`))).status).toBe(200);
    expect(internals.proxy).not.toBe(proxyBefore);
    expect(await step('text', session.text('h1'))).toBeTruthy();
  }, 180_000);

  it('replaces a browser that stops responding instead of waiting for it forever', async () => {
    const internals = session as unknown as { page: { close(): Promise<void> }; context: { newPage(): Promise<unknown> }; proxy: unknown };
    await step('first navigate', session.navigate(`${base}/`));
    const proxyBefore = internals.proxy;
    internals.context.newPage = () => new Promise(() => undefined); // never settles, as a browser that is exiting
    await step('page.close', internals.page.close());
    // Bounded, not instant: 15 s for the tab, 10 s to close the old browser, then a launch (up to 60 s) and the load.
    // Generous, because a busy CI machine launches Chrome slowly; before the fix this waited forever.
    expect((await step('navigate with an unresponsive browser', session.navigate(`${base}/`), 150_000)).status).toBe(200);
    expect(internals.proxy).not.toBe(proxyBefore);
  }, 200_000);

  it('deletes its temporary profile on close', async () => {
    expect(existsSync(path.join(profileRoot, 'profile'))).toBe(true);
    // Up to 10 s to close the browser, then retries while a browser that is still exiting keeps files open.
    await step('session.close', session.close(), 90_000);
    expect(existsSync(path.join(profileRoot, 'profile'))).toBe(false);
  }, 120_000);
});
