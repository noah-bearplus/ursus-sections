import type { Logger, Recipe, SectionIR, Workspace } from '@sf/core';
import { openPage, serveDir } from '@sf/crawler';

export interface SectionThumb {
  /** Workspace-relative image path */
  file: string;
  /** Size in CSS pixels (the image itself is `scale` times larger) */
  width: number;
  height: number;
  scale: number;
}

export interface ThumbOptions {
  /** Device pixel ratio of the image (2 stays sharp on retina screens). */
  scale?: number;
  /** Tall sections are cut at this many CSS pixels. */
  maxHeight?: number;
}

/**
 * Gallery thumbnails: each section cropped to its own box in the desktop clone,
 * so a 56px header becomes a 56px-tall strip instead of a mostly empty 900px canvas.
 */
export async function captureThumbnails(
  ws: Workspace,
  recipe: Recipe,
  sections: SectionIR[],
  log: Logger,
  opts: ThumbOptions = {},
): Promise<Record<string, SectionThumb>> {
  const scale = opts.scale ?? 2;
  const maxHeight = opts.maxHeight ?? 900;
  const server = await serveDir(ws.root);
  const out: Record<string, SectionThumb> = {};
  try {
    const { page, context } = await openPage(`${server.url}clone/index.html`, {
      width: recipe.viewports?.desktop ?? 1440,
      scale,
      allowOrigins: [server.origin],
    });
    await page.evaluate(() => {
      const st = document.createElement('style');
      st.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}.sf-mode-switch{display:none!important}';
      document.head.appendChild(st);
      // Sticky/fixed headers would be captured on top of whatever section is being shot.
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const pos = getComputedStyle(el).position;
        if (pos === 'fixed' || pos === 'sticky') (el as HTMLElement).style.setProperty('position', 'relative', 'important');
      }
    });
    for (const s of sections) {
      const box = await page.evaluate((cls) => {
        const el = document.querySelector(`.${cls}`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
      }, s.rootClass);
      if (!box || box.width < 1 || box.height < 1) {
        log.warn(`${s.key}: no thumbnail (section not visible)`);
        continue;
      }
      const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(Math.min(box.height, maxHeight)) };
      const file = `sections/${s.key}/thumb.jpg`;
      await page.screenshot({ path: ws.path(file), clip, fullPage: true, type: 'jpeg', quality: 82 });
      out[s.key] = { file, width: clip.width, height: clip.height, scale };
    }
    await context.close();
  } finally {
    await server.close();
  }
  await ws.writeJson('sections/thumbs.json', out);
  return out;
}
