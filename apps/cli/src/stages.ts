import { stat } from 'node:fs/promises';
import { Pipeline, sha1, type StageDef } from '@sf/core';
import { buildSnapshot, captureSnapshot, rawFromSavedPage, rawFromUrl } from '@sf/crawler';
import { extractDesignTokens, renderStyleguide, tokensToCss } from '@sf/design';
import type { DesignTokens, SectionIR } from '@sf/core';
import { captureVerification, convertSections, renderDocument, type ConvertResult } from '@sf/converter';
import { buildShopify, diffPng } from '@sf/shopify';

async function fileKey(path?: string): Promise<string> {
  if (!path) return '';
  const st = await stat(path).catch(() => null);
  return st ? `${path}:${st.size}:${st.mtimeMs}` : path;
}

export function buildPipeline(): Pipeline {
  const stages: StageDef[] = [
    {
      name: 'ingest',
      dependsOn: [],
      outputs: ['snapshot/snapshot.json', 'snapshot/page.html'],
      cacheKey: async ({ recipe }) =>
        sha1((await fileKey(recipe.source.savedHtml)) + (await fileKey(recipe.source.savedAssetsDir))),
      run: async ({ ws, recipe, log }) => {
        const raw = recipe.source.savedHtml
          ? await rawFromSavedPage(recipe.source.savedHtml, recipe.source.savedAssetsDir, recipe.source.url)
          : await rawFromUrl(recipe.source.url!, { cacheDir: ws.path('.cache', 'responses'), log });
        await buildSnapshot(ws, recipe, raw, log);
      },
    },
    {
      name: 'capture',
      dependsOn: ['ingest'],
      outputs: ['snapshot/screenshots/index.json'],
      run: async ({ ws, recipe, log }) => {
        await captureSnapshot(ws, recipe, log);
      },
    },
    {
      name: 'design',
      dependsOn: ['ingest'],
      outputs: ['design/tokens.json', 'design/tokens.css', 'design/styleguide.html'],
      run: async ({ ws, recipe, log }) => {
        const design = await extractDesignTokens(ws, recipe, log);
        await ws.writeJson('design/tokens.json', design);
        await ws.write('design/tokens.css', tokensToCss(design, { modeAttribute: recipe.modes?.attribute ?? null }));
        await writeStyleguide(ws, recipe, design);
      },
    },
    {
      name: 'convert',
      dependsOn: ['ingest', 'design'],
      outputs: ['sections/index.json'],
      cacheKey: () => sourceVersion(),
      run: async ({ ws, recipe, log }) => {
        await ws.clean('sections');
        await convertSections(ws, recipe, log);
      },
    },
    {
      name: 'clone',
      dependsOn: ['convert'],
      outputs: ['clone/index.html'],
      cacheKey: () => sourceVersion(),
      run: async ({ ws, recipe, log }) => {
        const { sections, page } = await loadSections(ws);
        await ws.clean('clone');
        // Full-page clone with its own copy of the assets it uses.
        const used = new Set(sections.flatMap((s) => s.assets.concat(collectImageDefaults(s))));
        for (const a of used) await ws.copyIn(ws.path('snapshot', a), `clone/${a}`);
        await ws.write(
          'clone/index.html',
          renderDocument(sections, { title: `${recipe.name} — clone`, assetUrl: (p) => p, background: page.background, modeSwitch: true }),
        );
        // One preview document per section.
        for (const s of sections) {
          await ws.write(
            `sections/${s.key}/preview.html`,
            renderDocument([s], { title: s.name, assetUrl: (p) => `../../snapshot/${p}`, background: page.background, modeSwitch: true }),
          );
        }
        // Styleguide gets live component previews of every section.
        const design = await ws.readJson<DesignTokens>('design', 'tokens.json');
        await writeStyleguide(
          ws,
          recipe,
          design,
          sections.map((s) => ({
            name: `${s.name} — ${s.category}`,
            // srcdoc iframes resolve relative URLs against the styleguide's own location (design/).
            html: renderDocument([s], { title: s.name, assetUrl: (p) => `../snapshot/${p}`, background: page.background }),
            height: s.category === 'grid' ? 900 : s.category === 'header' || s.category === 'filter' ? 140 : 620,
          })),
        );
        log.info(`clone: ${sections.length} sections, ${used.size} assets`);
      },
    },
    {
      name: 'verify',
      dependsOn: ['clone'],
      outputs: ['verify/report.json'],
      cacheKey: () => sourceVersion(),
      run: async ({ ws, recipe, log }) => {
        const { sections } = await loadSections(ws);
        await ws.clean('verify');
        const shots = await captureVerification(ws, recipe, sections, log);
        const rows = [];
        for (const s of shots) {
          const d = await diffPng(ws.path(s.original), ws.path(s.clone), ws.path(s.clone.replace('.clone.png', '.diff.png')));
          const dh = Math.round(s.size.clone[1] - s.size.original[1]);
          rows.push({ section: s.key, viewport: s.viewport, diff: Number(d.ratio.toFixed(4)), heightDelta: dh, size: s.size });
          log.info(`${s.key.padEnd(8)} ${s.viewport.padEnd(7)} pixel diff ${(d.ratio * 100).toFixed(2).padStart(6)}%  height Δ ${dh}px`);
        }
        await ws.writeJson('verify/report.json', rows);
      },
    },
    {
      name: 'shopify',
      dependsOn: ['clone'],
      outputs: [],
      options: ['themeDir'],
      cacheKey: () => sourceVersion(),
      run: async ({ ws, recipe, log, options }) => {
        const { sections, page } = await loadSections(ws);
        await buildShopify(ws, recipe, log, { themeDir: options.themeDir, sections, background: page.background });
      },
    },
  ];
  return new Pipeline(stages);
}

async function writeStyleguide(
  ws: import('@sf/core').Workspace,
  recipe: import('@sf/core').Recipe,
  design: DesignTokens,
  components: import('@sf/design').StyleguideComponent[] = [],
): Promise<void> {
  const html = renderStyleguide(design, {
    title: recipe.name,
    sourceUrl: design.source,
    modeAttribute: recipe.modes?.attribute,
    components,
  });
  await ws.write('design/styleguide.html', html);
}

/** Changes to converter code should invalidate cached conversions during development. */
async function sourceVersion(): Promise<string> {
  const { readdir, stat: st } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages');
  const parts: string[] = [];
  for (const pkg of await readdir(root)) {
    const dir = join(root, pkg, 'src');
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const s = await st(join(dir, f));
      parts.push(`${pkg}/${f}:${s.size}:${s.mtimeMs}`);
    }
  }
  return sha1(parts.join('|'));
}

async function loadSections(ws: import('@sf/core').Workspace): Promise<ConvertResult> {
  const index = await ws.readJson<{ sections: string[]; page: ConvertResult['page'] }>('sections', 'index.json');
  const sections: SectionIR[] = [];
  for (const k of index.sections) sections.push(await ws.readJson<SectionIR>('sections', k, 'ir.json'));
  return { sections, page: index.page };
}

function collectImageDefaults(s: SectionIR): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('assets/')) out.push(v);
  };
  for (const f of s.fields) add(f.default);
  for (const r of s.repeaters) for (const item of r.items) Object.values(item).forEach(add);
  return out;
}
