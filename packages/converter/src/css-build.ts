import type { DesignTokens } from '@sf/core';
import { closeOverReferences, tokensToCss } from '@sf/design';
import type { FlatCss, FlatRule } from './css-collect.ts';
import type { MatchResult, Placement } from './section-capture.ts';
import { DEFAULT_SCRUB, referencedNames, rewriteSelector, specificity, type FrameworkScrub } from './selectors.ts';

/** Properties that flow from ancestors into the section (inherited) + the backdrop colour. */
const HOIST_PROPS = new Set([
  'color',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-stretch',
  'font-variant',
  'font-feature-settings',
  'font-variation-settings',
  'font-synthesis',
  'font-optical-sizing',
  'font-kerning',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'text-align',
  'text-transform',
  'text-indent',
  'text-rendering',
  'text-wrap',
  'text-size-adjust',
  '-webkit-text-size-adjust',
  '-webkit-font-smoothing',
  '-moz-osx-font-smoothing',
  'white-space',
  'word-break',
  'overflow-wrap',
  'hyphens',
  'direction',
  'cursor',
  'list-style',
  'list-style-type',
  'quotes',
  'tab-size',
  'color-scheme',
  'caret-color',
  'accent-color',
  '-webkit-tap-highlight-color',
  'background-color',
]);

export interface SectionCssInput {
  flat: FlatCss;
  /** selector id → { rule index, original complex selector } */
  selectorIndex: Map<number, { ruleIdx: number; selector: string }>;
  match: MatchResult;
  prefix: string;
  scope: string;
  modeAttr: string | null;
  defaultMode: string;
  rootFontSize: number;
  tokens: DesignTokens;
  scrub?: FrameworkScrub;
}

export interface SectionCss {
  css: string;
  used: { classes: Set<string>; ids: Set<string>; attrs: Set<string> };
  tokensUsed: string[];
  keyframes: string[];
  fonts: { family: string; available: boolean }[];
  rulesKept: number;
  rulesTotal: number;
  approximations: string[];
}

