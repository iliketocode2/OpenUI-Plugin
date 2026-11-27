import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToWebview, TranscriptItem, ViewState } from '../../src/shared/protocol';
import { renderHtml } from '../../src/ui/html';

/** The built chat view in a real Chrome or Edge, with the same HTML and CSP the extension uses, and a stand-in for the
 * VS Code API that records what the page sends. */
let out: string;
let server: http.Server;
let origin: string;
let browser: Browser;
let page: Page;

const root = path.join(__dirname, '..', '..');

beforeAll(async () => {
  out = await mkdtemp(path.join(tmpdir(), 'owui webview '));
  await esbuild.build({
    entryPoints: [path.join(root, 'webview/src/main.tsx')],
    outfile: path.join(out, 'main.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'warning',
  });
  const script = await readFile(path.join(out, 'main.js'));
  const styles = await readFile(path.join(root, 'webview/src/styles.css'));
  server = http.createServer((req, res) => {
    if (req.url === '/main.js') return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script);
    if (req.url === '/styles.css') return void res.writeHead(200, { 'Content-Type': 'text/css' }).end(styles);
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(renderHtml({ cspSource: origin, nonce: 'testnonce', scriptUri: '/main.js', styleUri: '/styles.css' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { chromium } = await import('playwright-core');
  const failures: string[] = [];
  for (const channel of ['chrome', 'msedge']) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch (e) {
      failures.push(`${channel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (!browser) throw new Error(`No Chrome or Edge to run the webview in: ${failures.join('; ')}`);
});

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  await rm(out, { recursive: true, force: true });
});

beforeEach(async () => {
  await page?.context().close();
  const context = await browser.newContext();
  // The page may only reach the test server, like the real webview with connect-src 'none'.
  await context.route('**/*', (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { posted: unknown[]; acquireVsCodeApi: () => unknown };
    w.posted = [];
    w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => w.posted.push(m), getState: () => undefined, setState: () => undefined });
  });
  await page.goto(`${origin}/`);
  await page.waitForFunction(() => (window as unknown as { posted: { type: string }[] }).posted.some((m) => m.type === 'ready'));
});

function viewState(transcript: TranscriptItem[], busy = false): ViewState {
  return {
    sessionId: 's',
    connection: { baseUrl: 'http://localhost:3000', insecure: false, hasKey: true, status: 'ok' },
    models: [{ id: 'm', name: 'Model', local: true, vision: false, thinking: true, contextSize: 16384, contextSource: 'setting' }],
    selectedModel: 'm',
    busy,
    mode: 'ask',
    transcript,
    todos: [],
    sovereignty: 'local',
    noticeAcknowledged: true,
    web: { enabled: false, verification: 'unverified' },
  };
}

async function send(msg: ToWebview): Promise<void> {
  await page.evaluate((m) => window.postMessage(m, '*'), msg);
}

async function posted(type?: string): Promise<{ type: string; [k: string]: unknown }[]> {
  const all = await page.evaluate(() => (window as unknown as { posted: { type: string }[] }).posted);
  return type ? all.filter((m) => m.type === type) : all;
}

const approval = (id: string): TranscriptItem => ({
  id,
  kind: 'tool',
  ts: 2,
  tool: 'run_command',
  title: 'Delete the build folder',
  status: 'awaiting-approval',
  input: 'rm -rf build',
  approval: { kind: 'command', question: 'Run this command?', warnings: [] },
});

describe('chat view page', () => {
  it('shows hostile model output as text and never runs it', async () => {
    const text = [
      '<script>window.pwned = 1</script>',
      '<img src=x onerror="window.pwned = 2">',
      '[open](javascript:window.pwned=3) [cmd](command:workbench.action.terminal.new) [web](https://example.com/)',
      '```"><img src=x onerror=window.pwned=4>\ncode\n```',
      '<svg onload="window.pwned = 5"></svg>',
    ].join('\n\n');
    await send({
      type: 'state',
      state: viewState([
        { id: 'u', kind: 'user', text: '<img src=x onerror="window.pwned = 6">', ts: 1 },
        { id: 'a', kind: 'assistant', text, reasoning: '<img src=x onerror="window.pwned = 7">', ts: 2, streaming: false },
        { id: 't', kind: 'tool', ts: 3, tool: 'read_file', title: '<img src=x onerror="window.pwned = 8">', status: 'done', output: '<script>window.pwned = 9</script>' },
      ]),
    });
    await page.waitForSelector('.markdown');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    expect(await page.locator('img, svg, script:not([src])').count()).toBe(0);
    expect(await page.locator('.markdown').first().innerText()).toContain('<script>window.pwned = 1</script>');
    for (const link of await page.locator('.markdown a').all()) await link.click();
    expect((await posted('openLink')).map((m) => m.href)).toEqual(['https://example.com/']);
  });

  it('shows how long slow tools ran and waited, and nothing for quick ones', async () => {
    const tool = (id: string, extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>>): TranscriptItem => ({ id, kind: 'tool', ts: 2, tool: 'run_command', title: id, status: 'done', ...extra });
    await send({
      type: 'state',
      state: viewState([
        tool('quick', { durationMs: 300, waitedMs: 200 }),
        tool('slow', { durationMs: 41_200, waitedMs: 192_000 }),
        tool('approved', { durationMs: 100, waitedMs: 5_000 }),
      ]),
    });
    await page.waitForSelector('.tool-time');
    const times = page.locator('.tool-time');
    expect(await times.count()).toBe(2);
    expect(await times.nth(0).innerText()).toBe('41.2s');
    expect(await times.nth(0).getAttribute('aria-label')).toBe('Ran for 41.2s, waited 3m12s for your approval');
    expect(await times.nth(1).innerText()).toBe('waited 5.0s');
  });

  it('shows a ticking warm-up chip and composer hint while the model loads, and a warning if it failed', async () => {
    await send({ type: 'state', state: { ...viewState([]), warmUp: { status: 'warming', modelId: 'm', startedAt: Date.now() - 42_000 } } });
    const chip = page.locator('.warmup');
    await chip.waitFor();
    expect(await chip.textContent()).toMatch(/Loading model… 0:4[23]/);
    await expect.poll(async () => chip.textContent(), { timeout: 3000 }).toMatch(/0:4[4-5]/);
    expect(await page.getAttribute('#prompt', 'placeholder')).toMatch(/model is loading/);
    expect(await page.isEnabled('#prompt')).toBe(true);

    await send({ type: 'state', state: { ...viewState([]), warmUp: { status: 'failed', modelId: 'm', startedAt: Date.now(), error: 'HTTP 503' } } });
    await expect.poll(async () => chip.textContent()).toBe('Warm-up failed');
    expect(await chip.getAttribute('title')).toContain('HTTP 503');
    expect(await page.getAttribute('#prompt', 'placeholder')).toMatch(/^Ask anything/);

    await send({ type: 'state', state: viewState([]) });
    await expect.poll(async () => chip.count()).toBe(0);
  });

  it('offers Implement this plan only after a finished plan-mode answer', async () => {
    const plan: TranscriptItem[] = [
      { id: 'u', kind: 'user', text: 'plan it', ts: 1 },
      { id: 'a', kind: 'assistant', text: '1. Do the thing', reasoning: '', ts: 2, streaming: false },
    ];
    const button = page.getByRole('button', { name: 'Implement this plan' });
    await send({ type: 'state', state: { ...viewState(plan), mode: 'plan' } });
    await button.waitFor();
    await button.click();
    expect(await posted('implementPlan')).toHaveLength(1);

    await send({ type: 'state', state: { ...viewState(plan, true), mode: 'plan' } });
    await expect.poll(() => button.count()).toBe(0);
    await send({ type: 'state', state: viewState(plan) });
    await page.waitForTimeout(100);
    expect(await button.count()).toBe(0);
    await send({ type: 'state', state: { ...viewState([...plan, { id: 'w', kind: 'warning', text: 'empty', ts: 3 }]), mode: 'plan' } });
    await page.waitForTimeout(100);
    expect(await button.count()).toBe(0);
  });

  it('shows the run summary: files to open, command outcomes, warnings and unchecked changes', async () => {
    await send({
      type: 'state',
      state: viewState([
        {
          id: 's',
          kind: 'summary',
          ts: 3,
          files: [
            { absolute: '/ws/src/page.tsx', display: 'src/page.tsx', action: 'added' },
            { absolute: '/ws/old.css', display: 'old.css', action: 'deleted' },
          ],
          commands: [
            { command: 'npm run build', status: 'done', exitCode: 0, background: false },
            { command: 'npm run lint', status: 'error', exitCode: 1, background: false },
            { command: 'rm -rf dist', status: 'denied', background: false },
          ],
          warnings: ['npm audit reports 2 vulnerabilities (1 high, 1 critical).'],
          unverified: true,
        },
      ]),
    });
    const card = page.getByRole('region', { name: 'Run summary' });
    await card.waitFor();
    const text = await card.innerText();
    expect(text).toContain('2 files changed by the agent');
    expect(text).toContain('3 commands');
    expect(text).toContain('npm audit reports 2 vulnerabilities (1 high, 1 critical).');
    expect(text).toContain('Nothing was run after the last file change');
    expect(text).toContain('not written by the model');
    expect(await card.locator('.outcome-ok').allInnerTexts()).toEqual(['exit 0']);
    expect(await card.locator('.outcome-bad').allInnerTexts()).toEqual(['exit 1']);
    expect(await card.locator('.summary-command .hint').allInnerTexts()).toEqual(['denied']);
    await card.getByRole('button', { name: 'src/page.tsx' }).click();
    expect(await posted('openFile')).toEqual([{ type: 'openFile', path: '/ws/src/page.tsx' }]);
    expect(await card.getByRole('button', { name: 'old.css' }).count()).toBe(0);
  });

  it('shows a pause at the step limit as a status with Continue, and real errors as alerts', async () => {
    await send({
      type: 'state',
      state: viewState([
        { id: 'p', kind: 'error', ts: 1, text: 'Paused after 50 steps so you can check on it.', action: 'continue' },
        { id: 'e', kind: 'error', ts: 2, text: 'Open WebUI rejected the request.', action: 'retry' },
      ]),
    });
    const pause = page.locator('.banner-pause');
    await pause.waitFor();
    expect(await pause.getAttribute('role')).toBe('status');
    expect(await pause.getAttribute('class')).toContain('banner-warn');
    expect(await page.locator('.banner-error').getAttribute('role')).toBe('alert');
    await pause.getByRole('button', { name: 'Continue' }).click();
    expect(await posted('continue')).toHaveLength(1);
  });

  it('collapses and labels a task list the agent left unfinished', async () => {
    const todos = [
      { content: 'Write a', status: 'completed' as const },
      { content: 'Check a', status: 'pending' as const },
    ];
    await send({ type: 'state', state: { ...viewState([]), todos } });
    const panel = page.locator('details.todos');
    await panel.waitFor();
    expect(await panel.getAttribute('open')).not.toBeNull();
    expect(await panel.locator('summary').textContent()).toBe('Tasks 1/2');

    await send({ type: 'state', state: { ...viewState([]), todos, todosStale: true } });
    await expect.poll(() => panel.locator('summary').textContent()).toBe('Tasks 1/2 · not updated by the agent');
    expect(await panel.getAttribute('class')).toContain('todos-stale');
    expect(await panel.getAttribute('open')).toBeNull();
    expect(await panel.locator('summary').getAttribute('title')).toMatch(/may not match what was done/);

    // While the agent runs again, the list is its current progress and is shown normally.
    await send({ type: 'state', state: { ...viewState([], true), todos, todosStale: true } });
    await expect.poll(() => panel.locator('summary').textContent()).toBe('Tasks 1/2');
  });

  it('leaves focus in the composer when an approval arrives while the user types', async () => {
    await send({ type: 'state', state: viewState([], true) });
    await page.click('#prompt');
    await page.keyboard.type('hello');
    await send({ type: 'state', state: viewState([approval('t1')], true) });
    await page.waitForSelector('.approval');
    await page.keyboard.press('Space');
    expect(await page.inputValue('#prompt')).toBe('hello ');
    expect(await posted('approve')).toEqual([]);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('prompt');
  });

  it('focuses Allow when an approval arrives and nothing else has focus', async () => {
    await send({ type: 'state', state: viewState([], true) });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await send({ type: 'state', state: viewState([approval('t2')], true) });
    await page.waitForSelector('.approval');
    // Focus moves in an effect that runs just after the card is on screen, so poll rather than read it once.
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent?.trim())).toBe('Allow');
  });

  it('stops the agent with Esc from the view, once from the composer, and not when Esc closes something', async () => {
    await send({ type: 'state', state: viewState([approval('t3')], true) });
    await page.waitForSelector('.approval');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    expect(await posted('stop')).toHaveLength(1);

    await page.click('#prompt');
    await page.keyboard.press('Escape');
    expect(await posted('stop')).toHaveLength(2);

    await page.getByRole('button', { name: 'Deny with feedback…' }).click();
    await page.keyboard.press('Escape');
    expect(await posted('stop')).toHaveLength(2);

    // Esc right after the history opens, before its search box takes focus (slow machines hit this), closes it.
    await send({ type: 'showHistory' });
    await page.waitForSelector('.history');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.locator('.history').count()).toBe(0);
    expect(await posted('stop')).toHaveLength(2);

    // With focus on nothing (a click on blank space) or in the composer, Esc closes the history and does not stop.
    for (const focus of ['nothing', 'composer'] as const) {
      await send({ type: 'showHistory' });
      await page.waitForSelector('.history');
      if (focus === 'composer') await page.click('#prompt');
      else await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Escape');
      await expect.poll(() => page.locator('.history').count(), { message: focus }).toBe(0);
      expect(await posted('stop'), focus).toHaveLength(2);
    }
  });

  it('does not stop anything with Esc when the agent is idle', async () => {
    await send({ type: 'state', state: viewState([]) });
    await page.keyboard.press('Escape');
    expect(await posted('stop')).toEqual([]);
  });

  it('inserts text sent by the extension into the composer', async () => {
    await send({ type: 'state', state: viewState([]) });
    await page.click('#prompt');
    await page.keyboard.type('look at ');
    await send({ type: 'insertText', text: '@src/a.ts ' });
    await expect.poll(() => page.inputValue('#prompt')).toContain('@src/a.ts');
  });
});
