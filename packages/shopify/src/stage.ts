import type { Logger, Recipe, SectionIR, ThemeProfile, ValidationIssue, Workspace } from '@sf/core';
import { escapeHtml, slugify } from '@sf/core';
import { openPage, serveDir } from '@sf/crawler';
import { analyzeTheme } from './theme/analyze.ts';
import { GENERIC_PROFILE } from './theme/profiles.ts';
import { generateSection, type GeneratedSection } from './liquid/generate.ts';
import { validateSectionFile } from './liquid/validate.ts';
import { renderSectionPreview } from './preview/render.ts';
import { diffPng } from './preview/diff.ts';

export interface ShopifyReportEntry {
  key: string;
  handle: string;
  files: string[];
  settings: number;
  blockTypes: string[];
  presetBlocks: number;
  issues: ValidationIssue[];
  /** Pixel difference between the HTML clone and the rendered Liquid (desktop, default mode) */
  visualDiff?: number;
}

export interface ShopifyReport {
  profile: { name: string; adapter: string; cssStrategy: string; rootFontSize: number; hazards: string[] };
  outDir: string;
  sections: ShopifyReportEntry[];
}

/**
 * Generates theme files for every converted section against a theme profile,
 * validates them, renders the Liquid in a Shopify-like runtime and diffs it against the clone.
 */
export async function buildShopify(
  ws: Workspace,
  recipe: Recipe,
  log: Logger,
  opts: { themeDir?: string; sections: SectionIR[]; background: Record<string, string> },
): Promise<ShopifyReport> {
  const profile: ThemeProfile = opts.themeDir ? await analyzeTheme(opts.themeDir) : GENERIC_PROFILE;
  const slug = slugify(profile.name) || 'theme';
  const base = `shopify/${slug}`;
  await ws.clean(base);
  await ws.writeJson(`${base}/profile.json`, profile);
  log.info(`profile "${profile.name}" → adapter ${profile.adapter}, css ${profile.css.strategy}, root ${profile.css.rootFontSize}px`);

  const entries: ShopifyReportEntry[] = [];
  const generated: { ir: SectionIR; theme: GeneratedSection; single: GeneratedSection }[] = [];
  for (const ir of opts.sections) {
    const theme = generateSection(ir, { profile, cssMode: 'auto' });
    const single = generateSection(ir, { profile, cssMode: 'single-file' });
    for (const f of theme.files) await ws.write(`${base}/theme/${f.path}`, f.content);
    await ws.write(`${base}/single-file/${single.handle}.liquid`, single.files[0].content);
    for (const a of theme.assets) await ws.copyIn(ws.path('snapshot', a.from), `${base}/theme/assets/${a.to}`);
    const issues = [
      ...theme.files.filter((f) => f.path.endsWith('.liquid')).flatMap((f) => validateSectionFile(f.path, String(f.content))),
      ...validateSectionFile(`single-file/${single.handle}.liquid`, String(single.files[0].content)),
    ];
    for (const i of issues) (i.level === 'error' ? log.warn : log.info)(`${i.level}: ${i.file}: ${i.message}`);
    entries.push({
      key: ir.key,
      handle: theme.handle,
      files: [...theme.files.map((f) => f.path), ...theme.assets.map((a) => `assets/${a.to}`)],
      settings: theme.schema.settings.filter((s) => s.id).length,
      blockTypes: (theme.schema.blocks ?? []).map((b) => b.type),
      presetBlocks: theme.schema.presets?.[0]?.blocks?.length ?? 0,
      issues,
    });
    generated.push({ ir, theme, single });
  }

  // ---- render Liquid previews and diff them against the HTML clone ------------------------
  for (const { ir, single } of generated) {
    const rendered = await renderSectionPreview(String(single.files[0].content), { assetUrl: (n) => `../theme/assets/${n}` });
    const modes = ir.modes;
    const bg = modes ? opts.background[modes.default] : Object.values(opts.background)[0];
    const doc = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ir.name)} — Liquid preview</title>
