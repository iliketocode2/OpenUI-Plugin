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

/** The features Playwright disables itself (playwright-core 1.63, src/server/chromium/chromiumSwitches.ts). Chrome
 * keeps only the last --disable-features it is given, so ours would otherwise replace Playwright's list, and without
 * AvoidUnnecessaryBeforeUnloadCheckSync page.close() can hang (playwright#14047), which hung the Linux CI.
 * test/unit/browserArgs.test.ts fails when an upgraded Playwright disables a feature missing here. */
export const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync', 'DestroyProfileOnBrowserClose', 'DialMediaRouteProvider', 'GlobalMediaControls', 'HttpsUpgrades',
  'LensOverlay', 'MediaRouter', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'BlockOriginHeaderModificationOnRedirect', 'Translate',
  'AutoDeElevate', 'OptimizationHints', 'msForceBrowserSignIn', 'msEdgeUpdateLaunchServicesPreferredVersion',
];

/** Background features that would contact Google or Microsoft. The proxy refuses that traffic anyway; this keeps the
 * browser from trying. */
const PRIVACY_DISABLED_FEATURES = [
  'OptimizationHints', 'OptimizationGuideModelDownloading', 'OptimizationHintsFetching', 'MediaRouter', 'Translate', 'AutofillServerCommunication',
  'CertificateTransparencyComponentUpdater', 'InterestFeedContentSuggestions', 'PrivacySandboxSettings4', 'NetworkTimeServiceQuerying', 'SafeBrowsing',
  'ChromeWhatsNewUI', 'AccountConsistency', 'SignInProfileCreation', 'DialMediaRouteProvider', 'GlobalMediaControls',
];

/** The one --disable-features list the browser gets: Playwright's and ours. */
export function disabledFeatures(): string[] {
  return [...new Set([...PLAYWRIGHT_DISABLED_FEATURES, ...PRIVACY_DISABLED_FEATURES])];
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
  `--disable-features=${disabledFeatures().join(',')}`,
];

const MAX_LOG = 200;
const NEW_PAGE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 10_000;

/** Rejects if `promise` has not settled within `ms`, for Playwright calls that take no timeout of their own. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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
  /** False once the browser has exited (it crashed, or was closed), so the next action starts a new one. */
  private contextAlive = false;
  /** Numbers each browser's profile folder, so a new browser never shares one with a browser that is still exiting. */
  private launches = 0;
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
        // A final, non-redirect response for the main frame: the page this navigation is loading.
        const mainResponse = page
          .waitForResponse((r) => r.request().isNavigationRequest() && r.request().frame() === page.mainFrame() && (r.status() < 300 || r.status() >= 400), { timeout: timeoutMs })
          .catch(() => null);
        try {
          response = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
          await page.waitForLoadState('load', { timeout: timeoutMs }).catch(() => undefined);
          break;
        } catch (e) {
          const msg = (e as Error).message;
          if (!/interrupted by another navigation/i.test(msg)) throw e;
          // Another navigation (the app's own, or a late one from before) replaced ours. Let it settle and start again:
          // a response alone does not mean its page is showing yet, and returning then left the old page in place.
          await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
          if (attempt < 2) continue;
          // An app that keeps navigating as it loads: settle for the page our request produced, once it has loaded.
          const seen = await Promise.race([mainResponse, new Promise<null>((r) => setTimeout(() => r(null), 3_000))]);
          if (!seen) throw e;
          await page.waitForURL(seen.url(), { waitUntil: 'load', timeout: 10_000 }).catch(() => undefined);
          response = seen;
          break;
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      await this.reset(page);
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
      await this.reset(page);
      throw new Error(`The page redirected to ${finalUrl}, which is outside the allowed local hosts, so it was closed.`);
    }
    return { status: response?.status(), url: finalUrl, title: await page.title().catch(() => '') };
  }

  /** Leaves the page on about:blank after a failed or refused navigation. Chrome commits its error page only after it
   * reports the failure, and that late commit can interrupt this navigation while leaving it pending, to replace the
   * next page the agent opens. So check where the page really is, and try again. */
  private async reset(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto('about:blank', { waitUntil: 'load', timeout: 10_000 }).catch(() => undefined);
      if (page.url() === 'about:blank') return;
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => undefined);
    }
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
    this.starting = undefined;
    await this.teardown();
    // On Windows a browser that is still exiting keeps its profile files open; keep trying for a few seconds more.
    // Anything still left is removed at a later startup.
    await rm(this.opts.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  }

  /** Closes the browser and its proxy and deletes the profile. A browser that does not close in time is left behind:
   * the next one gets a profile folder of its own, so it never waits for the old one's lock. */
  private async teardown(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.contextAlive = false;
    this.page = undefined;
    if (ctx) await within(ctx.close(), CLOSE_TIMEOUT_MS, 'Closing the browser').catch(() => undefined);
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
    this.starting ??= this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** The page can close (window.close() in the app, a crashed tab) while the browser runs on; the browser can exit too. */
  private async open(): Promise<Page> {
    if (this.context && this.contextAlive) {
      try {
        return this.watch(await within(this.context.newPage(), NEW_PAGE_TIMEOUT_MS, 'Opening a new tab'));
      } catch {
        // The browser is exiting or stopped responding (Playwright's newPage has no timeout of its own): start a new one.
      }
    }
    await this.teardown();
    return this.launch();
  }

  private async launch(): Promise<Page> {
    const pw = await (this.opts.loadPlaywright ?? (() => import('playwright-core')))();
    await rm(this.opts.profileDir, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(this.opts.profileDir, { recursive: true });
    const channels = this.opts.channel === 'auto' ? ['chrome', 'msedge'] : [this.opts.channel];
    this.proxy = new BlackholeProxy();
    const port = await this.proxy.start();
    const proxy = { server: `http://127.0.0.1:${port}`, bypass: ['localhost', '127.0.0.1', '[::1]', ...this.opts.extraHosts].join(',') };
    const failures: string[] = [];
    for (const channel of channels) {
      try {
        this.context = await pw.chromium.launchPersistentContext(path.join(this.opts.profileDir, `${channel}-${++this.launches}`), {
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
        this.contextAlive = true;
        const ctx = this.context;
        ctx.on('close', () => {
          if (this.context === ctx) this.contextAlive = false;
        });
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
    return this.watch(this.context.pages()[0] ?? (await this.context.newPage()));
  }

  /** Makes `page` the current page and collects its logs. Request blocking is set on the browser, so it covers every page. */
  private watch(page: Page): Page {
    this.page = page;
    page.on('console', (m) => pushCapped(this.logs.console, `[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => pushCapped(this.logs.errors, e.message));
    page.on('requestfailed', (r) => {
      const reason = r.failure()?.errorText ?? 'failed';
      if (!/ERR_BLOCKED_BY_CLIENT/.test(reason)) pushCapped(this.logs.failed, `${r.method()} ${r.url()} — ${reason}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400) pushCapped(this.logs.failed, `${r.request().method()} ${r.url()} — HTTP ${r.status()}`);
    });
    return page;
  }
}
