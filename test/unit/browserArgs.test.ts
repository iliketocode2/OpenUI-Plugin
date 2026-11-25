import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { disabledFeatures } from '../../src/browser/session';

/** The features the installed Playwright disables, read from its own source, where they are listed one per line. */
function playwrightDisabledFeatures(): string[] {
  const bundle = readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'playwright-core', 'lib', 'coreBundle.js'), 'utf8');
  const start = bundle.indexOf('disabledFeatures = [');
  if (start === -1) throw new Error('Playwright no longer declares disabledFeatures; check how it builds --disable-features now.');
  const list = bundle.slice(start, bundle.indexOf('];', start));
  return [...list.matchAll(/^\s*"([A-Za-z0-9]+)",?\s*$/gm)].map((m) => m[1]!);
}

describe('browser launch flags', () => {
  // Chrome keeps only the last --disable-features it is given, and ours comes after Playwright's. A feature Playwright
  // disables that is missing from ours is turned back on; without AvoidUnnecessaryBeforeUnloadCheckSync, page.close()
  // hangs (playwright#14047).
  it("keeps every feature the installed Playwright disables in the browser's one --disable-features list", () => {
    const playwright = playwrightDisabledFeatures();
    expect(playwright.length).toBeGreaterThan(5);
    expect(playwright).toContain('AvoidUnnecessaryBeforeUnloadCheckSync');
    const missing = playwright.filter((f) => !disabledFeatures().includes(f));
    expect(missing, 'add these to PLAYWRIGHT_DISABLED_FEATURES in src/browser/session.ts').toEqual([]);
  });
});
