import { parseHTML } from 'linkedom';
import type { FieldIR, SectionIR } from '@sf/core';
import { escapeHtml } from '@sf/core';

type Values = Record<string, string | number | boolean | undefined>;

export interface StaticRenderOptions {
  mode?: string;
  /** Rewrites asset paths (assets/x.webp) to their published location */
  assetUrl?: (path: string) => string;
  /** Number of repeater items to render (default: all source items) */
  limitItems?: (repeaterId: string, available: number) => number;
}

/** Renders the annotated template with field defaults / repeater items → plain HTML. */
export function renderStatic(ir: SectionIR, opts: StaticRenderOptions = {}): string {
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${ir.template}</body></html>`);
  const root = document.body.firstElementChild as Element;
  const sectionValues: Values = Object.fromEntries(ir.fields.map((f) => [f.id, f.default]));
  const asset = opts.assetUrl ?? ((p: string) => p);

  const expanded: string[] = [];
  for (const tpl of Array.from(root.querySelectorAll('[data-sf-repeat]'))) {
    const rep = ir.repeaters.find((r) => r.id === tpl.getAttribute('data-sf-repeat'));
    tpl.removeAttribute('data-sf-repeat');
    if (!rep) continue;
    const n = opts.limitItems ? opts.limitItems(rep.id, rep.items.length) : rep.items.length;
    const parts: string[] = [];
    rep.items.slice(0, n).forEach((item, i) => {
      const clone = tpl.cloneNode(true) as Element;
      applyConditions(clone, item);
      parts.push(fill(clone.outerHTML, rep.fields, item, asset, i));
    });
    tpl.replaceWith(document.createComment(`sf-repeat-${expanded.length}`));
    expanded.push(parts.join('\n'));
  }
  applyConditions(root, sectionValues);
  if (ir.modes) root.setAttribute(ir.modes.attribute, opts.mode ?? ir.modes.default);

  const html = root.outerHTML.replace(/<!--sf-repeat-(\d+)-->/g, (_m, i: string) => expanded[Number(i)] ?? '');
  return fill(html, ir.fields, sectionValues, asset, 0);
}

function expandLists(scope: Element, values: Values): void {
  for (const tpl of Array.from(scope.querySelectorAll('[data-sf-list]'))) {
    const id = tpl.getAttribute('data-sf-list')!;
    if (!(id in values)) continue;
    tpl.removeAttribute('data-sf-list');
    for (const line of String(values[id] ?? '').split('\n')) {
      if (!line.trim()) continue;
      const [label, url] = line.split('|').map((x) => x.trim());
      const clone = tpl.cloneNode(true) as Element;
      clone.setAttribute('href', url || '#');
      clone.textContent = label;
      tpl.parentNode!.insertBefore(clone, tpl);
    }
    tpl.remove();
  }
}

function applyConditions(scope: Element, values: Values): void {
  expandLists(scope, values);
  const truthy = (v: unknown) => v !== undefined && v !== null && v !== false && v !== '';
  for (const el of [scope, ...Array.from(scope.querySelectorAll('[data-sf-if]'))]) {
    const f = el.getAttribute('data-sf-if');
    if (!f || !(f in values)) continue;
    if (!truthy(values[f])) el.remove();
    else el.removeAttribute('data-sf-if');
  }
  for (const el of [scope, ...Array.from(scope.querySelectorAll('[data-sf-attr-if]'))]) {
    const spec = el.getAttribute('data-sf-attr-if');
    if (!spec) continue;
    for (const part of spec.split(';')) {
      const [f, attrs] = part.split(':');
      if (!(f in values)) continue;
      if (!truthy(values[f])) for (const a of attrs.split(' ')) el.removeAttribute(a);
    }
    el.removeAttribute('data-sf-attr-if');
  }
}

function fill(html: string, fields: FieldIR[], values: Values, asset: (p: string) => string, index: number): string {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return html.replace(/\{\{sf:(@?[\w]+)\}\}/g, (m, id: string) => {
    if (id === '@index0') return String(index);
    if (id === '@index') return String(index + 1);
    const f = byId.get(id);
    if (!f) return m;
    const v = values[id];
    if (v === undefined || v === null) return '';
    const s = String(v);
    switch (f.type) {
      case 'inline_richtext':
      case 'richtext':
        return s;
      case 'textarea':
        return escapeHtml(s).replace(/\n/g, '<br>');
      case 'image':
        return escapeHtml(s.startsWith('assets/') ? asset(s) : s);
      default:
        return escapeHtml(s);
    }
  });
}
