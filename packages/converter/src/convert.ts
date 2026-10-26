import { readFile } from 'node:fs/promises';
import type { DesignTokens, Logger, Recipe, RecipeRepeater, RecipeSection, SectionIR, Snapshot, Workspace } from '@sf/core';
import { openPage, prepareCapturePage, serveDir } from '@sf/crawler';
import { flattenCss } from './css-collect.ts';
import { buildSectionCss } from './css-build.ts';
import { cleanSectionHtml } from './html-clean.ts';
import { pruneScopeClasses } from './prune-scope.ts';
import { buildTemplate } from './template.ts';
import { behaviorRoles, behaviorScript } from './behaviors.ts';
import { compoundsOf, DEFAULT_SCRUB, toTestSelector } from './selectors.ts';
import {
  hiddenElementIds,
  matchSelectors,
  prepareSectionDom,
  removeElements,
  serializeSection,
  type MatchResult,
  type TestSelector,
} from './section-capture.ts';
import { autoSegment } from './segment.ts';

export interface ConvertResult {
  sections: SectionIR[];
  page: { background: Record<string, string>; title: string };
}

/**
 * Converts every section of a snapshot into a SectionIR:
 * browser-verified CSS pruning + scoping, clean namespaced HTML, editable fields, repeaters, behaviours.
 */
