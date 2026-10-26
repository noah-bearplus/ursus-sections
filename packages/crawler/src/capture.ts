import type { Logger, Recipe, Snapshot, Workspace } from '@sf/core';
import { openPage } from './browser.ts';
import { serveDir } from './server.ts';

/**
 * CSS applied before every capture so the whole document scrolls as one page
 * (app shells often scroll an inner <main>), and entrance animations are settled.
 */
export const BASE_CAPTURE_CSS = `
*, *::before, *::after { animation-play-state: paused !important; animation-delay: -10s !important; caret-color: transparent !important; }
`;

export interface CaptureResult {
  screenshots: { mode: string; viewport: 'desktop' | 'mobile'; path: string; height: number }[];
  rootFontSize: number;
}

export async function prepareCapturePage(
  page: import('playwright-core').Page,
  recipe: Recipe,
  mode?: string,
): Promise<void> {
  await page.evaluate(
    ({ css, mode, modes, htmlAttrs }) => {
      const st = document.createElement('style');
      st.setAttribute('data-sf-capture', '');
      st.textContent = css;
      document.head.appendChild(st);
      if (modes && mode) document.querySelector(modes.selector)?.setAttribute(modes.attribute, mode);
      for (const [k, v] of Object.entries(htmlAttrs)) {
        if (v === null) document.documentElement.removeAttribute(k);
        else document.documentElement.setAttribute(k, v);
      }
    },
    { css: BASE_CAPTURE_CSS + (recipe.captureCss ?? ''), mode, modes: recipe.modes ?? null, htmlAttrs: recipe.state?.htmlAttrs ?? {} },
  );
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await page.waitForTimeout(150);
}

/** Full-page reference screenshots of the snapshot, per viewport and colour mode. */
export async function captureSnapshot(ws: Workspace, recipe: Recipe, log: Logger): Promise<CaptureResult> {
  const snap = await ws.readJson<Snapshot>('snapshot', 'snapshot.json');
  const server = await serveDir(ws.path('snapshot'));
  const vps = recipe.viewports ?? { desktop: 1440, mobile: 390 };
  const modes = recipe.modes?.values ?? ['default'];
  const out: CaptureResult = { screenshots: [], rootFontSize: 16 };
  try {
    for (const mode of modes) {
      for (const [vp, width] of Object.entries(vps) as ['desktop' | 'mobile', number][]) {
        const { page, context } = await openPage(server.url + snap.htmlPath, {
          width,
          allowOrigins: [server.origin],
        });
        await prepareCapturePage(page, recipe, recipe.modes ? mode : undefined);
        if (vp === 'desktop') {
          out.rootFontSize = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
        }
        const path = `snapshot/screenshots/${mode}-${vp}.png`;
        await ws.ensureDir('snapshot', 'screenshots');
        await page.screenshot({ path: ws.path(path), fullPage: true });
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        out.screenshots.push({ mode, viewport: vp, path, height });
        await context.close();
      }
    }
  } finally {
    await server.close();
  }
  snap.rootFontSize = out.rootFontSize;
  await ws.writeJson('snapshot/snapshot.json', snap);
  await ws.writeJson('snapshot/screenshots/index.json', out);
  log.info(`captured ${out.screenshots.length} screenshots (root font-size ${out.rootFontSize}px)`);
  return out;
}