export function buildSectionCss(input: SectionCssInput): SectionCss {
  const { flat, match, prefix, scope } = input;
  const scrub = input.scrub ?? DEFAULT_SCRUB;
  const used = { classes: new Set<string>(), ids: new Set<string>(), attrs: new Set<string>() };
  const tokenNames = new Set(input.tokens.tokens.map((t) => t.name));
  const keyframeNames = new Set(flat.keyframes.map((k) => k.name));
  const approximations: string[] = [];

  const tx = (value: string, prop = '') =>
    transformValue(value, { prefix, rootFontSize: input.rootFontSize, keyframes: /animation|^--/.test(prop) ? keyframeNames : undefined });
  const declText = (d: FlatRule['decls'][number]) => {
    const prop = d.prop.startsWith('--') ? `--${prefix}-${d.prop.slice(2)}` : d.prop;
    return `${prop}: ${tx(d.value, d.prop)}${d.important ? ' !important' : ''};`;
  };

  // ---- 1. rules that apply to elements of the section -------------------------------------
  const byRule = new Map<number, { selectors: string[] }>();
  for (const [id, { ruleIdx, selector }] of input.selectorIndex) {
    const perMode = match.placements[id];
    if (!perMode) continue;
    const placement: Placement = perMode[input.defaultMode] ?? Object.values(perMode)[0];
    if (placement.approx) approximations.push(selector);
    const rewritten = rewriteSelector(selector, placement, { classPrefix: `${prefix}-`, idPrefix: `${prefix}-`, scrub, scope });
    if (!rewritten.length) continue;
    const entry = byRule.get(ruleIdx) ?? { selectors: [] };
    for (const r of rewritten) if (!entry.selectors.includes(r)) entry.selectors.push(r);
    byRule.set(ruleIdx, entry);
    const names = referencedNames(selector);
    names.classes.forEach((c) => used.classes.add(c));
    names.ids.forEach((c) => used.ids.add(c));
    names.attrs.forEach((c) => used.attrs.add(c));
  }

  const blocks: { context: string[]; text: string }[] = [];
  for (const rule of flat.rules) {
    const hit = byRule.get(rule.idx);
    if (!hit || rule.global) continue;
    blocks.push({ context: rule.context, text: `${hit.selectors.join(',\n')} {\n${rule.decls.map((d) => '  ' + declText(d)).join('\n')}\n}` });
  }

  // ---- 2. inherited styles hoisted from ancestors outside the section ----------------------
  type Hoist = { depth: number; spec: number[]; idx: number; context: string[]; cond: string; decls: FlatRule['decls'] };
  const hoists: Hoist[] = [];
  const modeRe = input.modeAttr ? new RegExp(`\\[${input.modeAttr}=["']?([\\w-]+)["']?\\]`) : null;
  for (const [id, { ruleIdx, selector }] of input.selectorIndex) {
    const perMode = match.ancestors[id];
    if (!perMode) continue;
    const rule = flat.rules[ruleIdx];
    const decls = rule.decls.filter((d) => HOIST_PROPS.has(d.prop) || (d.prop.startsWith('--') && !rule.global));
    if (!decls.length) continue;
    const depth = Math.max(...Object.values(perMode).flat());
    const mm = modeRe?.exec(selector);
    const cond = mm && input.modeAttr ? `[${input.modeAttr}="${mm[1]}"]` : '';
    hoists.push({ depth, spec: specificity(selector), idx: ruleIdx, context: rule.context, cond, decls });
  }
  hoists.sort((a, b) => a.depth - b.depth || cmpSpec(a.spec, b.spec) || a.idx - b.idx);
  const base = new Map<string, string>();
  const conditional: { context: string[]; cond: string; decls: string[] }[] = [];
  for (const h of hoists) {
    if (!h.context.length && !h.cond) {
      for (const d of h.decls) {
        const v = d.value.trim();
        if (/^(inherit|unset)$/i.test(v)) continue; // keeps the value accumulated from shallower ancestors
        base.set(d.prop, declText(d));
      }
    } else {
      const ds = h.decls.filter((d) => !/^(inherit|unset)$/i.test(d.value.trim())).map(declText);
      if (ds.length) conditional.push({ context: h.context, cond: h.cond, decls: ds });
    }
  }
  const hoistBlocks: { context: string[]; text: string }[] = [];
  if (base.size) hoistBlocks.push({ context: [], text: `${scope} {\n${[...base.values()].map((d) => '  ' + d).join('\n')}\n}` });
  for (const c of conditional) hoistBlocks.push({ context: c.context, text: `${scope}${c.cond} {\n${c.decls.map((d) => '  ' + d).join('\n')}\n}` });

  // ---- 3. keyframes referenced by kept declarations ----------------------------------------
  const bodyCss = [...hoistBlocks, ...blocks].map((b) => wrap(b.context, b.text)).join('\n');
  const usedKeyframes = new Set<string>();
  for (const name of keyframeNames) {
    if (new RegExp(`(animation(-name)?\\s*:[^;]*\\b)${prefix}-${escapeRe(name)}\\b`).test(bodyCss)) usedKeyframes.add(name);
  }
  const keyframesCss = flat.keyframes
    .filter((k) => usedKeyframes.has(k.name))
    .map((k) => wrap(k.context, renameKeyframes(k.css, k.name, prefix, (v) => tx(v))))
    .join('\n');

  // ---- 4. design tokens referenced (transitively) ------------------------------------------
  const referenced = new Set<string>();
  for (const m of (bodyCss + keyframesCss).matchAll(new RegExp(`var\\(\\s*--${prefix}-([\\w-]+)`, 'g'))) {
    if (tokenNames.has(m[1])) referenced.add(m[1]);
  }
  const tokenSet = closeOverReferences(input.tokens.tokens, referenced);
  const tokensCss = tokenSet.size
    ? tokensToCss(input.tokens, { rootSelector: scope, modeAttribute: input.modeAttr, varPrefix: `${prefix}-`, only: tokenSet })
        .replace(/^(\s*--[\w-]+):\s*([^;]+);/gm, (_m, p: string, v: string) => `${p}: ${tx(v, '--')};`)
    : '';

  // Responsive / conditional token overrides (e.g. @media (max-width:768px) { :root { --island-width: 70vw } }).
  const tokenMedia: string[] = [];
  for (const rule of flat.rules) {
    if (!rule.global || !rule.context.length) continue;
    const decls = rule.decls.filter((d) => d.prop.startsWith('--') && tokenSet.has(d.prop.slice(2)));
    if (!decls.length) continue;
    const mm = modeRe?.exec(rule.selectors.join(','));
    const sel = mm && input.modeAttr ? `${scope}[${input.modeAttr}="${mm[1]}"]` : scope;
    tokenMedia.push(wrap(rule.context, `${sel} {\n${decls.map((d) => '  ' + declText(d)).join('\n')}\n}`));
  }
  const tokensAll = tokensCss + (tokenMedia.length ? tokenMedia.join('\n') + '\n' : '');

  // ---- 5. fonts ----------------------------------------------------------------------------
  const allCss = tokensAll + bodyCss;
  const fonts: SectionCss['fonts'] = [];
  const fontFaceCss: string[] = [];
  for (const ff of flat.fontFaces) {
    if (!ff.family || !allCss.includes(ff.family)) continue;
    const local = /url\(\s*["']?(\.\.\/)?assets\//.test(ff.css);
    fonts.push({ family: ff.family, available: local });
    if (local) fontFaceCss.push(ff.css.replace(/url\(\s*(["']?)\.\.\/assets\//g, 'url($1assets/'));
  }

  const css = [
    fontFaceCss.join('\n'),
    tokensAll && `/* tokens */\n${tokensAll}`,
    bodyCss && `/* section */\n${bodyCss}`,
    keyframesCss && `/* keyframes */\n${keyframesCss}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    css,
    used,
    tokensUsed: [...tokenSet],
    keyframes: [...usedKeyframes],
    fonts,
    rulesKept: blocks.length,
    rulesTotal: flat.rules.length,
    approximations,
  };
}

function cmpSpec(a: number[], b: number[]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function wrap(context: string[], text: string): string {
  let out = text;
  for (const c of [...context].reverse()) out = `${c} {\n${indent(out)}\n}`;
  return out;
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => (l ? '  ' + l : l))
    .join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function transformValue(value: string, o: { prefix: string; rootFontSize: number; keyframes?: Set<string> }): string {
  let v = value.replace(/var\(\s*--([\w-]+)/g, (_m, n: string) => `var(--${n.startsWith(`${o.prefix}-`) ? n : `${o.prefix}-${n}`}`);
  v = v.replace(/(-?\d*\.?\d+)rem\b/g, (_m, n: string) => `${+(parseFloat(n) * o.rootFontSize).toFixed(3)}px`);
  v = v.replace(/url\(\s*(["']?)\.\.\/assets\//g, 'url($1assets/');
  if (o.keyframes?.size) {
    v = v.replace(/[A-Za-z_][\w-]*/g, (w) => (o.keyframes!.has(w) && !w.startsWith(`${o.prefix}-`) ? `${o.prefix}-${w}` : w));
  }
  return v;
}

function renameKeyframes(css: string, name: string, prefix: string, tx: (v: string) => string): string {
  const renamed = css.replace(/^(@[\w-]*keyframes\s+)([^\s{]+)/, `$1${prefix}-${name}`);
  return renamed.replace(/(:\s*)([^;{}]+)(;|\})/g, (_m, a: string, v: string, end: string) => `${a}${tx(v)}${end}`);
}
