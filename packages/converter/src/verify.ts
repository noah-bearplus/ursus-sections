import type { Logger, Recipe, SectionIR, Snapshot, Workspace } from '@sf/core';
import { openPage, prepareCapturePage, serveDir } from '@sf/crawler';

export interface VerifyShot {
  key: string;
  viewport: 'desktop' | 'mobile';
  original: string;
  clone: string;
  size: { original: [number, number]; clone: [number, number] };
}

/**
 * Screenshots every section in the original snapshot and in the clone (same viewport, same
 * colour mode) so a diff step can score fidelity per section.
 */
export async function captureVerification(ws: Workspace, recipe: Recipe, sections: SectionIR[], log: Logger): Promise<VerifyShot[]> {
  const snap = await ws.readJson<Snapshot>('snapshot', 'snapshot.json');
  const server = await serveDir(ws.root);
  const vps = recipe.viewports ?? { desktop: 1440, mobile: 390 };
  const shots: VerifyShot[] = [];
  const freeze = '*,*::before,*::after{animation:none!important;transition:none!important}.sf-mode-switch{display:none!important}';
  try {
    for (const [vp, width] of Object.entries(vps) as ['desktop' | 'mobile', number][]) {
      const orig = await openPage(`${server.url}snapshot/${snap.htmlPath}`, { width, allowOrigins: [server.origin] });
      await prepareCapturePage(orig.page, recipe, recipe.modes?.default);
      const clone = await openPage(`${server.url}clone/index.html`, { width, allowOrigins: [server.origin] });
      for (const p of [orig.page, clone.page]) {
        await p.evaluate((css) => {
          const st = document.createElement('style');
          st.textContent = css;
          document.head.appendChild(st);
          // Fixed/sticky headers would be captured over other content: pin them in flow.
          for (const el of Array.from(document.querySelectorAll('body *'))) {
            const pos = getComputedStyle(el).position;
            if (pos === 'fixed' || pos === 'sticky') (el as HTMLElement).style.setProperty('position', 'relative', 'important');
          }
        }, freeze);
      }
      for (const s of sections) {
        const a = `verify/${s.key}.${vp}.original.png`;
        const b = `verify/${s.key}.${vp}.clone.png`;
        await ws.ensureDir('verify');
        const la = orig.page.locator(s.source.selector).first();
        const lb = clone.page.locator(`.${s.rootClass}`).first();
        try {
          const ba = await la.boundingBox();
          const bb = await lb.boundingBox();
          if (!ba || !bb || ba.height < 1 || bb.height < 1) throw new Error('not visible');
          await la.screenshot({ path: ws.path(a) });
          await lb.screenshot({ path: ws.path(b) });
          shots.push({ key: s.key, viewport: vp, original: a, clone: b, size: { original: [ba.width, ba.height], clone: [bb.width, bb.height] } });
        } catch (e) {
          log.warn(`${s.key}/${vp}: could not capture (${(e as Error).message.split('\n')[0]})`);
        }
      }
      await orig.context.close();
      await clone.context.close();
    }
  } finally {
    await server.close();
  }
  return shots;
}
