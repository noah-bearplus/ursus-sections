import { readFile } from 'node:fs/promises';
import type { SectionIR, Workspace } from '@sf/core';
import { escapeHtml } from '@sf/core';

export interface CatalogEntry {
  project: string;
  key: string;
  handle: string;
  name: string;
  category: string;
  description?: string;
  source: string;
  settings: number;
  blocks: string[];
  /** paths relative to the catalog root */
  preview: string;
  thumb?: string;
  liquid: string;
  liquidFile: string;
  diff?: number;
}

export interface CatalogInput {
  projects: { id: string; ws: Workspace; profileSlug: string }[];
}

/**
 * Builds a static, self-contained catalog site (gallery + per-section page with live preview,
 * settings overview and copyable Liquid). Mirrors what a hosted section library offers.
 */
export async function buildCatalog(out: Workspace, input: CatalogInput): Promise<CatalogEntry[]> {
  await out.clean('.');
  const entries: CatalogEntry[] = [];
  for (const p of input.projects) {
    const index = await p.ws.readJson<{ sections: string[] }>('sections', 'index.json');
    const report = await p.ws
      .readJson<{ sections: { key: string; handle: string; visualDiff?: number; blockTypes: string[]; settings: number }[] }>('shopify', p.profileSlug, 'report.json')
      .catch(() => null);
    // Copy assets the previews need, once per project.
    await out.copyIn(p.ws.path('snapshot', 'assets'), `${p.id}/snapshot/assets`);
    for (const key of index.sections) {
      const ir = await p.ws.readJson<SectionIR>('sections', key, 'ir.json');
      const r = report?.sections.find((s) => s.key === key);
      const handle = r?.handle ?? ir.rootClass.replace(/^sf-/, '');
      const liquidPath = p.ws.path('shopify', p.profileSlug, 'single-file', `${handle}.liquid`);
      const liquid = await readFile(liquidPath, 'utf8').catch(() => '');
      await out.copyIn(p.ws.path('sections', key, 'preview.html'), `${p.id}/sections/${key}/preview.html`);
      await out.write(`${p.id}/liquid/${handle}.liquid`, liquid);
      const thumbSrc = p.ws.path('shopify', p.profileSlug, 'preview', `${handle}.clone.png`);
      let thumb: string | undefined;
      try {
        await out.copyIn(thumbSrc, `${p.id}/thumbs/${handle}.png`);
        thumb = `${p.id}/thumbs/${handle}.png`;
      } catch {
        thumb = undefined;
      }
      entries.push({
        project: p.id,
        key,
        handle,
        name: ir.name,
        category: ir.category,
        description: ir.description,
        source: ir.source.url,
        settings: r?.settings ?? ir.fields.length,
        blocks: r?.blockTypes ?? ir.repeaters.map((x) => x.blockType),
        preview: `${p.id}/sections/${key}/preview.html`,
        thumb,
        liquid,
        liquidFile: `${p.id}/liquid/${handle}.liquid`,
        diff: r?.visualDiff,
      });
    }
  }
  await out.writeJson('catalog.json', entries.map(({ liquid: _l, ...e }) => e));
  await out.write('index.html', galleryPage(entries));
  for (const e of entries) await out.write(`${e.project}/${e.handle}.html`, detailPage(e));
  return entries;
}

const BASE_CSS = `
:root { --bg:#0c0a09; --panel:#151312; --panel-2:#1d1b19; --line:#2a2725; --text:#f5f5f4; --muted:#a6a09b; --accent:#f25500; color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Inter, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
.top { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 16px; padding: 14px 24px; background: color-mix(in srgb, var(--bg) 85%, transparent); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.brand { font-weight: 650; letter-spacing: -.01em; }
.brand span { color: var(--accent); }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 999px; background: var(--panel-2); border: 1px solid var(--line); font-size: 13px; cursor: pointer; color: var(--text); }
.pill[aria-pressed="true"] { background: var(--text); color: var(--bg); }
.wrap { max-width: 1400px; margin: 0 auto; padding: 0 24px 96px; }
`;

