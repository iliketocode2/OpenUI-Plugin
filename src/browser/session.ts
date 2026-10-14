import { mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';
import { BlackholeProxy } from '../net/blackhole';
import { isAllowedBrowserUrl, navigationError, type BrowserPolicy } from './policy';

export type BrowserChannel = 'auto' | 'chrome' | 'msedge';

export interface BrowserOptions extends BrowserPolicy {
  profileDir: string;
  channel: BrowserChannel;
  loadPlaywright?: () => Promise<typeof import('playwright-core')>;
}

const CHROME_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--metrics-recording-only',
  '--disable-default-apps',
  '--disable-extensions',
  '--no-pings',
  '--disable-signin-promo',
  '--disable-search-engine-choice-screen',
  '--disable-background-timer-throttling',
  '--disable-features=OptimizationHints,OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,Translate,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,PrivacySandboxSettings4,NetworkTimeServiceQuerying,SafeBrowsing,ChromeWhatsNewUI,AccountConsistency,SignInProfileCreation,DialMediaRouteProvider,GlobalMediaControls',
];

const MAX_LOG = 200;

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}

function pushCapped(list: string[], entry: string): void {
  list.push(entry.length > 500 ? `${entry.slice(0, 500)}…` : entry);
  if (list.length > MAX_LOG) list.splice(0, list.length - MAX_LOG);
}

export class BrowserSession {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private starting: Promise<Page> | undefined;
  private proxy: BlackholeProxy | undefined;
  channelUsed: string | undefined;
  readonly logs = { console: [] as string[], errors: [] as string[], failed: [] as string[], blocked: [] as string[] };

  constructor(private readonly opts: BrowserOptions) {}

  get proxyAttempts(): readonly string[] {
    return this.proxy?.attempts ?? [];
  }

  isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<{ status: number | undefined; url: string; title: string }> {
    const err = navigationError(url, this.opts);
    if (err) throw new Error(err);
    const page = await this.ensure();
    let response;
    try {
      for (let attempt = 0; ; attempt++) {
        const mainResponse = page
          .waitForResponse((r) => r.request().isNavigationRequest() && r.request().frame() === page.mainFrame(), { timeout: timeoutMs })
          .catch(() => null);
        try {
          response = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
          await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
          break;
        } catch (e) {
          const msg = (e as Error).message;
          if (/interrupted by another navigation/i.test(msg)) {
            const seen = await Promise.race([mainResponse, new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
            if (seen) {
              response = seen;
              await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
              break;
            }
            if (attempt < 2) continue;
          }
          throw e;
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      await page.goto('about:blank', { timeout: 10_000 }).catch(() => undefined);
      if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(msg)) {
        throw new Error(`Nothing is listening at ${url}. Start the dev server first (start_process with wait_for_port), then try again.`);
      }
      if (/ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i.test(msg)) {
        throw new Error(`Navigation to ${url} was blocked because it redirected away from the allowed local hosts.`);
      }
      throw new Error(`Could not load ${url}: ${msg.split('\n')[0]}`);
    }
    const finalUrl = page.url();
    if (!isAllowedBrowserUrl(finalUrl, this.opts)) {
      await page.goto('about:blank').catch(() => undefined);
      throw new Error(`The page redirected to ${finalUrl}, which is outside the allowed local hosts, so it was closed.`);
    }
    return { status: response?.status(), url: finalUrl, title: await page.title().catch(() => '') };
  }

  async screenshot(fullPage: boolean): Promise<{ data: Buffer; mime: 'image/png' | 'image/jpeg' }> {
    const page = this.requirePage();
    const png = await page.screenshot({ fullPage, type: 'png', timeout: 30_000 });
    if (png.length <= 4 * 1024 * 1024) return { data: png, mime: 'image/png' };
    return { data: await page.screenshot({ fullPage, type: 'jpeg', quality: 60, timeout: 30_000 }), mime: 'image/jpeg' };
  }

  async text(selector?: string): Promise<string> {
    const page = this.requirePage();
    if (selector) {
      const loc = page.locator(selector).first();
      return (await loc.innerText({ timeout: 10_000 })).trim();
    }
    return (await page.locator('body').innerText({ timeout: 10_000 })).trim();
  }

  async click(selector: string): Promise<void> {
    await this.requirePage().locator(selector).first().click({ timeout: 10_000 });
  }

  async type(selector: string, text: string, submit: boolean): Promise<void> {
    const loc = this.requirePage().locator(selector).first();
    await loc.fill(text, { timeout: 10_000 });
    if (submit) await loc.press('Enter', { timeout: 10_000 });
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.requirePage().setViewportSize({ width, height });
  }

  async setColorScheme(scheme: 'light' | 'dark'): Promise<void> {
    await this.requirePage().emulateMedia({ colorScheme: scheme });
  }

  drainLogs(): string {
    const parts: string[] = [];
    const section = (title: string, list: string[]) => {
      if (list.length) parts.push(`${title}:\n${list.map((l) => `- ${l}`).join('\n')}`);
      list.length = 0;
    };
    section('Console', this.logs.console);
    section('Uncaught errors', this.logs.errors);
    section('Failed requests', this.logs.failed);
    section('Blocked requests to non-local hosts', this.logs.blocked);
    return parts.join('\n\n');
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.page = undefined;
    this.starting = undefined;
    await ctx?.close().catch(() => undefined);
    await this.proxy?.stop().catch(() => undefined);
    this.proxy = undefined;
    await rm(this.opts.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }

  private requirePage(): Page {
    if (!this.page || this.page.isClosed()) throw new Error('No page is open. Use the navigate action first.');
    return this.page;
  }

  private ensure(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return Promise.resolve(this.page);
    this.starting ??= this.launch().catch((e) => {
      this.starting = undefined;
      throw e;
    });
    return this.starting;
  }

  private async launch(): Promise<Page> {
    const pw = await (this.opts.loadPlaywright ?? (() => import('playwright-core')))();
    await rm(this.opts.profileDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(this.opts.profileDir, { recursive: true });
    const channels = this.opts.channel === 'auto' ? ['chrome', 'msedge'] : [this.opts.channel];
    let proxy: { server: string; bypass: string } | undefined;
    if (!this.opts.allowExternal) {
      this.proxy = new BlackholeProxy();
      const port = await this.proxy.start();
      proxy = { server: `http://127.0.0.1:${port}`, bypass: ['localhost', '127.0.0.1', '[::1]', ...this.opts.extraHosts].join(',') };
    }
    const failures: string[] = [];
    for (const channel of channels) {
      try {
        this.context = await pw.chromium.launchPersistentContext(path.join(this.opts.profileDir, channel), {
          channel,
          headless: true,
          args: CHROME_ARGS,
          ...(proxy ? { proxy } : {}),
          serviceWorkers: 'block',
          acceptDownloads: false,
          viewport: { width: 1280, height: 800 },
          ignoreHTTPSErrors: true,
          timeout: 60_000,
        });
        this.channelUsed = channel;
        break;
      } catch (e) {
        failures.push(`${channel}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    if (!this.context) {
      await this.proxy?.stop();
      throw new BrowserUnavailableError(
        `No supported browser was found (${failures.join('; ')}). Install Google Chrome or Microsoft Edge; the extension never downloads a browser. You can choose one with the owuiAgent.browser.channel setting.`,
      );
    }
    const allowed = (u: string) => isAllowedBrowserUrl(u, this.opts);
    await this.context.route('**/*', (route) => {
      const url = route.request().url();
      if (allowed(url)) return route.continue();
      pushCapped(this.logs.blocked, url);
      return route.abort('blockedbyclient');
    });
    await this.context.routeWebSocket(/.*/, (ws) => {
      if (allowed(ws.url())) ws.connectToServer();
      else {
        pushCapped(this.logs.blocked, ws.url());
        ws.close({ code: 1008, reason: 'Blocked by OWUI Agent' });
      }
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.on('console', (m) => pushCapped(this.logs.console, `[${m.type()}] ${m.text()}`));
    this.page.on('pageerror', (e) => pushCapped(this.logs.errors, e.message));
    this.page.on('requestfailed', (r) => {
      const reason = r.failure()?.errorText ?? 'failed';
      if (!/ERR_BLOCKED_BY_CLIENT/.test(reason)) pushCapped(this.logs.failed, `${r.method()} ${r.url()} — ${reason}`);
    });
    this.page.on('response', (r) => {
      if (r.status() >= 400) pushCapped(this.logs.failed, `${r.request().method()} ${r.url()} — HTTP ${r.status()}`);
    });
    return this.page;
  }
}
