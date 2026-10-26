import { readFile } from 'node:fs/promises';
import type { DesignTokens, Logger, Recipe, Snapshot, Token, TokenKind, TypeStyle, Workspace } from '@sf/core';
import { openPage, prepareCapturePage, serveDir } from '@sf/crawler';
import { collectBreakpoints, collectCustomProps, collectFontFaces, collectKeyframes, countVarUsage, parseCss } from './css.ts';

interface BrowserTokenInfo {
  name: string;
  value: string;
  kind: TokenKind;
  hex?: string;
}

/**
 * Builds the design-token set of a snapshot:
 *  1. statically parse every stylesheet for document-level custom properties,
 *  2. resolve/classify them in a real browser per colour mode (handles var(), color-mix(), lab()…),
 *  3. sample computed typography from visible text.
 */
export async function extractDesignTokens(ws: Workspace, recipe: Recipe, log: Logger): Promise<DesignTokens> {
  const snap = await ws.readJson<Snapshot>('snapshot', 'snapshot.json');
  const cssTexts = await Promise.all(snap.stylesheets.map((s) => readFile(ws.path('snapshot', s.path), 'utf8')));
  const roots = cssTexts.map((c, i) => parseCss(c, snap.stylesheets[i].path));

  const decls = collectCustomProps(roots, recipe.modes?.attribute).filter((d) => d.global);
  const names = [...new Set(decls.map((d) => d.name))];
  const usage = countVarUsage(cssTexts);
  const modes = recipe.modes?.values ?? ['base'];

  const server = await serveDir(ws.path('snapshot'));
  const perMode: Record<string, BrowserTokenInfo[]> = {};
  let typography: TypeStyle[] = [];
  try {
    for (const mode of modes) {
      const { page, context } = await openPage(server.url + snap.htmlPath, { width: recipe.viewports?.desktop ?? 1440, allowOrigins: [server.origin] });
      await prepareCapturePage(page, recipe, recipe.modes ? mode : undefined);
      perMode[mode] = await page.evaluate(resolveTokensInPage, names);
      if (mode === (recipe.modes?.default ?? modes[0])) typography = await page.evaluate(sampleTypography);
      await context.close();
    }
  } finally {
    await server.close();
  }

  const tokens: Token[] = names.map((name) => {
    const values: Record<string, string> = {};
    const resolved: Record<string, string> = {};
    const base = decls.find((d) => d.name === name && !d.mode && !d.media);
    if (base) values.base = base.value;
    for (const d of decls) if (d.name === name && d.mode && !d.media) values[d.mode] = d.value;
    let kind: TokenKind = 'other';
    for (const mode of modes) {
      const info = perMode[mode]?.find((t) => t.name === name);
      if (!info) continue;
      resolved[mode] = info.hex ?? info.value;
      if (kind === 'other') kind = info.kind;
    }
    return { name, kind: refineKind(name, kind), group: groupOf(name), values, resolved, usage: usage.get(name) ?? 0 };
  });

  const fonts = collectFontFaces(roots).map((f) => ({
    family: f.family,
    weight: f.weight,
    style: f.style,
    src: f.urls[0] ?? f.src,
    available: f.urls.some((u) => !/^https?:/.test(u)),
  }));

  const result: DesignTokens = {
    source: snap.meta.url,
    modes,
    defaultMode: recipe.modes?.default ?? modes[0],
    tokens: tokens.sort((a, b) => a.group.localeCompare(b.group) || b.usage - a.usage),
    typography,
    breakpoints: collectBreakpoints(roots)
      .filter((b) => b.count >= 2)
      .map((b) => b.px)
      .sort((a, b) => a - b),
    fonts,
    keyframes: collectKeyframes(roots),
  };
  const unavailable = fonts.filter((f) => !f.available).map((f) => f.family);
  if (unavailable.length) log.warn(`fonts not available offline (licensed or blocked): ${[...new Set(unavailable)].join(', ')}`);
  log.info(`${tokens.length} tokens (${tokens.filter((t) => t.kind === 'color').length} colours), ${typography.length} type styles`);
  return result;
}

function groupOf(name: string): string {
  const n = name.toLowerCase();
  if (/^(ease|elastic)|transition|duration|delay|stagger|page-entry|press/.test(n)) return 'motion';
  if (/radius|corner/.test(n)) return 'radius';
  if (/shadow/.test(n)) return 'elevation';
  if (/^font|^h\d|letter-spacing|line-height/.test(n)) return 'typography';
  if (/^surface|background|backdrop|floating|workspace/.test(n)) return 'surface';
  if (/^text|^on-/.test(n)) return 'text';
  if (/^border/.test(n)) return 'border';
  if (/accent|focus|status|destructive|error|success|warning/.test(n)) return 'accent';
  if (/scrollbar/.test(n)) return 'scrollbar';
  if (/width|height|size|gap|space|bottom|top|offset/.test(n)) return 'layout';
  return 'misc';
}