export async function convertSections(ws: Workspace, recipe: Recipe, log: Logger): Promise<ConvertResult> {
  const snap = await ws.readJson<Snapshot>('snapshot', 'snapshot.json');
  const design = await ws.readJson<DesignTokens>('design', 'tokens.json');
  const sheets = await Promise.all(snap.stylesheets.map((s) => readFile(ws.path('snapshot', s.path), 'utf8')));
  const modeAttr = recipe.modes?.attribute ?? null;
  const flat = flattenCss(sheets, modeAttr ?? undefined);

  // Unique test selectors (bundles often contain the same rule several times).
  const selectorIndex = new Map<number, { ruleIdx: number; selector: string }>();
  const uniq = new Map<string, TestSelector>();
  const idsByTest = new Map<string, number[]>();
  let nextId = 0;
  for (const rule of flat.rules) {
    for (const sel of rule.selectors) {
      const test = toTestSelector(sel, { stripState: true, scrub: DEFAULT_SCRUB });
      if (!test) continue;
      const id = nextId++;
      selectorIndex.set(id, { ruleIdx: rule.idx, selector: sel });
      let t = uniq.get(test);
      if (!t) {
        const tc = compoundsOf(test);
        const oc = compoundsOf(sel);
        t = { id: uniq.size, test, compounds: tc.length === oc.length ? tc : [{ combinator: '', text: test }] };
        uniq.set(test, t);
      }
      idsByTest.set(test, [...(idsByTest.get(test) ?? []), id]);
    }
  }
  log.info(`${flat.rules.length} rules, ${selectorIndex.size} selectors (${uniq.size} unique tests), ${flat.keyframes.length} keyframes`);

  const server = await serveDir(ws.path('snapshot'));
  const vps = recipe.viewports ?? { desktop: 1440, mobile: 390 };
  const modes = recipe.modes?.values ?? ['default'];
  const defaultMode = recipe.modes?.default ?? modes[0];
  const out: SectionIR[] = [];
  const background: Record<string, string> = {};

  try {
    let sections = recipe.sections;
    {
      const { page, context } = await openPage(server.url + snap.htmlPath, { width: vps.desktop, allowOrigins: [server.origin] });
      for (const m of modes) {
        await prepareCapturePage(page, recipe, recipe.modes ? m : undefined);
        background[m] = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
      }
      if (!sections?.length) {
        await prepareCapturePage(page, recipe, recipe.modes ? defaultMode : undefined);
        sections = await autoSegment(page);
        log.info(`auto-segmented ${sections.length} sections: ${sections.map((s) => s.key).join(', ')}`);
        await ws.writeJson('sections/auto-segments.json', sections);
      }
      await context.close();
    }

    for (const section of sections!) {
      const t0 = Date.now();
      const { page, context } = await openPage(server.url + snap.htmlPath, { width: vps.desktop, allowOrigins: [server.origin] });
      await prepareCapturePage(page, recipe, recipe.modes ? defaultMode : undefined);
      const roles = behaviorRoles(section.behaviors ?? []);
      const prep = await prepareSectionDom(page, section, roles);
      const repeaters: RecipeRepeater[] = section.repeaters ?? prep.autoRepeaters.map((a) => ({ item: '', blockType: a.blockType, blockName: a.blockType.replace(/_/g, ' '), presetCount: Math.min(a.count, 12) }));

      // Elements hidden in every mode and viewport are dead weight (e.g. logged-in-only UI).
      let hidden = null as Set<string> | null;
      for (const m of modes) {
        for (const w of [vps.desktop, vps.mobile]) {
          await page.setViewportSize({ width: w, height: 900 });
          if (recipe.modes) await page.evaluate(({ s, a, v }) => document.querySelector(s)?.setAttribute(a, v), { s: recipe.modes.selector, a: recipe.modes.attribute, v: m });
          const ids = new Set(await hiddenElementIds(page, section.selector));
          hidden = hidden ? new Set([...hidden].filter((x: string) => ids.has(x))) : ids;
        }
      }
      await page.setViewportSize({ width: vps.desktop, height: 900 });
      if (recipe.modes) await page.evaluate(({ s, a, v }) => document.querySelector(s)?.setAttribute(a, v), { s: recipe.modes.selector, a: recipe.modes.attribute, v: defaultMode });
      const removedHidden = await removeElements(page, section.selector, [...(hidden ?? [])]);

      const raw = await matchSelectors(page, recipe, section, [...uniq.values()]);
      const match = expandMatches(raw, uniq, idsByTest);
      const captured = await serializeSection(page, section.selector);
      await context.close();

      const scope = `sf-${recipe.prefix}-${section.key}`;
      const css = buildSectionCss({
        flat,
        selectorIndex,
        match,
        prefix: recipe.prefix,
        scope: `.${scope}`,
        modeAttr,
        defaultMode,
        rootFontSize: snap.rootFontSize || 16,
        tokens: design,
      });
      const cleaned = cleanSectionHtml(captured.html, {
        prefix: recipe.prefix,
        scopeClass: scope,
        used: css.used,
        rootFontSize: snap.rootFontSize || 16,
      });
      const pruned = pruneScopeClasses(css.css, cleaned.html, recipe.prefix);
      css.css = pruned.css;
      const tpl = buildTemplate(pruned.html, { prefix: recipe.prefix, repeaters });

      const ir: SectionIR = {
        key: section.key,
        name: section.name,
        category: section.category,
        description: section.description,
        rootClass: scope,
        classPrefix: `${recipe.prefix}-`,
        template: tpl.template,
        css: css.css,
        js: behaviorScript(scope, section.behaviors ?? [], recipe.prefix),
        fields: tpl.fields,
        repeaters: tpl.repeaters,
        behaviors: (section.behaviors ?? []).map((b) => b.type),
        modes: recipe.modes ? { attribute: recipe.modes.attribute, values: modes, default: defaultMode } : null,
        assets: cleaned.assets,
        fonts: css.fonts.map((f) => f.family),
        layout: section.layout ?? 'full',
        source: { url: snap.meta.url, selector: section.selector },
        stats: { rulesKept: css.rulesKept, rulesTotal: css.rulesTotal, elements: captured.elementCount, cssBytes: Buffer.byteLength(css.css) },
      };
      out.push(ir);
      await ws.writeJson(`sections/${section.key}/ir.json`, ir);
      await ws.write(`sections/${section.key}/section.css`, ir.css);
      await ws.write(`sections/${section.key}/template.html`, ir.template);
      if (css.approximations.length) await ws.writeJson(`sections/${section.key}/approximations.json`, css.approximations);
      log.info(
        `${section.key}: ${captured.elementCount} el (−${removedHidden} hidden), ${css.rulesKept} rules, ${(ir.stats.cssBytes / 1024).toFixed(1)}KB css, ` +
          `${ir.fields.length} fields, ${ir.repeaters.map((r) => `${r.blockType}×${r.items.length}`).join(' ') || 'no repeaters'}` +
          `${css.approximations.length ? `, ${css.approximations.length} approx selectors` : ''} (${Date.now() - t0}ms)`,
      );
    }
  } finally {
    await server.close();
  }
  const result: ConvertResult = { sections: out, page: { background, title: snap.meta.title } };
  await ws.writeJson('sections/index.json', { sections: out.map((s) => s.key), page: result.page });
  return result;
}

/** Maps results for unique test selectors back onto every source selector id. */
function expandMatches(raw: MatchResult, uniq: Map<string, TestSelector>, idsByTest: Map<string, number[]>): MatchResult {
  const out: MatchResult = { placements: {}, ancestors: {}, ancestorCount: raw.ancestorCount };
  for (const [test, t] of uniq) {
    const ids = idsByTest.get(test) ?? [];
    const p = raw.placements[t.id];
    const a = raw.ancestors[t.id];
    for (const id of ids) {
      if (p) out.placements[id] = p;
      if (a) out.ancestors[id] = a;
    }
  }
  return out;
}

export type { RecipeSection };
