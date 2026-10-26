import { createRequire } from 'node:module';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const require = createRequire(import.meta.url);

/**
 * Playwright is an optional peer: use the project's copy when installed,
 * otherwise fall back to a machine-wide install (CI images, cloud sandboxes).
 */
function loadPlaywright(): typeof import('playwright-core') {
  const candidates = [
    'playwright',
    'playwright-core',
    process.env.SF_PLAYWRIGHT_PATH,
    '/opt/node-tools/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
    '/usr/local/lib/node_modules/playwright',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('Playwright not found. Run `npm i -D playwright && npx playwright install chromium`, or set SF_PLAYWRIGHT_PATH.');
}

let shared: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!shared) shared = loadPlaywright().chromium.launch();
  return shared;
}

export async function closeBrowser(): Promise<void> {
  if (shared) {
    const b = await shared;
    shared = null;
    await b.close();
  }
}

export interface OpenPageOptions {
  width: number;
  height?: number;
  javaScript?: boolean;
  colorScheme?: 'light' | 'dark';
  /** Device pixel ratio (default 1, so screenshots map 1:1 to CSS pixels). */
  scale?: number;
  /** Only allow requests to these origins (everything else is aborted). */
  allowOrigins?: string[];
}

export async function openPage(url: string, opts: OpenPageOptions): Promise<{ page: Page; context: BrowserContext }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: opts.width, height: opts.height ?? 900 },
    javaScriptEnabled: opts.javaScript ?? false,
    colorScheme: opts.colorScheme ?? 'light',
    deviceScaleFactor: opts.scale ?? 1,
  });
  const page = await context.newPage();
  if (opts.allowOrigins) {
    const allow = opts.allowOrigins;
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('data:') || allow.some((o) => u.startsWith(o))) return route.continue();
      return route.abort();
    });
  }
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  // tsx/esbuild wraps named functions with __name(); functions we pass to evaluate() need it in the page.
  await page.evaluate('window.__name = window.__name || ((f) => f)');
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  return { page, context };
}