function refineKind(name: string, kind: TokenKind): TokenKind {
  const n = name.toLowerCase();
  if (n.includes('variation-settings')) return 'font-settings';
  if (/^font-(body|heading|hero|mono|display)$/.test(n) || n.endsWith('-family')) return 'font-family';
  if (n.includes('weight')) return 'font-weight';
  if (n.includes('letter-spacing')) return 'letter-spacing';
  if (n.includes('line-height')) return 'line-height';
  if (/^h\d-size|font-.*size/.test(n)) return 'font-size';
  if (n.includes('radius')) return 'radius';
  if (/delay|duration|stagger/.test(n) && kind !== 'easing') return 'duration';
  return kind;
}

/* ---------------- functions below run inside the page ---------------- */

function resolveTokensInPage(names: string[]): BrowserTokenInfo[] {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;width:1px;height:1px;left:-9999px;top:0';
  document.body.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const toHex = (color: string): string | undefined => {
    probe.style.color = '';
    probe.style.color = color;
    if (!probe.style.color) return undefined;
    const computed = getComputedStyle(probe).color;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const h = (n: number) => n.toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${a < 255 ? h(a) : ''}`;
  };
  const out: BrowserTokenInfo[] = [];
  for (const name of names) {
    const value = cs.getPropertyValue(`--${name}`).trim();
    if (!value) continue;
    let kind: TokenKind = 'other';
    let hex: string | undefined;
    if (/^-?[\d.]+$/.test(value)) kind = 'number';
    else if (CSS.supports('color', value) && !/^(inherit|initial|unset|currentcolor)$/i.test(value)) {
      kind = 'color';
      hex = toHex(value);
    } else if (/cubic-bezier|linear\(|steps\(|^ease/.test(value) && CSS.supports('transition-timing-function', value)) kind = 'easing';
    else if (CSS.supports('transition-duration', value)) kind = 'duration';
    else if (CSS.supports('box-shadow', value) && /px/.test(value) && /(rgb|hsl|#|lab|oklch)/.test(value)) kind = 'shadow';
    else if (CSS.supports('transition', value) && /\d(m?s)/.test(value)) kind = 'transition';
    else if (CSS.supports('width', value)) kind = 'size';
    else if (CSS.supports('font-family', value) && /["',]/.test(value)) kind = 'font-family';
    out.push({ name, value, kind, hex });
  }
  probe.remove();
  return out;
}

function sampleTypography(): TypeStyle[] {
  const groups = new Map<string, TypeStyle & { tags: Record<string, number> }>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) continue;
    const el = n.parentElement;
    if (!el || el.closest('script,style,template,svg,[hidden],[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    const key = [cs.fontFamily, cs.fontSize, cs.lineHeight, cs.fontWeight, cs.letterSpacing, cs.textTransform, cs.fontVariationSettings].join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        id: '',
        role: '',
        fontFamily: cs.fontFamily,
        fontSize: parseFloat(cs.fontSize),
        lineHeight: cs.lineHeight,
        fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing,
        fontVariationSettings: cs.fontVariationSettings !== 'normal' ? cs.fontVariationSettings : undefined,
        textTransform: cs.textTransform !== 'none' ? cs.textTransform : undefined,
        count: 0,
        sample: text.slice(0, 80),
        tags: {},
      };
      groups.set(key, g);
    }
    g.count += text.length;
    const tag = el.closest('h1,h2,h3,h4,h5,h6,button,a,label,p,li')?.tagName.toLowerCase() ?? el.tagName.toLowerCase();
    g.tags[tag] = (g.tags[tag] ?? 0) + 1;
  }
  // Merge groups that look identical (differences only in family fallbacks, transforms…).
  const merged = new Map<string, (typeof groups extends Map<string, infer V> ? V : never)>();
  for (const g of groups.values()) {
    const k = [g.fontSize, g.lineHeight, g.fontWeight, g.letterSpacing, g.fontVariationSettings].join('|');
    const m = merged.get(k);
    if (!m) merged.set(k, g);
    else {
      if (g.count > m.count) m.sample = g.sample;
      m.count += g.count;
      for (const [t, c] of Object.entries(g.tags)) m.tags[t] = (m.tags[t] ?? 0) + c;
    }
  }
  const list = [...merged.values()].filter((g) => g.count >= 6).sort((a, b) => b.fontSize - a.fontSize || b.count - a.count);
  const roleFor = (g: (typeof list)[number]) => {
    const tag = Object.entries(g.tags).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    if (g.fontSize >= 44) return 'display';
    if (/^h[1-3]$/.test(tag) || g.fontSize >= 28) return 'heading';
    if (g.fontSize >= 20) return 'title';
    if (tag === 'button' || tag === 'label') return 'ui';
    if (g.fontSize >= 15) return 'body';
    if (g.fontSize >= 13) return 'small';
    return 'caption';
  };
  const seen: Record<string, number> = {};
  return list.slice(0, 16).map(({ tags: _tags, ...g }) => {
    const role = roleFor({ ...g, tags: _tags });
    seen[role] = (seen[role] ?? 0) + 1;
    return { ...g, role, id: seen[role] > 1 ? `${role}-${seen[role]}` : role };
  });
}
