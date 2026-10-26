import type { DesignTokens, Token } from '@sf/core';
import { escapeHtml } from '@sf/core';
import { tokensToCss } from './tokens-css.ts';

export interface StyleguideComponent {
  name: string;
  /** Self-contained HTML (with <style>) rendered inside an iframe srcdoc */
  html: string;
  height?: number;
}

export interface StyleguideOptions {
  title: string;
  sourceUrl: string;
  modeAttribute?: string;
  components?: StyleguideComponent[];
  /** Relative URL prefix for font files referenced by tokens.css */
  fontCss?: string;
}

const GROUP_ORDER = ['surface', 'text', 'border', 'accent', 'scrollbar', 'misc'];

export function renderStyleguide(design: DesignTokens, opts: StyleguideOptions): string {
  const colors = design.tokens.filter((t) => t.kind === 'color');
  const radii = design.tokens.filter((t) => t.kind === 'radius' || (t.group === 'radius' && t.kind === 'size'));
  const shadows = design.tokens.filter((t) => t.kind === 'shadow');
  const easings = design.tokens.filter((t) => t.kind === 'easing');
  const durations = design.tokens.filter((t) => t.kind === 'duration' || t.kind === 'transition');
  const fontTokens = design.tokens.filter((t) => ['font-family', 'font-weight', 'font-size', 'letter-spacing', 'font-settings'].includes(t.kind));
  const modes = design.modes;
  const def = design.defaultMode;

  const byGroup = new Map<string, Token[]>();
  for (const c of colors) byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);
  const groups = [...byGroup.keys()].sort((a, b) => (GROUP_ORDER.indexOf(a) + 99) % 99 - (GROUP_ORDER.indexOf(b) + 99) % 99);

  const swatch = (t: Token) => `
      <div class="sw">
        <div class="sw__chips">${modes
          .map((m) => {
            const v = t.resolved[m] ?? '';
            return `<div class="sw__chip" style="--c:${escapeHtml(v)}" title="${m}: ${escapeHtml(v)}"><span>${m}</span></div>`;
          })
          .join('')}</div>
        <div class="sw__meta">
          <code>--${escapeHtml(t.name)}</code>
          <div class="sw__vals">${modes.map((m) => `<span>${escapeHtml(t.resolved[m] ?? '—')}</span>`).join('')}</div>
          <div class="sw__use">${t.usage} uses</div>
        </div>
      </div>`;

  const colorSection = groups
    .map(
      (g) => `
    <div class="block">
      <h3>${escapeHtml(g)}</h3>
      <div class="swatches">${byGroup.get(g)!.sort((a, b) => b.usage - a.usage).map(swatch).join('')}</div>
    </div>`,
    )
    .join('');

  const families = [...new Set(design.fonts.map((f) => f.family))];
  const typeRows = design.typography
    .map(
      (s) => `
      <div class="type-row">
        <div class="type-row__meta">
          <strong>${escapeHtml(s.id)}</strong>
          <span>${s.fontSize}px / ${escapeHtml(s.lineHeight)}</span>
          <span>weight ${escapeHtml(s.fontWeight)}${s.letterSpacing !== 'normal' ? ` · ls ${escapeHtml(s.letterSpacing)}` : ''}</span>
          ${s.fontVariationSettings ? `<span class="muted">${escapeHtml(s.fontVariationSettings)}</span>` : ''}
        </div>
        <div class="type-row__sample" style="font-family:${escapeHtml(s.fontFamily)};font-size:${s.fontSize}px;line-height:${escapeHtml(s.lineHeight)};font-weight:${escapeHtml(s.fontWeight)};letter-spacing:${escapeHtml(s.letterSpacing)};${s.fontVariationSettings ? `font-variation-settings:${escapeHtml(s.fontVariationSettings)};` : ''}${s.textTransform ? `text-transform:${s.textTransform};` : ''}">${escapeHtml(s.sample)}</div>
      </div>`,
    )
    .join('');

  const radiusSection = radii
    .map((t) => `<div class="radius"><div class="radius__box" style="border-radius:${escapeHtml(t.resolved[def] ?? t.values.base ?? '0')}"></div><code>--${escapeHtml(t.name)}</code><span>${escapeHtml(t.resolved[def] ?? '')}</span></div>`)
    .join('');

  const shadowSection = shadows
    .map(
      (t) => `<div class="shadow">${modes
        .map((m) => `<div class="shadow__box shadow__box--${m === 'dark' ? 'dark' : 'light'}" style="box-shadow:${escapeHtml(t.resolved[m] ?? '')}"><span>${m}</span></div>`)
        .join('')}<code>--${escapeHtml(t.name)}</code></div>`,
    )
    .join('');

  const easingSection = easings
    .map((t) => {
      const v = t.resolved[def] ?? t.values.base ?? '';
      return `<div class="ease" style="--ease:${escapeHtml(v)}">
        <svg viewBox="-4 -24 108 148" class="ease__plot"><rect x="0" y="0" width="100" height="100" class="ease__frame"/>${easingPath(v)}</svg>
        <div class="ease__track"><span class="ease__dot"></span></div>
        <code>--${escapeHtml(t.name)}</code>
      </div>`;
    })
    .join('');

  const durationRows = durations
    .map((t) => `<tr><td><code>--${escapeHtml(t.name)}</code></td><td>${escapeHtml(t.values.base ?? t.resolved[def] ?? '')}</td><td>${t.usage}</td></tr>`)
    .join('');

  const fontTokenRows = fontTokens
    .map((t) => `<tr><td><code>--${escapeHtml(t.name)}</code></td><td>${modes.map((m) => escapeHtml(t.values[m] ?? t.values.base ?? '')).filter((v, i, a) => a.indexOf(v) === i).join(' <span class="muted">/</span> ')}</td><td>${t.usage}</td></tr>`)
    .join('');

  const maxBp = Math.max(...design.breakpoints, 1440);
  const bpSection = design.breakpoints
    .map((bp) => `<div class="bp" style="--w:${(bp / maxBp) * 100}%"><span>${bp}px</span></div>`)
    .join('');

  const componentSection = (opts.components ?? [])
    .map(
      (c) => `<figure class="comp"><figcaption>${escapeHtml(c.name)}</figcaption><iframe loading="lazy" style="height:${c.height ?? 240}px" srcdoc="${escapeHtml(c.html)}"></iframe></figure>`,
    )
    .join('');

  const stats = [
    [colors.length, 'colour tokens'],
    [design.typography.length, 'type styles'],
    [radii.length, 'radii'],
    [easings.length, 'easings'],
    [design.breakpoints.length, 'breakpoints'],
    [modes.length, 'modes'],
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} — Styleguide</title>
<style>
${tokensToCss(design, { modeAttribute: opts.modeAttribute ?? 'data-theme' })}
${opts.fontCss ?? ''}
:root { --sg-bg:#0b0b0c; --sg-panel:#141416; --sg-line:#26262a; --sg-text:#ededee; --sg-muted:#8b8b92; --sg-accent:#f25500; color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--sg-bg); color: var(--sg-text); font: 14px/1.5 ${families.length ? `"${families[0]}", ` : ''}system-ui, -apple-system, "Segoe UI", sans-serif; }
code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--sg-text); }
.muted { color: var(--sg-muted); }
.wrap { max-width: 1240px; margin: 0 auto; padding: 0 24px 120px; }
header.top { padding: 72px 0 40px; border-bottom: 1px solid var(--sg-line); margin-bottom: 40px; }
header.top h1 { font-size: clamp(32px, 5vw, 56px); line-height: 1.05; letter-spacing: -0.02em; font-weight: 600; }
header.top p { color: var(--sg-muted); margin-top: 12px; max-width: 60ch; }
header.top a { color: var(--sg-text); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-top: 32px; }
.stats div { background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 14px; padding: 14px 16px; }
.stats b { display: block; font-size: 28px; line-height: 1; font-weight: 600; }
.stats span { color: var(--sg-muted); font-size: 12px; }
nav.toc { position: sticky; top: 0; z-index: 5; background: color-mix(in srgb, var(--sg-bg) 88%, transparent); backdrop-filter: blur(10px); display: flex; gap: 6px; padding: 12px 0; margin-bottom: 24px; overflow-x: auto; }
nav.toc a { color: var(--sg-text); text-decoration: none; padding: 6px 12px; border-radius: 999px; background: var(--sg-panel); border: 1px solid var(--sg-line); white-space: nowrap; font-size: 13px; }
section.sg { padding: 40px 0; border-top: 1px solid var(--sg-line); }
section.sg > h2 { font-size: 24px; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 6px; }
section.sg > p { color: var(--sg-muted); margin-bottom: 24px; }
.block + .block { margin-top: 28px; }
.block h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--sg-muted); margin-bottom: 12px; font-weight: 500; }
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.sw { background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 14px; overflow: hidden; }
.sw__chips { display: grid; grid-auto-flow: column; height: 72px; background-image: conic-gradient(#2a2a2e 25%, #1c1c1f 0 50%, #2a2a2e 0 75%, #1c1c1f 0); background-size: 12px 12px; }
.sw__chip { background: var(--c); display: flex; align-items: flex-end; padding: 6px 8px; }
.sw__chip span { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(0,0,0,.45); color: #fff; }
.sw__meta { padding: 10px 12px 12px; display: grid; gap: 4px; }
.sw__vals { display: flex; gap: 8px; flex-wrap: wrap; color: var(--sg-muted); font: 11px ui-monospace, monospace; }
.sw__use { color: var(--sg-muted); font-size: 11px; }
.fonts { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 10px; margin-bottom: 24px; }
.font-card { background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 14px; padding: 18px; }
.font-card .aa { font-size: 64px; line-height: 1; margin-bottom: 12px; }
.badge { display: inline-flex; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--sg-line); color: var(--sg-muted); margin-left: 6px; }
.badge--warn { color: #ffb36b; border-color: #5a3a1a; }
.type-row { display: grid; grid-template-columns: 220px 1fr; gap: 24px; padding: 18px 0; border-bottom: 1px solid var(--sg-line); align-items: baseline; }
.type-row__meta { display: grid; gap: 2px; font-size: 12px; color: var(--sg-muted); }
.type-row__meta strong { color: var(--sg-text); font-size: 13px; }
.type-row__sample { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--sg-line); vertical-align: top; }
th { color: var(--sg-muted); font-weight: 500; font-size: 12px; }
.radii { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.radius { background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 14px; padding: 16px; display: grid; gap: 6px; }
.radius__box { height: 80px; background: linear-gradient(135deg, #2b2b30, #1b1b1e); border: 1px solid #3a3a40; }
.radius span { color: var(--sg-muted); font-size: 12px; }
.shadows { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.shadow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 14px; padding: 16px; }
.shadow code { grid-column: 1 / -1; }
.shadow__box { height: 90px; border-radius: 14px; display: flex; align-items: flex-end; padding: 8px; font-size: 11px; }
.shadow__box--light { background: #fff; color: #555; }
.shadow__box--dark { background: #0d0b0a; color: #888; }
.eases { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.ease { background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 14px; padding: 14px; display: grid; gap: 10px; }
.ease__plot { width: 100%; height: 120px; overflow: visible; }
.ease__frame { fill: none; stroke: var(--sg-line); stroke-dasharray: 2 3; }
.ease__curve { fill: none; stroke: var(--sg-accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
.ease__track { height: 6px; background: var(--sg-line); border-radius: 999px; position: relative; }
.ease__dot { position: absolute; top: 50%; left: 0; width: 14px; height: 14px; border-radius: 50%; background: var(--sg-accent); transform: translate(-50%, -50%); transition: left 1.2s var(--ease); }
.ease:hover .ease__dot { left: 100%; }
.bps { display: grid; gap: 6px; }
.bp { position: relative; height: 28px; }
.bp::before { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--w); background: linear-gradient(90deg, #1d1d21, #2b2b31); border-right: 2px solid var(--sg-accent); border-radius: 8px 0 0 8px; }
.bp span { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font: 12px ui-monospace, monospace; }
.comps { display: grid; gap: 16px; }
.comp { background: var(--sg-panel); border: 1px solid var(--sg-line); border-radius: 16px; overflow: hidden; }
.comp figcaption { padding: 10px 14px; font-size: 12px; color: var(--sg-muted); border-bottom: 1px solid var(--sg-line); }
.comp iframe { display: block; width: 100%; border: 0; }
@media (max-width: 700px) { .type-row { grid-template-columns: 1fr; gap: 8px; } }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>${escapeHtml(opts.title)}</h1>
    <p>Design system extracted from <a href="${escapeHtml(opts.sourceUrl)}">${escapeHtml(opts.sourceUrl)}</a>. Values resolved in a real browser for every colour mode (${modes.join(', ')}). Default mode: <b>${escapeHtml(def)}</b>.</p>
    <div class="stats">${stats.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>
  </header>
  <nav class="toc"><a href="#colors">Colours</a><a href="#type">Typography</a><a href="#radius">Radius</a><a href="#elevation">Elevation</a><a href="#motion">Motion</a><a href="#breakpoints">Breakpoints</a>${componentSection ? '<a href="#components">Components</a>' : ''}</nav>

  <section class="sg" id="colors"><h2>Colours</h2><p>Semantic colour tokens, each shown in every mode. Usage = number of var() references in the source CSS.</p>${colorSection}</section>

  <section class="sg" id="type"><h2>Typography</h2><p>Font families and the type scale sampled from rendered text (largest first).</p>
    <div class="fonts">${families
      .map((f) => {
        const ok = design.fonts.some((x) => x.family === f && x.available);
        return `<div class="font-card"><div class="aa" style="font-family:'${escapeHtml(f)}',system-ui">Aa</div><strong>${escapeHtml(f)}</strong>${ok ? '<span class="badge">bundled</span>' : '<span class="badge badge--warn">not bundled — licensed font, fallback shown</span>'}</div>`;
      })
      .join('')}</div>
    ${typeRows}
    <div class="block" style="margin-top:28px"><h3>Font tokens</h3><table><tr><th>Token</th><th>Value (per mode)</th><th>Uses</th></tr>${fontTokenRows}</table></div>
  </section>

  <section class="sg" id="radius"><h2>Radius</h2><p>Corner radii.</p><div class="radii">${radiusSection}</div></section>
  <section class="sg" id="elevation"><h2>Elevation</h2><p>Shadow tokens on light and dark surfaces.</p><div class="shadows">${shadowSection}</div></section>
  <section class="sg" id="motion"><h2>Motion</h2><p>Easing curves (hover a card to play) and timing tokens.</p><div class="eases">${easingSection}</div>
    <div class="block" style="margin-top:28px"><h3>Durations &amp; delays</h3><table><tr><th>Token</th><th>Value</th><th>Uses</th></tr>${durationRows}</table></div></section>
  <section class="sg" id="breakpoints"><h2>Breakpoints</h2><p>Width breakpoints used by at least two media queries.</p><div class="bps">${bpSection}</div></section>
  ${componentSection ? `<section class="sg" id="components"><h2>Components</h2><p>Converted sections rendered from the generated HTML.</p><div class="comps">${componentSection}</div></section>` : ''}
</div>
</body>
</html>
`;
}

/** SVG path for an easing function, in a 100×100 box (y up). */
export function easingPath(v: string): string {
  const cb = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(v);
  if (cb) {
    const [x1, y1, x2, y2] = cb.slice(1).map(Number);
    return `<path class="ease__curve" d="M0,100 C${x1 * 100},${100 - y1 * 100} ${x2 * 100},${100 - y2 * 100} 100,0"/>`;
  }
  const lin = /linear\((.*)\)/s.exec(v);
  if (lin) {
    const stops = lin[1].split(',').map((s) => s.trim().split(/\s+/));
    // CSS linear(): missing positions are spread evenly between the nearest known ones.
    const xs: (number | null)[] = stops.map(([, pct], i) => (pct ? parseFloat(pct) : i === 0 ? 0 : i === stops.length - 1 ? 100 : null));
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] !== null) continue;
      let j = i;
      while (xs[j] === null) j++;
      const from = xs[i - 1]!;
      const to = xs[j]!;
      for (let k = i; k < j; k++) xs[k] = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    }
    const pts: [number, number][] = stops.map(([val], i) => [xs[i]!, 100 - parseFloat(val) * 100]);
    return `<polyline class="ease__curve" points="${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}"/>`;
  }
  return '<path class="ease__curve" d="M0,100 L100,0"/>';
}
