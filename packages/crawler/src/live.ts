import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha1 } from '@sf/core';
import type { Logger } from '@sf/core';
import { getBrowser } from './browser.ts';
import type { RawPage } from './ingest.ts';

export interface LiveCrawlOptions {
  width?: number;
  /** Where downloaded responses are cached (inside the workspace). */
  cacheDir: string;
  /** Max scroll steps to trigger lazy loading. */
  scrollSteps?: number;
  log: Logger;
}

/**
 * Renders a live URL with JS enabled, scrolls to trigger lazy content, records every
 * stylesheet/image/font/video response, and returns the hydrated DOM as a RawPage.
 */
export async function rawFromUrl(url: string, opts: LiveCrawlOptions): Promise<RawPage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });
  const page = await context.newPage();
  await mkdir(opts.cacheDir, { recursive: true });
  const files = new Map<string, string>();
  const writes: Promise<unknown>[] = [];

  page.on('response', (res) => {
    const type = res.request().resourceType();
    if (!['stylesheet', 'image', 'font', 'media'].includes(type) || !res.ok()) return;
    writes.push(
      res
        .body()
        .then(async (body) => {
          const file = join(opts.cacheDir, sha1(res.url()).slice(0, 16));
          await writeFile(file, body);
          files.set(res.url(), file);
        })
        .catch(() => undefined),
    );
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });
  const steps = opts.scrollSteps ?? 30;
  for (let i = 0; i < steps; i++) {
    const done = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      el.scrollBy(0, window.innerHeight * 0.9);
      return el.scrollTop + window.innerHeight >= el.scrollHeight - 2;
    });
    await page.waitForTimeout(250);
    if (done) break;
  }
  await page.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollTo(0, 0));
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // CSS-in-JS libraries insert rules through CSSOM; serialise them so the snapshot keeps them.
  await page.evaluate(() => {
    for (const style of Array.from(document.querySelectorAll('style'))) {
      const sheet = style.sheet;
      if (!sheet) continue;
      try {
        const text = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
        if (text.length > (style.textContent ?? '').length) style.textContent = text;
      } catch {
        /* cross-origin */
      }
    }
  });
  const html = await page.content();
  await Promise.all(writes);
  await context.close();
  opts.log.info(`crawled ${url}: ${files.size} resources cached`);

  return {
    html,
    baseUrl: url,
    via: 'live',
    async resolveLocal(ref, base) {
      try {
        const abs = new URL(ref, base).href;
        return files.get(abs) ?? null;
      } catch {
        return null;
      }
    },
  };
}