<style>html,body{margin:0}html{background:${bg ?? 'transparent'}}</style>
${rendered.css.map((c) => `<style>${c}</style>`).join('\n')}
</head><body>
${rendered.html}
${rendered.js.map((j) => `<script>${j}</script>`).join('\n')}
</body></html>`;
    await ws.write(`${base}/preview/${single.handle}.html`, doc);
  }
  const server = await serveDir(ws.root);
  try {
    for (const { ir, single } of generated) {
      const shots: string[] = [];
      for (const [i, url] of [`sections/${ir.key}/preview.html`, `${base}/preview/${single.handle}.html`].entries()) {
        const { page, context } = await openPage(server.url + url, { width: recipe.viewports?.desktop ?? 1440, allowOrigins: [server.origin] });
        // addStyleTag never resolves with JavaScript disabled; inject through evaluate instead.
        await page.evaluate((css) => {
          const st = document.createElement('style');
          st.textContent = css;
          document.head.appendChild(st);
        }, '*,*::before,*::after{animation:none!important;transition:none!important}.sf-mode-switch{display:none!important}');
        await page.waitForTimeout(200);
        const path = ws.path(`${base}/preview/${single.handle}.${i === 0 ? 'clone' : 'liquid'}.png`);
        await page.screenshot({ path, fullPage: true });
        shots.push(path);
        await context.close();
      }
      const d = await diffPng(shots[0], shots[1], ws.path(`${base}/preview/${single.handle}.diff.png`));
      const entry = entries.find((e) => e.key === ir.key)!;
      entry.visualDiff = Number(d.ratio.toFixed(4));
      log.info(`${single.handle}: liquid vs clone pixel diff ${(d.ratio * 100).toFixed(2)}%`);
    }
  } finally {
    await server.close();
  }

  const report: ShopifyReport = {
    profile: { name: profile.name, adapter: profile.adapter, cssStrategy: profile.css.strategy, rootFontSize: profile.css.rootFontSize, hazards: profile.hazards },
    outDir: ws.path(base),
    sections: entries,
  };
  await ws.writeJson(`${base}/report.json`, report);
  await ws.write(`${base}/README.md`, installReadme(report, profile));
  const errors = entries.flatMap((e) => e.issues).filter((i) => i.level === 'error').length;
  log.info(`shopify: ${entries.length} sections, ${errors} validation errors → ${ws.rel(ws.path(base))}`);
  return report;
}

function installReadme(report: ShopifyReport, profile: ThemeProfile): string {
  const rows = report.sections
    .map((s) => `| \`sections/${s.handle}.liquid\` | ${s.settings} | ${s.blockTypes.join(', ') || '—'} | ${s.presetBlocks} | ${s.issues.filter((i) => i.level === 'error').length} | ${s.visualDiff !== undefined ? (s.visualDiff * 100).toFixed(2) + '%' : '—'} |`)
    .join('\n');
  return `# Shopify sections — ${profile.name}

Generated against the **${profile.name}** theme profile (adapter \`${profile.adapter}\`, CSS strategy \`${profile.css.strategy}\`).

## Install

**Whole set:** copy \`theme/sections/*\` and \`theme/assets/*\` into your theme (or \`shopify theme push --only sections/dtl-* --only assets/dtl-* --only assets/section-dtl-*\`).

**One section:** copy \`single-file/<handle>.liquid\` into \`sections/\`. CSS and JS are inlined with \`{% stylesheet %}\` / \`{% javascript %}\`.
Demo images used as fallbacks live in \`theme/assets/\` (copy the ones the section references, or pick your own images in the editor).

Then: Online Store → Themes → Customize → Add section.

| File | Settings | Block types | Preset blocks | Errors | Liquid vs clone diff |
|---|---|---|---|---|---|
${rows}

## Notes

- Every section ships a **Style source** setting: *Original design* keeps the cloned look; *Match theme* re-points the section's colour/font tokens at the theme's colour scheme and fonts${profile.section.colorScheme ? ' (uses the section\'s colour scheme setting)' : ''}.
- **Colour mode** switches between the source's light and dark palettes.
- Padding settings are copied from the theme so spacing controls feel native (defaults are 0 to keep the original spacing).
- Links pointing to the source site are not set as defaults (Shopify only allows \`/collections\` defaults); set them in the editor.
`;
}
