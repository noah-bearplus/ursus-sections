import { parseHTML } from 'linkedom';
import type { FieldIR, FieldType, RecipeFieldHint, RecipeRepeater, RepeaterIR } from '@sf/core';
import { collapseWhitespace, settingId, titleCase, uniqueId } from '@sf/core';

/**
 * Turns clean section HTML into an annotated template + field/repeater definitions.
 *
 * Markers written into the template:
 *   {{sf:id}}                        value placeholder (text node or attribute value)
 *   {{sf:@index0}} / {{sf:@index}}   loop index inside a repeater
 *   data-sf-repeat="type"            repeater item template (one per repeater)
 *   data-sf-if="field"               render element only when field is truthy / not blank
 *   data-sf-attr-if="field:a b"      attributes a, b only present when field is true
 */

/** Classes generated from component-scoping attributes (cid-xxxx, v-xxxx): never meaningful names. */
const isScopeClass = (c: string) => /(^|-)(cid|v)-[0-9a-z]{6,}$/i.test(c) || c.startsWith('sf-');

const INLINE_TAGS = new Set(['b', 'strong', 'em', 'i', 'u', 's', 'small', 'sup', 'sub', 'br', 'mark', 'code', 'abbr', 'wbr']);
const RICH_BLOCK_TAGS = new Set(['p', 'ul', 'ol', 'blockquote']);
const DERIVED_ATTRS = ['aria-label', 'title', 'alt', 'data-tooltip', 'data-comments-title', 'placeholder'];

type BindingKind = 'html' | 'textnode' | 'attr' | 'style-url' | 'list';

interface Binding {
  fieldId: string;
  kind: BindingKind;
  el: Element;
  attr?: string;
  /** index of the text node among the element's direct non-empty text nodes */
  textIndex?: number;
  /** for list bindings: signature of the repeated link children */
  listSig?: string;
}

interface ScopeResult {
  fields: FieldIR[];
  bindings: Binding[];
}

export interface TemplateResult {
  template: string;
  fields: FieldIR[];
  repeaters: RepeaterIR[];
}

export interface TemplateOptions {
  prefix: string;
  repeaters: RecipeRepeater[];
  /** Strings never turned into settings (e.g. decorative glyphs) */
  minTextLength?: number;
}

export function buildTemplate(html: string, opts: TemplateOptions): TemplateResult {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = document.body.firstElementChild as Element;
  const repeaters: RepeaterIR[] = [];
  const sectionTaken = new Set<string>();

  // ---- repeaters first (their items are replaced by a single template) ----------------------
  for (const r of opts.repeaters) {
    const items = Array.from(root.querySelectorAll(`[data-sf-item="${r.blockType}"]`)).filter(
      (el) => !el.parentElement?.closest(`[data-sf-item]`),
    );
    if (!items.length) continue;
    repeaters.push(processRepeater(items, r, opts));
  }

  // ---- section-level fields ----------------------------------------------------------------
  const scope = extractScope(root, root, { ...opts, stripPrefixes: [`${opts.prefix}-`] }, sectionTaken, (el) => el.hasAttribute('data-sf-repeat'));
  // Responsive duplicates (desktop + mobile logo link…) share one setting.
  const classesOf = (id: string) => {
    const b = scope.bindings.find((x) => x.fieldId === id);
    return b ? Array.from(b.el.classList).filter((c) => !/--/.test(c)).sort().join('.') : '';
  };
  for (const f of [...scope.fields]) {
    if (!['url', 'image', 'text'].includes(f.type) || !f.default) continue;
    const first = scope.fields.find(
      (x) => x.type === f.type && x.default === f.default && (f.type !== 'text' || classesOf(x.id) === classesOf(f.id)),
    );
    if (first && first !== f) {
      retarget(root, f.id, first.id);
      replacePlaceholder(root, f.id, `{{sf:${first.id}}}`);
      scope.fields.splice(scope.fields.indexOf(f), 1);
    }
  }
  applyDerivedAttributes(root, scope, (el) => !!el.closest('[data-sf-repeat]'));
  for (const el of Array.from(root.querySelectorAll('[data-sf-item],[data-sf-hint],[data-sf-static]'))) {
    el.removeAttribute('data-sf-item');
    el.removeAttribute('data-sf-hint');
    el.removeAttribute('data-sf-static');
  }
  for (const a of ['data-sf-hint', 'data-sf-static', 'data-sf-item']) root.removeAttribute(a);

  return { template: root.outerHTML, fields: scope.fields, repeaters };
}