function galleryPage(entries: CatalogEntry[]): string {
  const cats = [...new Set(entries.map((e) => e.category))];
  const cards = entries
    .map(
      (e) => `<a class="card" href="${e.project}/${e.handle}.html" data-cat="${e.category}">
  <div class="thumb">${e.thumb ? `<img src="${e.thumb}" alt="" loading="lazy">` : ''}</div>
  <div class="meta"><div><strong>${escapeHtml(e.name)}</strong><span>${escapeHtml(e.category)} · ${e.settings} settings${e.blocks.length ? ` · ${e.blocks.join(', ')} blocks` : ''}</span></div><span class="tag">.liquid</span></div>
</a>`,
    )
    .join('\n');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Section Library</title>
<style>${BASE_CSS}
.hero { padding: 72px 0 32px; }
.hero h1 { font-size: clamp(36px, 6vw, 64px); line-height: 1.02; letter-spacing: -.03em; font-weight: 600; max-width: 16ch; }
.hero p { color: var(--muted); margin-top: 14px; max-width: 58ch; font-size: 17px; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 28px 0 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 12px; }
.card { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; transition: border-color .2s, transform .2s; }
.card:hover { border-color: #3d3936; transform: translateY(-2px); }
.thumb { aspect-ratio: 16 / 10; background: var(--panel-2); overflow: hidden; }
.thumb img { width: 100%; height: 100%; object-fit: cover; object-position: top center; display: block; }
.meta { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; }
.meta strong { display: block; font-weight: 560; }
.meta span { color: var(--muted); font-size: 13px; }
.tag { font: 12px ui-monospace, monospace; padding: 4px 8px; border-radius: 6px; background: var(--panel-2); border: 1px solid var(--line); color: var(--muted) !important; }
</style></head><body>
<header class="top"><a class="brand" href="index.html">section<span>forge</span></a><span style="color:var(--muted);font-size:13px">${entries.length} sections</span></header>
<main class="wrap">
  <section class="hero"><h1>Sections, ready for your theme.</h1><p>Every section is converted from a real design, scoped so it cannot clash with your theme, and generated as Liquid that follows your theme's own conventions. Preview it, then copy one file.</p></section>
  <div class="filters"><button class="pill" aria-pressed="true" data-filter="all">All</button>${cats.map((c) => `<button class="pill" aria-pressed="false" data-filter="${c}">${escapeHtml(c)}</button>`).join('')}</div>
  <div class="grid">${cards}</div>
</main>
<script>
document.querySelectorAll('[data-filter]').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    var f = b.dataset.filter;
    document.querySelectorAll('.card').forEach(function (c) { c.style.display = f === 'all' || c.dataset.cat === f ? '' : 'none'; });
  });
});
</script>
</body></html>`;
}

function detailPage(e: CatalogEntry): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(e.name)} — Section Library</title>
<style>${BASE_CSS}
.head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: end; gap: 16px; padding: 40px 0 20px; }
.head h1 { font-size: 34px; letter-spacing: -.02em; font-weight: 600; }
.head p { color: var(--muted); max-width: 60ch; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; height: 38px; padding: 0 16px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel-2); color: var(--text); font: inherit; font-size: 14px; cursor: pointer; }
.btn--primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.stage { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; background: var(--panel); }
.bar { display: flex; gap: 6px; padding: 10px; border-bottom: 1px solid var(--line); align-items: center; }
.bar .grow { flex: 1; }
.frame { display: flex; justify-content: center; background: repeating-conic-gradient(#141211 0 25%, #171514 0 50%) 0 0 / 16px 16px; }
iframe { display: block; width: 100%; height: 720px; border: 0; background: transparent; transition: width .3s; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin: 16px 0; }
.facts div { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
.facts b { display: block; font-size: 20px; }
.facts span { color: var(--muted); font-size: 12px; }
pre { margin-top: 16px; max-height: 560px; overflow: auto; background: #0f0d0c; border: 1px solid var(--line); border-radius: 16px; padding: 18px; font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: #e7e5e4; white-space: pre; }
@media (max-width: 700px) { iframe { height: 560px; } }
</style></head><body>
<header class="top"><a class="brand" href="../index.html">section<span>forge</span></a><span style="color:var(--muted);font-size:13px">/ ${escapeHtml(e.category)} / ${escapeHtml(e.handle)}</span></header>
<main class="wrap">
  <div class="head"><div><h1>${escapeHtml(e.name)}</h1><p>${escapeHtml(e.description ?? '')}</p></div>
    <div class="actions"><button class="btn btn--primary" id="copy">Copy Liquid</button><a class="btn" download="${e.handle}.liquid" href="liquid/${e.handle}.liquid">Download .liquid</a></div></div>
  <div class="stage">
    <div class="bar"><button class="pill" aria-pressed="true" data-w="100%">Desktop</button><button class="pill" aria-pressed="false" data-w="820px">Tablet</button><button class="pill" aria-pressed="false" data-w="390px">Mobile</button><span class="grow"></span><a class="pill" href="sections/${e.key}/preview.html" target="_blank" rel="noopener">Open preview ↗</a></div>
    <div class="frame"><iframe src="sections/${e.key}/preview.html" title="${escapeHtml(e.name)} preview"></iframe></div>
  </div>
  <div class="facts"><div><b>${e.settings}</b><span>settings</span></div><div><b>${e.blocks.length ? escapeHtml(e.blocks.join(', ')) : '—'}</b><span>block types</span></div><div><b>${e.diff !== undefined ? (e.diff * 100).toFixed(2) + '%' : '—'}</b><span>Liquid vs clone pixel diff</span></div><div><b>1 file</b><span>CSS + JS inlined</span></div></div>
  <pre id="code">${escapeHtml(e.liquid)}</pre>
</main>
<script>
document.querySelectorAll('[data-w]').forEach(function (b) {
  b.addEventListener('click', function () {
    document.querySelectorAll('[data-w]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    document.querySelector('iframe').style.width = b.dataset.w;
  });
});
document.getElementById('copy').addEventListener('click', function (ev) {
  var text = document.getElementById('code').textContent;
  var done = function () { ev.target.textContent = 'Copied ✓'; setTimeout(function () { ev.target.textContent = 'Copy Liquid'; }, 1600); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done); else done();
});
</script>
</body></html>`;
}
