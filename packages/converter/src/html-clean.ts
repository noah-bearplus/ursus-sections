import { parseHTML } from 'linkedom';
import { DEFAULT_SCRUB, frameworkClass, prefixName, type FrameworkScrub } from './selectors.ts';
import { transformValue } from './css-build.ts';

export interface CleanOptions {
  prefix: string;
  scopeClass: string;
  used: { classes: Set<string>; ids: Set<string>; attrs: Set<string> };
  rootFontSize: number;
  /** Extra attributes behaviours need at runtime (e.g. data-src). */
  keepAttrs?: string[];
  scrub?: FrameworkScrub;
}

const ALWAYS_KEEP_DATA = new Set(['data-src', 'data-srcset']);
const ID_REF_ATTRS = ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns', 'list'];

/**
 * Turns captured section markup into clean, namespaced HTML:
 *  - classes are kept only when some kept CSS rule uses them, then prefixed
 *  - ids are kept when referenced (CSS, aria-*, label[for], #anchors), then prefixed
 *  - data-* attributes survive only if CSS/behaviours/templates need them
 *  - framework artefacts (data-astro-cid-*, data-v-*) and inline handlers are removed
 */
export function cleanSectionHtml(html: string, opts: CleanOptions): { html: string; assets: string[] } {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = document.body.firstElementChild as Element;
  const scrub = opts.scrub ?? DEFAULT_SCRUB;
  const keep = new Set([...(opts.keepAttrs ?? []), ...ALWAYS_KEEP_DATA]);
  const all = [root, ...Array.from(root.querySelectorAll('*'))];

  // ids referenced from inside the section
  const referencedIds = new Set(opts.used.ids);
  for (const el of all) {
    for (const a of ID_REF_ATTRS) for (const v of (el.getAttribute(a) ?? '').split(/\s+/).filter(Boolean)) referencedIds.add(v);
    const href = el.getAttribute('href');
    if (href?.startsWith('#') && href.length > 1) referencedIds.add(href.slice(1));
  }

  const assets = new Set<string>();
  const px = `${opts.prefix}-`;
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (scrub.attributes.some((re) => re.test(name))) {
        // Scoping attribute → class, but only where some kept rule relies on it.
        const fc = frameworkClass(name);
        if (opts.used.classes.has(fc)) el.classList.add(fc);
        el.removeAttribute(name);
        continue;
      }
      if (/^on[a-z]+$/.test(name)) {
        el.removeAttribute(name);
        continue;
      }
      if (name.startsWith('data-') && !name.startsWith('data-sf-') && !opts.used.attrs.has(name) && !keep.has(name)) {
        el.removeAttribute(name);
      }
    }
    const cls = Array.from(el.classList);
    if (cls.length) {
      const kept = cls.filter((c) => opts.used.classes.has(c)).map((c) => prefixName(c, px));
      el.removeAttribute('class');
      if (kept.length) el.setAttribute('class', kept.join(' '));
    }
    const id = el.getAttribute('id');
    if (id) {
      if (referencedIds.has(id)) el.setAttribute('id', prefixName(id, px));
      else el.removeAttribute('id');
    }
    for (const a of ID_REF_ATTRS) {
      const v = el.getAttribute(a);
      if (v) el.setAttribute(a, v.split(/\s+/).map((x) => prefixName(x, px)).join(' '));
    }
    const href = el.getAttribute('href');
    if (href?.startsWith('#') && href.length > 1) el.setAttribute('href', '#' + prefixName(href.slice(1), px));
    const style = el.getAttribute('style');
    if (style) {
      const st = style
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
          const i = d.indexOf(':');
          let prop = d.slice(0, i).trim();
          if (prop.startsWith('--')) prop = `--${prefixName(prop.slice(2), px)}`;
          return `${prop}: ${transformValue(d.slice(i + 1).trim(), { prefix: opts.prefix, rootFontSize: opts.rootFontSize })}`;
        })
        .join('; ');
      el.setAttribute('style', st);
      for (const m of st.matchAll(/url\(\s*["']?(assets\/[^"')]+)/g)) assets.add(m[1]);
    }
    for (const a of ['src', 'poster', 'data-src', 'href']) {
      const v = el.getAttribute(a);
      if (v?.startsWith('assets/')) assets.add(v);
    }
    const srcset = el.getAttribute('srcset');
    if (srcset) for (const part of srcset.split(',')) if (part.trim().startsWith('assets/')) assets.add(part.trim().split(/\s+/)[0]);
  }
  root.classList.add(opts.scopeClass);

  // Drop comments.
  const walker = document.createTreeWalker(root, 128 /* SHOW_COMMENT */);
  const comments: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) comments.push(n);
  comments.forEach((c) => c.parentNode?.removeChild(c));

  return { html: root.outerHTML, assets: [...assets] };
}