/* ------------------------------------------------------------------------------------------ */

function processRepeater(items: Element[], r: RecipeRepeater, opts: TemplateOptions): RepeaterIR {
  const count = (el: Element) => el.querySelectorAll('*').length;
  const template = items.reduce((best, el) => (count(el) > count(best) ? el : best), items[0]);
  const taken = new Set<string>();
  const blockClass = Array.from(template.classList).find((c) => !isScopeClass(c))?.replace(new RegExp(`^${opts.prefix}-`), '') ?? '';
  const ti = items.indexOf(template);
  // Values are read from an untouched copy: extraction rewrites the template in place.
  const pristine = template.cloneNode(true) as Element;
  const strip = [`${opts.prefix}-`, ...(blockClass ? [`${blockClass}-`, `${blockClass}__`] : [])];
  const scope = extractScope(template, template, { ...opts, stripPrefixes: strip }, taken, () => false);

  // Map every template element to its counterpart in each instance by structural path.
  const tplEls = [template, ...Array.from(template.querySelectorAll('*'))];
  const pathOf = new Map<Element, string>(tplEls.map((e) => [e, structuralPath(e, template)]));
  const lookups = items.map((item, i) => {
    const src = i === ti ? pristine : item;
    const m = new Map<string, Element>();
    for (const e of [src, ...Array.from(src.querySelectorAll('*'))]) m.set(structuralPath(e, src), e);
    return m;
  });
  const counterpart = (el: Element, i: number) => lookups[i].get(pathOf.get(el)!) ?? null;

  const values: Record<string, string | number | boolean>[] = items.map(() => ({}));
  const read = (b: Binding, el: Element | null): string => {
    if (!el) return '';
    switch (b.kind) {
      case 'html':
        return fieldValueFromHtml(el, scope.fields.find((f) => f.id === b.fieldId)!.type);
      case 'textnode':
        return collapseWhitespace(directTextNodes(el)[b.textIndex ?? 0]?.textContent ?? '');
      case 'attr':
        return el.getAttribute(b.attr!) ?? '';
      case 'style-url':
        return /url\(\s*["']?([^"')]+)/.exec(el.getAttribute('style') ?? '')?.[1] ?? '';
      case 'list':
        return linkLines(Array.from(el.children).filter((c) => linkSig(c) === b.listSig));
    }
  };
  for (const b of scope.bindings) items.forEach((_, i) => (values[i][b.fieldId] = read(b, counterpart(b.el, i))));

  // Merge url fields that always carry the same value (card link, favicon link, title link…).
  const urlFields = scope.fields.filter((f) => f.type === 'url');
  for (let a = 0; a < urlFields.length; a++) {
    for (let b = a + 1; b < urlFields.length; b++) {
      const fa = urlFields[a];
      const fb = urlFields[b];
      if (!scope.fields.includes(fb)) continue;
      if (values.every((v) => v[fa.id] === v[fb.id])) {
        for (const bind of scope.bindings) if (bind.fieldId === fb.id) bind.fieldId = fa.id;
        retarget(template, fb.id, fa.id);
        scope.fields.splice(scope.fields.indexOf(fb), 1);
        values.forEach((v) => delete v[fb.id]);
      }
    }
  }

  // Text fields that are always "<prefix><other field><suffix>" (e.g. "Open {title}") become derived.
  const textish = scope.fields.filter((f) => f.type === 'text');
  for (const f of textish) {
    for (const g of scope.fields.filter((x) => x !== f && (x.type === 'text' || x.type === 'inline_richtext'))) {
      const own = String(values[ti][f.id] ?? '');
      const base = String(values[ti][g.id] ?? '');
      if (!base || own === base || !own.includes(base)) continue;
      const [pre, post] = [own.slice(0, own.indexOf(base)), own.slice(own.indexOf(base) + base.length)];
      if (!values.every((v) => String(v[f.id] ?? '') === pre + String(v[g.id] ?? '') + post)) continue;
      replacePlaceholder(template, f.id, `${pre}{{sf:${g.id}}}${post}`);
      scope.fields.splice(scope.fields.indexOf(f), 1);
      scope.bindings.splice(0, scope.bindings.length, ...scope.bindings.filter((b) => b.fieldId !== f.id));
      values.forEach((v) => delete v[f.id]);
      break;
    }
  }

  // Optional elements → conditionals.
  for (const el of tplEls) {
    if (el === template || el.closest('svg') !== null && el.tagName.toLowerCase() !== 'svg') continue;
    const presence = items.map((_, i) => !!counterpart(el, i));
    if (presence.every(Boolean)) continue;
    if (el.parentElement && el.parentElement !== template && el.parentElement.hasAttribute('data-sf-if')) continue;
    const own = scope.bindings.find((b) => b.el === el && (b.kind === 'html' || b.kind === 'attr'));
    if (own) {
      el.setAttribute('data-sf-if', own.fieldId);
    } else {
      const id = uniqueId(settingId(`show_${baseName(el, template, strip)}`), taken);
      scope.fields.push({ id, type: 'checkbox', label: titleCase(id.replace(/^show_/, 'Show ')), default: true });
      el.setAttribute('data-sf-if', id);
      items.forEach((_, i) => (values[i][id] = presence[i]));
    }
  }

  // Attributes that vary between items.
  for (const el of tplEls) {
    const insts = items.map((_, i) => counterpart(el, i));
    if (insts.some((x) => !x)) continue;
    const names = new Set<string>();
    for (const inst of insts) for (const a of Array.from(inst!.attributes)) names.add(a.name);
    const conditional: string[] = [];
    for (const name of names) {
      if (name.startsWith('data-sf-') || name === 'class' || name === 'style') continue;
      if (scope.bindings.some((b) => b.el === el && b.attr === name)) continue;
      const vals = insts.map((x) => x!.getAttribute(name));
      if (vals.every((v) => v === vals[0])) continue;
      if (vals.some((v) => v === null)) {
        conditional.push(name);
        continue;
      }
      const tpl = el.getAttribute(name);
      if (tpl === null) continue;
      for (const [token, base] of [['{{sf:@index0}}', 0], ['{{sf:@index}}', 1]] as const) {
        const own = String(ti + base);
        if (!tpl.includes(own)) continue;
        const templ = tpl.split(own).join(token);
        if (vals.every((v, i) => templ.split(token).join(String(i + base)) === v)) {
          el.setAttribute(name, templ);
          break;
        }
      }
    }
    if (conditional.length) {
      // Attributes that appear/disappear together become one checkbox (e.g. data-active + aria-current).
      const groups = new Map<string, string[]>();
      for (const a of conditional) {
        const pattern = insts.map((x) => (x!.hasAttribute(a) ? '1' : '0')).join('');
        groups.set(pattern, [...(groups.get(pattern) ?? []), a]);
      }
      const specs: string[] = [];
      for (const [pattern, attrs] of groups) {
        const groupKey = attrs[0].replace(/^(data|aria)-/, '');
        const named = attrs.includes('target') ? 'new_tab' : groupKey === 'current' ? 'active' : groupKey;
        const id = uniqueId(settingId(named), taken);
        const label = named === 'new_tab' ? 'Open links in a new tab' : titleCase(id);
        scope.fields.push({ id, type: 'checkbox', label, default: pattern[ti] === '1' });
        items.forEach((_, i) => (values[i][id] = pattern[i] === '1'));
        for (const a of attrs) if (!el.hasAttribute(a)) el.setAttribute(a, insts.find((x) => x!.hasAttribute(a))!.getAttribute(a)!);
        specs.push(`${id}:${attrs.join(' ')}`);
      }
      el.setAttribute('data-sf-attr-if', specs.join(';'));
    }
  }

  // Derived attributes ("Open Heron AI page", "Heron AI — Button web design example"):
  // substitute every text field found in the value, verify on every item; otherwise the
  // attribute becomes its own setting when it differs between items.
  const textFields = scope.fields
    .filter((x) => x.type === 'text' || x.type === 'inline_richtext')
    .sort((a, b) => String(values[ti][b.id] ?? '').length - String(values[ti][a.id] ?? '').length);
  for (const el of tplEls) {
    for (const attr of DERIVED_ATTRS) {
      const tv = el.getAttribute(attr);
      if (!tv || tv.includes('{{sf:')) continue;
      let templ = tv;
      for (const f of textFields) {
        const ownVal = String(values[ti][f.id] ?? '');
        if (ownVal.length > 1 && templ.includes(ownVal)) templ = templ.split(ownVal).join(`{{sf:${f.id}}}`);
      }
      const render = (i: number) => templ.replace(/\{\{sf:(\w+)\}\}/g, (_m, id: string) => String(values[i][id] ?? ''));
      const instVals = items.map((_, i) => counterpart(el, i)?.getAttribute(attr) ?? null);
      if (templ !== tv && items.every((_, i) => instVals[i] === null || render(i) === instVals[i])) {
        el.setAttribute(attr, templ);
        continue;
      }
      if (instVals.some((v) => v !== null && v !== tv) && attr !== 'placeholder') {
        const id = uniqueId(settingId(`${baseName(el, template, strip)}_${attr.replace(/^(data|aria)-/, '')}`), taken);
        scope.fields.push({ id, type: 'text', label: titleCase(id), default: tv });
        items.forEach((_, i) => (values[i][id] = instVals[i] ?? ''));
        el.setAttribute(attr, `{{sf:${id}}}`);
      }
    }
  }

  // Defaults come from the template item.
  for (const f of scope.fields) if (f.type !== 'checkbox') f.default = values[ti][f.id] as string;

  template.setAttribute('data-sf-repeat', r.blockType);
  template.removeAttribute('data-sf-item');
  for (const it of items) if (it !== template) it.remove();

  return {
    id: r.blockType,
    blockType: r.blockType,
    blockName: r.blockName,
    fields: scope.fields,
    items: values,
    presetCount: Math.min(r.presetCount ?? items.length, items.length),
    max: r.max ?? Math.max(items.length, 12),
  };
}

function replacePlaceholder(scopeRoot: Element, id: string, replacement: string): void {
  const token = `{{sf:${id}}}`;
  const walk = (n: Node) => {
    if (n.nodeType === 3 && (n.textContent ?? '').includes(token)) n.textContent = (n.textContent ?? '').split(token).join(replacement);
    if (n.nodeType === 1) {
      const el = n as Element;
      for (const a of Array.from(el.attributes)) if (a.value.includes(token)) el.setAttribute(a.name, a.value.split(token).join(replacement));
    }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(scopeRoot);
}

function linkSig(el: Element): string {
  if (el.tagName.toLowerCase() !== 'a' || !el.getAttribute('href') || el.children.length) return '';
  return `a.${Array.from(el.classList).sort().join('.')}`;
}

function linkLines(links: Element[]): string {
  return links.map((a) => `${collapseWhitespace(a.textContent ?? '')} | ${a.getAttribute('href') ?? ''}`).join('\n');
}

function retarget(scopeRoot: Element, from: string, to: string): void {
  const re = new RegExp(`\\{\\{sf:${from}\\}\\}`, 'g');
  for (const el of [scopeRoot, ...Array.from(scopeRoot.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) if (a.value.includes(`{{sf:${from}}}`)) el.setAttribute(a.name, a.value.replace(re, `{{sf:${to}}}`));
    if (el.getAttribute('data-sf-if') === from) el.setAttribute('data-sf-if', to);
  }
}

/* ------------------------------------------------------------------------------------------ */

function extractScope(
  scopeRoot: Element,
  walkRoot: Element,
  opts: TemplateOptions & { stripPrefixes?: string[] },
  taken: Set<string>,
  skip: (el: Element) => boolean,
): ScopeResult {
  const fields: FieldIR[] = [];
  const bindings: Binding[] = [];
  const strip = opts.stripPrefixes ?? [];
  const minLen = opts.minTextLength ?? 1;

  const add = (el: Element, type: FieldType, kind: BindingKind, value: string, extra: Partial<Binding> = {}, suffix = '') => {
    const hint = readHint(el) || null;
    let name = baseName(el, scopeRoot, strip);
    if (suffix === '_label' || (kind === 'html' && el.tagName.toLowerCase() === 'a')) {
      name = `${name.replace(/[_-]?link$/, '') || 'link'}_label`;
    } else if (suffix && !name.endsWith(suffix.slice(1))) name += suffix;
    // A hint on a link names its URL; the link text becomes "<name>_label".
    const isLinkText = kind !== 'attr' && el.tagName.toLowerCase() === 'a';
    const base = hint?.id ? (isLinkText ? `${hint.id.replace(/_link$/, '')}_label` : hint.id) : kind === 'list' ? 'links' : name;
    const id = uniqueId(settingId(base), taken);
    const label = hint?.label && !isLinkText ? hint.label : hint?.label ? `${hint.label.replace(/\s*link$/i, '')} label` : titleCase(id);
    const field: FieldIR = { id, type: (!isLinkText && hint?.type) || type, label, default: value };
    if (hint?.group) field.group = hint.group;
    if (hint?.info) field.info = hint.info;
    if (type === 'text' && kind === 'attr' && /video|mp4|webm/.test(value)) field.info = 'Video file URL (upload under Content → Files and paste the link).';
    fields.push(field);
    bindings.push({ fieldId: id, kind, el, ...extra });
    return id;
  };

  const visit = (el: Element) => {
    if (skip(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === 'svg' || el.hasAttribute('data-sf-static')) return;
    const hint = readHint(el);
    if (hint === false) return;

    // attributes
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
        const id = add(el, 'url', 'attr', href, { attr: 'href' }, '_link');
        el.setAttribute('href', `{{sf:${id}}}`);
      }
    }
    if (tag === 'img' && el.getAttribute('src')) {
      const id = add(el, 'image', 'attr', el.getAttribute('src')!, { attr: 'src' });
      el.setAttribute('src', `{{sf:${id}}}`);
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
    }
    if (tag === 'video') {
      const attr = el.hasAttribute('data-src') ? 'data-src' : el.hasAttribute('src') ? 'src' : null;
      if (attr) {
        const id = add(el, 'text', 'attr', el.getAttribute(attr)!, { attr }, '_url');
        el.setAttribute(attr, `{{sf:${id}}}`);
        if (attr === 'data-src') el.removeAttribute('src');
      }
    }
    if (tag === 'input' && el.getAttribute('placeholder')) {
      const id = add(el, 'text', 'attr', el.getAttribute('placeholder')!, { attr: 'placeholder' }, '_placeholder');
      el.setAttribute('placeholder', `{{sf:${id}}}`);
    }
    const style = el.getAttribute('style') ?? '';
    const bg = /background(-image)?\s*:[^;]*url\(\s*["']?([^"')]+)["']?\s*\)/.exec(style);
    if (bg) {
      const id = add(el, 'image', 'style-url', bg[2], {}, '_background');
      el.setAttribute('style', style.replace(bg[2], `{{sf:${id}}}`));
    }

    // runs of plain text links (footer columns…) → one "Label | URL" per line textarea
    const kids = Array.from(el.children);
    const sigs = kids.map(linkSig);
    const listSig = sigs.find((sg, i) => sg && sigs.filter((x) => x === sg).length >= 2 && sigs.indexOf(sg) === i);
    if (listSig) {
      const links = kids.filter((k, i) => sigs[i] === listSig);
      const id = add(el, 'textarea', 'list', linkLines(links), { listSig }, '_links');
      fields.find((x) => x.id === id)!.info = 'One link per line: Label | URL';
      links[0].setAttribute('data-sf-list', id);
      links[0].setAttribute('href', '{{sf:@url}}');
      links[0].textContent = '{{sf:@label}}';
      for (const extra of links.slice(1)) extra.remove();
    }

    // rich text container: only block text children, no direct text
    if (
      kids.length &&
      kids.every((k) => RICH_BLOCK_TAGS.has(k.tagName.toLowerCase()) && k.children.length === Array.from(k.children).filter((c) => INLINE_TAGS.has(c.tagName.toLowerCase()) || c.tagName.toLowerCase() === 'a').length) &&
      directTextNodes(el).length === 0 &&
      kids.some((k) => k.tagName.toLowerCase() === 'p') &&
      (kids.length > 1 || tag === 'div')
    ) {
      const id = add(el, 'richtext', 'html', fieldValueFromHtml(el, 'richtext'));
      el.innerHTML = `{{sf:${id}}}`;
      return;
    }

    // text
    const texts = directTextNodes(el);
    if (texts.length) {
      const leafLike = kids.every((k) => INLINE_TAGS.has(k.tagName.toLowerCase()));
      const fullText = collapseWhitespace(el.textContent ?? '');
      if (leafLike && fullText.length >= minLen && /[\p{L}\p{N}]/u.test(fullText)) {
        const hasBr = !!el.querySelector('br');
        const hasFmt = kids.some((k) => k.tagName.toLowerCase() !== 'br');
        const type: FieldType = hasBr ? 'textarea' : hasFmt || /^h[1-6]$|^p$/.test(tag) ? 'inline_richtext' : 'text';
        const id = add(el, type, 'html', fieldValueFromHtml(el, type));
        el.innerHTML = `{{sf:${id}}}`;
        return;
      }
      texts.forEach((t, i) => {
        const v = collapseWhitespace(t.textContent ?? '');
        if (v.length < minLen || !/[\p{L}\p{N}]/u.test(v)) return;
        const id = add(el, 'text', 'textnode', v, { textIndex: i }, '_label');
        const raw = t.textContent ?? '';
        t.textContent = raw.replace(raw.trim(), `{{sf:${id}}}`);
      });
    }
    for (const k of Array.from(el.children)) if (!k.hasAttribute('data-sf-list')) visit(k);
  };
  visit(walkRoot);
  return { fields, bindings };
}

function applyDerivedAttributes(root: Element, scope: ScopeResult, skip: (el: Element) => boolean): void {
  const textFields = scope.fields.filter((f) => (f.type === 'text' || f.type === 'inline_richtext') && typeof f.default === 'string' && f.default.length > 2);
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (skip(el)) continue;
    for (const attr of DERIVED_ATTRS) {
      const v = el.getAttribute(attr);
      if (!v || v.includes('{{sf:')) continue;
      const f = textFields.find((x) => v.includes(String(x.default)));
      if (f) el.setAttribute(attr, v.split(String(f.default)).join(`{{sf:${f.id}}}`));
    }
  }
}

function readHint(el: Element): RecipeFieldHint | false | null {
  if (el.hasAttribute('data-sf-static')) return false;
  const raw = el.getAttribute('data-sf-hint');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RecipeFieldHint;
  } catch {
    return null;
  }
}

function directTextNodes(el: Element): ChildNode[] {
  return Array.from(el.childNodes).filter((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
}

function fieldValueFromHtml(el: Element, type: FieldType): string {
  if (type === 'textarea') {
    return (el.innerHTML ?? '')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split('\n')
      .map((l) => collapseWhitespace(l))
      .join('\n')
      .trim();
  }
  if (type === 'richtext' || type === 'inline_richtext') {
    return collapseWhitespace(
      (el.innerHTML ?? '')
        .replace(/\s+(class|data-[\w-]+|style)="[^"]*"/g, '')
        .replace(/>\s+</g, '><'),
    );
  }
  return collapseWhitespace(el.textContent ?? '');
}

const TAG_ROLE: Record<string, string> = {
  h1: 'heading',
  h2: 'heading',
  h3: 'subheading',
  h4: 'subheading',
  p: 'text',
  a: 'link',
  button: 'button',
  img: 'image',
  span: 'label',
  li: 'item',
  input: 'input',
  video: 'video',
  label: 'label',
};

function baseName(el: Element, scopeRoot: Element, strip: string[]): string {
  const roleOf = (e: Element) => TAG_ROLE[e.tagName.toLowerCase()] ?? e.tagName.toLowerCase();
  for (let e: Element | null = el; e; e = e.parentElement) {
    // Most specific class: no BEM modifier, longest name.
    const cls = Array.from(e.classList)
      .filter((c) => !isScopeClass(c))
      .sort((a, b) => Number(a.includes('--')) - Number(b.includes('--')) || b.length - a.length)[0];
    if (cls) {
      let n = cls;
      for (const p of strip) if (n.startsWith(p) && n.length > p.length) n = n.slice(p.length);
      // The repeater's own root class says nothing about a field inside it.
      if (strip.some((p) => p.length > 1 && n === p.slice(0, -1))) return roleOf(el);
      n = n.replace(/__/g, '_').replace(/--/g, '_');
      return e === el ? n : `${n}_${roleOf(el)}`;
    }
    if (e === scopeRoot) break;
  }
  return roleOf(el);
}

/** tag.class.class:n path from scope root, robust to optional siblings with other classes. */
function structuralPath(el: Element, scopeRoot: Element): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && e !== scopeRoot; e = e.parentElement) {
    const key = (x: Element) =>
      `${x.tagName.toLowerCase()}.${Array.from(x.classList)
        .filter((c) => !isScopeClass(c))
        .sort()
        .join('.')}`;
    const k = key(e);
    const parent: Element | null = e.parentElement;
    const n = parent ? Array.from(parent.children).filter((s) => key(s) === k).indexOf(e) : 0;
    parts.unshift(`${k}:${n}`);
  }
  return parts.join('/');
}
