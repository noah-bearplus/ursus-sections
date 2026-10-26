import { basename } from 'node:path';
import { parseHTML } from 'linkedom';
import type { FieldIR, GeneratedFile, RepeaterIR, SectionIR, ThemeProfile } from '@sf/core';
import { buildSchema, fallbackValue, type SectionSchema } from './schema.ts';
import { themeStyleCss } from './roles.ts';

export type CssMode = 'auto' | 'single-file' | 'asset';

export interface GenerateOptions {
  profile: ThemeProfile;
  cssMode?: CssMode;
  /** Theme asset file name for a converter asset path (assets/x.webp → dtl-x.webp) */
  assetName?: (path: string) => string;
}

export interface GeneratedSection {
  handle: string;
  files: GeneratedFile[];
  schema: SectionSchema;
  /** Converter asset paths that must be copied into the theme's assets/ folder */
  assets: { from: string; to: string }[];
}

interface Ctx {
  tokens: Map<string, string>;
  seq: number;
  assets: Map<string, string>;
  assetName: (p: string) => string;
}

const IMG_WIDTHS = [480, 960, 1600];

/** Turns a SectionIR into a theme-consistent Shopify section (+ CSS/JS assets). */
export function generateSection(ir: SectionIR, opts: GenerateOptions): GeneratedSection {
  const profile = opts.profile;
  const handle = ir.rootClass.replace(/^sf-/, '');
  const prefix = ir.classPrefix.replace(/-$/, '');
  const assetName =
    opts.assetName ??
    ((p: string) => {
      const b = basename(p);
      return b.startsWith(`${prefix}-`) ? b : `${prefix}-${b}`;
    });
  const ctx: Ctx = { tokens: new Map(), seq: 0, assets: new Map(), assetName };
  const tok = (liquid: string) => {
    const t = `§${ctx.seq++}§`;
    ctx.tokens.set(t, liquid);
    return t;
  };
  const fallbackFields = new Set<string>();

  const { document } = parseHTML(`<!DOCTYPE html><html><body>${ir.template}</body></html>`);
  const root = document.body.firstElementChild as Element;

  // ---- repeaters → block loops ---------------------------------------------------------
  for (const el of Array.from(root.querySelectorAll('[data-sf-repeat]'))) {
    const rep = ir.repeaters.find((r) => r.id === el.getAttribute('data-sf-repeat'));
    el.removeAttribute('data-sf-repeat');
    if (!rep) continue;
    const scope = 'block.settings';
    const imgAssigns = rep.fields.filter((f) => f.type === 'image').map((f) => imageAssign(f, scope, rep.items.some((i) => i[f.id]), fallbackFields, `${rep.id}.`));
    transformScope(el, rep.fields, scope, ctx, tok);
    el.setAttribute('data-sf-shopify-attrs', '');
    el.before(document.createComment(tok(`{%- for block in section.blocks -%}\n{%- if block.type != '${rep.blockType}' -%}{%- continue -%}{%- endif -%}\n${imgAssigns.join('\n')}`)));
    el.after(document.createComment(tok('{%- endfor -%}')));
  }

  // ---- section-level fields ------------------------------------------------------------
  const sectionImgAssigns = ir.fields.filter((f) => f.type === 'image').map((f) => imageAssign(f, 'section.settings', !!f.default, fallbackFields, ''));
  transformScope(root, ir.fields, 'section.settings', ctx, tok);

  // Static images / inline-style URLs that are not settings → bundled theme assets.
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const a of ['src', 'poster', 'href']) {
      const v = el.getAttribute(a);
      if (v?.startsWith('assets/')) el.setAttribute(a, tok(assetUrl(v, ctx)));
    }
    const srcset = el.getAttribute('srcset');
    if (srcset?.includes('assets/')) el.removeAttribute('srcset');
    const style = el.getAttribute('style');
    if (style?.includes('assets/')) el.setAttribute('style', style.replace(/assets\/[^"')\s]+/g, (p) => tok(assetUrl(p, ctx))));
  }

  // ---- root attributes: colour mode, style source, theme colour scheme ------------------
  const rootClassTokens: string[] = [];
  if (ir.modes) root.setAttribute(ir.modes.attribute, tok('{{ section.settings.color_mode }}'));
  root.setAttribute('data-sf-style', tok('{{ section.settings.style_source }}'));
  if (profile.section.colorScheme) {
    rootClassTokens.push(tok(`{% if section.settings.style_source == 'theme' %} ${profile.section.colorScheme.classTemplate}{% endif %}`));
  }
  if (rootClassTokens.length) root.setAttribute('class', `${root.getAttribute('class') ?? ''}${rootClassTokens.join('')}`);

  let markup = root.outerHTML;
  markup = markup.replace(/ data-sf-shopify-attrs=""/g, ' {{ block.shopify_attributes }}');
  markup = markup.replace(/<!--(§\d+§)-->/g, '$1');
  markup = markup.replace(/ data-sf-la="(§\d+§)"/g, '$1');
  // Resolve tokens (they may nest: a token's Liquid can contain other tokens).
  for (let i = 0; i < 3 && /§\d+§/.test(markup); i++) markup = markup.replace(/§\d+§/g, (t) => ctx.tokens.get(t) ?? t);

  // ---- wrapper (padding) ---------------------------------------------------------------
  const pad = profile.section.padding;
  let wrapperOpen = '';
  let wrapperClose = '';
  if (pad?.className) {
    if (pad.className === 'spacing-style') {
      wrapperOpen = `<div class="spacing-style" style="{% render 'spacing-style', settings: section.settings %}">`;
    } else {
      wrapperOpen = `<div class="${pad.className}">`;
    }
    wrapperClose = '</div>';
  }

  // ---- CSS / JS ---------------------------------------------------------------------------
  let css = ir.css;
  css += themeStyleCss(ir, profile);
  if (profile.hazards.includes('empty-elements-hidden')) {
    // Themes like Dawn hide empty <div>/<span>…; decorative empty elements must stay rendered.
    css = `.${ir.rootClass}.${ir.rootClass} :where(div, span, a, p, section, ul, li, h1, h2, h3, h4, h5, h6):empty { display: revert; }\n` + css;
  }
  const cssNeedsLiquid = /url\(\s*["']?assets\//.test(css);
  if (cssNeedsLiquid) css = css.replace(/url\(\s*(["']?)(assets\/[^"')]+)\1\s*\)/g, (_m, _q, p: string) => `url("${assetUrl(p, ctx)}")`);
  const mode: CssMode = opts.cssMode ?? 'auto';
  const strategy = mode === 'single-file' ? 'stylesheet-tag' : mode === 'asset' ? 'asset-file' : profile.css.strategy;

  const files: GeneratedFile[] = [];
  const head: string[] = [];
  const tail: string[] = [];
  const cssFile = `section-${handle}.css`;
  const jsFile = `section-${handle}.js`;
  if (strategy === 'asset-file' && !cssNeedsLiquid) {
    files.push({ path: `assets/${cssFile}`, content: css });
    head.push(`{{ '${cssFile}' | asset_url | stylesheet_tag }}`);
  } else if (strategy === 'stylesheet-tag' && !cssNeedsLiquid) {
    tail.push(`{% stylesheet %}\n${css}\n{% endstylesheet %}`);
  } else {
    head.push(`{%- style -%}\n${css}\n{%- endstyle -%}`);
  }
  if (ir.js) {
    if (strategy === 'asset-file') {
      files.push({ path: `assets/${jsFile}`, content: ir.js });
      head.push(`<script src="{{ '${jsFile}' | asset_url }}" defer="defer"></script>`);
    } else if (strategy === 'stylesheet-tag') {
      tail.push(`{% javascript %}\n${ir.js}\n{% endjavascript %}`);
    } else {
      tail.push(`<script>\n${ir.js}</script>`);
    }
  }
  if (pad?.style && !pad.style.startsWith('{% render')) head.push(pad.style);

  const schema = buildSchema(ir, profile, { fallbackFields });
  const banner = `{%- comment -%}\n  ${ir.name} — generated by sectionforge from ${ir.source.url}\n  Section: ${handle} · ${ir.fields.length} settings · ${ir.repeaters.map((r) => `${r.blockType} blocks`).join(', ') || 'no blocks'}\n{%- endcomment -%}`;
  const liquid = [
    banner,
    ...head,
    sectionImgAssigns.join('\n'),
    wrapperOpen,
    markup,
    wrapperClose,
    ...tail,
    `{% schema %}\n${JSON.stringify(schema, null, 2)}\n{% endschema %}`,
    '',
  ]
    .filter((x) => x !== '')
    .join('\n');
  files.unshift({ path: `sections/${handle}.liquid`, content: liquid });

  // Demo images referenced by "<image>_fallback" defaults and preset blocks ship as theme assets.
  const demo = (v: unknown) => {
    if (typeof v === 'string' && v.startsWith('assets/')) ctx.assets.set(v, fallbackValue(v, ir));
  };
  for (const f of ir.fields) if (f.type === 'image') demo(f.default);
  for (const r of ir.repeaters) {
    const imgs = r.fields.filter((f) => f.type === 'image');
    for (const item of r.items.slice(0, r.presetCount)) for (const f of imgs) demo(item[f.id]);
  }
  return { handle, files, schema, assets: [...ctx.assets.entries()].map(([from, to]) => ({ from, to })) };
}

/* ------------------------------------------------------------------------------------------ */

function assetUrl(path: string, ctx: Ctx): string {
  const name = ctx.assetName(path);
  ctx.assets.set(path, name);
  return `{{ '${name}' | asset_url }}`;
}

function imageAssign(f: FieldIR, scope: string, hasDefault: boolean, fallbackFields: Set<string>, key: string): string {
  const v = `sf_img_${f.id}`;
  const lines = [`  if ${scope}.${f.id} != blank`, `    assign ${v} = ${scope}.${f.id} | image_url: width: ${IMG_WIDTHS[IMG_WIDTHS.length - 1]}`];
  if (hasDefault) {
    fallbackFields.add(`${key}${f.id}`);
    lines.push(
      `  elsif ${scope}.${f.id}_fallback contains '://'`,
      `    assign ${v} = ${scope}.${f.id}_fallback`,
      `  elsif ${scope}.${f.id}_fallback != blank`,
      `    assign ${v} = ${scope}.${f.id}_fallback | asset_url`,
    );
  }
  lines.push('  else', `    assign ${v} = ''`, '  endif');
  return `{%- liquid\n${lines.join('\n')}\n-%}`;
}

/**
 * Rewrites placeholders and sf markers inside one scope (section or block) into tokens
 * that resolve to Liquid after serialisation (so the HTML serialiser never escapes Liquid).
 */
function transformScope(scopeEl: Element, fields: FieldIR[], scope: string, ctx: Ctx, tok: (l: string) => string): void {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const inScope = (el: Element) => {
    const rep = el.closest('[data-sf-repeat]');
    return scope === 'block.settings' ? true : !rep || rep === scopeEl;
  };
  const expr = (id: string, ctxKind: 'text' | 'attr'): string => {
    if (id === '@index0') return '{{ forloop.index0 }}';
    if (id === '@index') return '{{ forloop.index }}';
    const f = byId.get(id);
    if (!f) return `{{sf:${id}}}`;
    const s = `${scope}.${id}`;
    switch (f.type) {
      case 'text':
        return `{{ ${s} | escape }}`;
      case 'textarea':
        return ctxKind === 'attr' ? `{{ ${s} | escape }}` : `{{ ${s} | escape | newline_to_br }}`;
      case 'inline_richtext':
      case 'richtext':
        return ctxKind === 'attr' ? `{{ ${s} | strip_html | escape }}` : `{{ ${s} }}`;
      case 'url':
        return `{{ ${s} | default: '#' }}`;
      case 'image':
        return `{{ sf_img_${id} }}`;
      case 'checkbox':
        return `{{ ${s} }}`;
      default:
        return `{{ ${s} }}`;
    }
  };
  const replaceIn = (s: string, kind: 'text' | 'attr') => s.replace(/\{\{sf:(@?\w+)\}\}/g, (_m, id: string) => tok(expr(id, kind)));

  const els = [scopeEl, ...Array.from(scopeEl.querySelectorAll('*'))].filter(inScope);
  for (const el of els) {
    // conditional element
    const cond = el.getAttribute('data-sf-if');
    let wrapped = false;
    if (cond && byId.has(cond)) {
      wrapped = true;
      const f = byId.get(cond)!;
      const test = f.type === 'checkbox' ? `${scope}.${cond}` : f.type === 'image' ? `sf_img_${cond} != blank` : `${scope}.${cond} != blank`;
      el.removeAttribute('data-sf-if');
      el.before(el.ownerDocument.createComment(tok(`{%- if ${test} -%}`)));
      el.after(el.ownerDocument.createComment(tok('{%- endif -%}')));
    }
    // conditional attributes
    const attrIf = el.getAttribute('data-sf-attr-if');
    if (attrIf) {
      el.removeAttribute('data-sf-attr-if');
      const parts: string[] = [];
      for (const spec of attrIf.split(';')) {
        const [f, names] = spec.split(':');
        if (!byId.has(f)) continue;
        const attrs = names
          .split(' ')
          .map((n) => {
            const v = el.getAttribute(n);
            el.removeAttribute(n);
            return v === '' || v === null ? ` ${n}` : ` ${n}="${v.replace(/"/g, '&quot;')}"`;
          })
          .join('');
        parts.push(`{% if ${scope}.${f} %}${attrs}{% endif %}`);
      }
      if (parts.length) el.setAttribute('data-sf-la', tok(parts.join('')));
    }
    // "Label | URL" link lists
    const list = el.getAttribute('data-sf-list');
    if (list && byId.has(list)) {
      el.removeAttribute('data-sf-list');
      el.setAttribute('href', tok("{{ sf_url | default: '#' }}"));
      el.textContent = tok('{{ sf_label | escape }}');
      el.before(
        el.ownerDocument.createComment(
          tok(
            `{%- assign sf_lines = ${scope}.${list} | newline_to_br | split: '<br />' -%}\n{%- for sf_line in sf_lines -%}\n{%- assign sf_parts = sf_line | split: '|' -%}\n{%- assign sf_label = sf_parts[0] | strip -%}\n{%- assign sf_url = sf_parts[1] | strip -%}\n{%- if sf_label != blank -%}`,
          ),
        ),
      );
      el.after(el.ownerDocument.createComment(tok('{%- endif -%}\n{%- endfor -%}')));
      continue;
    }
    // image elements bound to an image field: responsive srcset when a picker image is set
    if (el.tagName.toLowerCase() === 'img') {
      const m = /^\{\{sf:(\w+)\}\}$/.exec(el.getAttribute('src') ?? '');
      const f = m ? byId.get(m[1]) : undefined;
      if (f?.type === 'image') {
        const s = `${scope}.${f.id}`;
        // Small fixed-size images (icons, avatars) get 1x–3x candidates; others responsive widths.
        const w = Number(el.getAttribute('width'));
        const widths = w > 0 && w <= 240 ? [w, w * 2, w * 3] : IMG_WIDTHS;
        const sizes = w > 0 && w <= 240 ? `${w}px` : '(min-width: 990px) 50vw, 100vw';
        const srcset = widths.map((x) => `{{ ${s} | image_url: width: ${x} }} ${x}w`).join(', ');
        const extra = `{% if ${s} != blank %} srcset="${srcset}" sizes="${sizes}"{% endif %}`;
        const prev = el.getAttribute('data-sf-la');
        el.setAttribute('data-sf-la', prev ? tok(ctx.tokens.get(prev)! + extra) : tok(extra));
        if (!wrapped) {
          el.before(el.ownerDocument.createComment(tok(`{%- if sf_img_${f.id} != blank -%}`)));
          el.after(el.ownerDocument.createComment(tok('{%- endif -%}')));
        }
      }
    }
    for (const a of Array.from(el.attributes)) {
      if (a.value.includes('{{sf:')) el.setAttribute(a.name, replaceIn(a.value, 'attr'));
    }
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 && (n.textContent ?? '').includes('{{sf:')) n.textContent = replaceIn(n.textContent ?? '', 'text');
    }
  }
}

export type { RepeaterIR };
