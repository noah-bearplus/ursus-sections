import type { SectionIR } from '@sf/core';
import { escapeHtml } from '@sf/core';
import { renderStatic } from './render-static.ts';

export interface PageDocOptions {
  title: string;
  mode?: string;
  /** Maps "assets/x" to the URL used by this document */
  assetUrl: (p: string) => string;
  background?: Record<string, string>;
  /** Show a floating light/dark switch */
  modeSwitch?: boolean;
  lang?: string;
}

/** Self-contained HTML document for one or more sections (preview / full-page clone). */
export function renderDocument(sections: SectionIR[], opts: PageDocOptions): string {
  const modes = sections.find((s) => s.modes)?.modes ?? null;
  const mode = opts.mode ?? modes?.default;
  const fixAssets = (css: string) => css.replace(/url\((["']?)(assets\/[^"')]+)\1\)/g, (_m, q: string, p: string) => `url(${q}${opts.assetUrl(p)}${q})`);
  const bg = opts.background ?? {};
  const bgCss = modes
    ? modes.values.map((m) => `html[data-sf-mode="${m}"] { background: ${bg[m] ?? 'transparent'}; }`).join('\n')
    : `html { background: ${Object.values(bg)[0] ?? 'transparent'}; }`;
  const switcher =
    opts.modeSwitch && modes
      ? `<button type="button" class="sf-mode-switch" aria-label="Switch colour mode">${escapeHtml(modes.values.join(' / '))}</button>
<script>
(function () {
  var modes = ${JSON.stringify(modes.values)}, attr = ${JSON.stringify(modes.attribute)};
  var btn = document.querySelector('.sf-mode-switch');
  btn.addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-sf-mode');
    var next = modes[(modes.indexOf(cur) + 1) % modes.length];
    document.documentElement.setAttribute('data-sf-mode', next);
    document.querySelectorAll('[' + attr + ']').forEach(function (el) { if (el.closest('[class*="sf-"]') === el) el.setAttribute(attr, next); });
  });
})();
</script>`
      : '';

  return `<!DOCTYPE html>
<html lang="${opts.lang ?? 'en'}"${mode ? ` data-sf-mode="${mode}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
html, body { margin: 0; }
${bgCss}
.sf-mode-switch { position: fixed; right: 16px; bottom: 16px; z-index: 9999; font: 600 12px/1 system-ui, sans-serif; padding: 10px 14px; border-radius: 999px; border: 1px solid rgba(128,128,128,.35); background: rgba(20,20,20,.85); color: #fff; cursor: pointer; backdrop-filter: blur(8px); }
</style>
${sections.map((s) => `<style data-section="${s.key}">\n${fixAssets(s.css)}\n</style>`).join('\n')}
</head>
<body>
${sections.map((s) => renderStatic(s, { mode, assetUrl: opts.assetUrl })).join('\n')}
${sections.filter((s) => s.js).map((s) => `<script data-section="${s.key}">\n${s.js}</script>`).join('\n')}
${switcher}
</body>
</html>
`;
}
