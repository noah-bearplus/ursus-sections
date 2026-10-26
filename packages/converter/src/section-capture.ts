import type { Page } from 'playwright-core';
import type { PrepareOp, Recipe, RecipeSection } from '@sf/core';

/** One complex selector of the source CSS, prepared for in-browser evaluation. */
export interface TestSelector {
  id: number;
  /** Selector with pseudo-elements, dynamic pseudo-classes and state toggles stripped */
  test: string;
  /** Test-version compounds (same count/positions as the original selector's compounds) */
  compounds: { combinator: string; text: string }[];
}

/** How a selector maps into the section, chosen by verifying match sets in the browser. */
export interface Placement {
  /** Compounds [0, k) are outer context (dropped) */
  k: number;
  /** A: compound k is the section root · B: compound k is inside the root · C: both */
  v: 'A' | 'B' | 'C';
  /** Mode condition carried by the outer context, e.g. [data-theme="dark"] */
  cond: string;
  approx?: boolean;
}

export interface MatchResult {
  /** selector id → mode → placement */
  placements: Record<number, Record<string, Placement>>;
  /** selector id → mode → ancestor depths (0 = <html>) it matches */
  ancestors: Record<number, Record<string, number[]>>;
  ancestorCount: number;
}

export interface CapturedSection {
  html: string;
  elementCount: number;
  classes: string[];
  removedHidden: number;
}

/* ------------------------------------------------------------------------------------------ */

export interface PrepareResult {
  elements: number;
  /** Repeaters detected automatically when the recipe does not declare any */
  autoRepeaters: { blockType: string; count: number; signature: string }[];
}

export async function prepareSectionDom(page: Page, section: RecipeSection, behaviorRoles: { role: string; selector: string }[]): Promise<PrepareResult> {
  return page.evaluate(prepareInPage, {
    autoRepeat: section.repeaters === undefined,
    rootSelector: section.selector,
    remove: section.remove ?? [],
    prepare: section.prepare ?? [],
    repeaters: (section.repeaters ?? []).map((r) => ({ item: r.item, id: r.blockType })),
    hints: Object.entries(section.fields ?? {}).map(([selector, hint]) => ({ selector, hint: hint === false ? 'false' : JSON.stringify(hint) })),
    roles: behaviorRoles,
    keep: section.keep ?? [],
  });
}

export async function hiddenElementIds(page: Page, rootSelector: string): Promise<string[]> {
  return page.evaluate(hiddenInPage, rootSelector);
}

export async function removeElements(page: Page, rootSelector: string, eids: string[]): Promise<number> {
  return page.evaluate(removeInPage, { rootSelector, eids });
}

export async function matchSelectors(page: Page, recipe: Recipe, section: RecipeSection, selectors: TestSelector[]): Promise<MatchResult> {
  return page.evaluate(matchInPage, {
    rootSelector: section.selector,
    selectors,
    modes: recipe.modes?.values ?? ['default'],
    modeSelector: recipe.modes?.selector ?? null,
    modeAttr: recipe.modes?.attribute ?? null,
  });
}

export async function serializeSection(page: Page, rootSelector: string): Promise<CapturedSection> {
  return page.evaluate(serializeInPage, rootSelector);
}

/* ---------------------------- functions below run in the page ---------------------------- */

function prepareInPage(input: {
  autoRepeat: boolean;
  rootSelector: string;
  remove: string[];
  prepare: PrepareOp[];
  repeaters: { item: string; id: string }[];
  hints: { selector: string; hint: string }[];
  roles: { role: string; selector: string }[];
  keep: string[];
}): PrepareResult {
  const root = document.querySelector(input.rootSelector);
  if (!root) throw new Error(`Section root not found: ${input.rootSelector}`);
  const within = (sel: string): Element[] => {
    try {
      return [...(root.matches(sel) ? [root] : []), ...Array.from(root.querySelectorAll(sel))];
    } catch {
      return [];
    }
  };
  for (const op of input.prepare) {
    for (let el of within(op.selector)) {
      if (op.retag && el.tagName.toLowerCase() !== op.retag) {
        const n = document.createElement(op.retag);
        for (const a of Array.from(el.attributes)) n.setAttribute(a.name, a.value);
        while (el.firstChild) n.appendChild(el.firstChild);
        el.replaceWith(n);
        el = n;
      }
      for (const a of op.removeAttr ?? []) el.removeAttribute(a);
      for (const c of op.removeClass ?? []) el.classList.remove(c);
      for (const [k, v] of Object.entries(op.setAttr ?? {})) el.setAttribute(k, v);
      if (op.removeStyle && el instanceof HTMLElement) for (const p of op.removeStyle) el.style.removeProperty(p);
      if (op.text !== undefined) el.textContent = op.text;
      if (op.wrap) {
        const [tag, ...cls] = op.wrap.split('.');
        const w = document.createElement(tag || 'div');
        if (cls.length) w.className = cls.join(' ');
        // Keep component scoping so the wrapper is styled like its siblings' equivalents.
        for (const a of Array.from(el.attributes)) if (/^data-(astro-cid-|v-)/.test(a.name)) w.setAttribute(a.name, a.value);
        el.replaceWith(w);
        w.appendChild(el);
      }
    }
  }
  for (const sel of input.remove) for (const el of within(sel)) if (el !== root) el.remove();
  // Lazy images that never loaded: promote data-src so the template has a real source.
  for (const img of within('img[data-src]')) {
    if (!img.getAttribute('src') || img.getAttribute('src')!.startsWith('data:')) img.setAttribute('src', img.getAttribute('data-src')!);
    img.removeAttribute('data-src');
  }
  for (const t of Array.from(root.querySelectorAll('template, script, noscript'))) t.remove();
  for (const r of input.repeaters) for (const el of within(r.item)) el.setAttribute('data-sf-item', r.id);
  for (const h of input.hints) for (const el of within(h.selector)) el.setAttribute(h.hint === 'false' ? 'data-sf-static' : 'data-sf-hint', h.hint === 'false' ? '' : h.hint);
  for (const r of input.roles) for (const el of within(r.selector)) el.setAttribute('data-sf-role', [el.getAttribute('data-sf-role'), r.role].filter(Boolean).join(' '));
  for (const sel of input.keep) for (const el of within(sel)) el.setAttribute('data-sf-keep', '');
  const autoRepeaters: PrepareResult['autoRepeaters'] = [];
  if (input.autoRepeat) {
    // Siblings sharing tag + class signature (≥3) are repeated items; outermost groups win.
    const sig = (e: Element) => `${e.tagName.toLowerCase()}.${Array.from(e.classList).sort().join('.')}`;
    const groups: { parent: Element; sig: string; items: Element[] }[] = [];
    for (const parent of [root, ...Array.from(root.querySelectorAll('*'))]) {
      if (parent.closest('svg') || parent.closest('[data-sf-static]')) continue;
      const bySig = new Map<string, Element[]>();
      for (const c of Array.from(parent.children)) bySig.set(sig(c), [...(bySig.get(sig(c)) ?? []), c]);
      for (const [s, items] of bySig) if (items.length >= 3 && items.some((i) => i.children.length > 0 || (i.textContent ?? '').trim())) groups.push({ parent, sig: s, items });
    }
    let n = 0;
    for (const g of groups) {
      if (g.items.some((i) => i.closest('[data-sf-item]'))) continue;
      const cls = g.items[0].classList[0] ?? g.items[0].tagName.toLowerCase();
      const blockType = `${cls.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}${n ? '_' + n : ''}`;
      n++;
      for (const i of g.items) i.setAttribute('data-sf-item', blockType);
      autoRepeaters.push({ blockType, count: g.items.length, signature: g.sig });
    }
  }
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  all.forEach((el, i) => el.setAttribute('data-sf-eid', String(i)));
  return { elements: all.length, autoRepeaters };
}

function hiddenInPage(rootSelector: string): string[] {
  const root = document.querySelector(rootSelector)!;
  const out: string[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children)) {
      if (c.closest('svg') && c.tagName.toLowerCase() !== 'svg') continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none') out.push(c.getAttribute('data-sf-eid') ?? '');
      else walk(c);
    }
  };
  walk(root);
  return out;
}

function removeInPage(input: { rootSelector: string; eids: string[] }): number {
  const root = document.querySelector(input.rootSelector)!;
  let n = 0;
  for (const id of input.eids) {
    const el = root.querySelector(`[data-sf-eid="${id}"]`);
    if (!el) continue;
    // Protected: behaviour targets (menus that open), explicit keeps, or anything containing them.
    if (el.matches('[data-sf-role],[data-sf-keep]') || el.querySelector('[data-sf-role],[data-sf-keep]')) continue;
    el.remove();
    n++;
  }
  return n;
}

function matchInPage(input: {
  rootSelector: string;
  selectors: TestSelector[];
  modes: string[];
  modeSelector: string | null;
  modeAttr: string | null;
}): MatchResult {
  const root = document.querySelector(input.rootSelector)!;
  const els = [root, ...Array.from(root.querySelectorAll('*'))];
  const index = new Map<Element, number>(els.map((e, i) => [e, i]));
  const ancestors: Element[] = [];
  for (let a = root.parentElement; a; a = a.parentElement) ancestors.unshift(a);
  const modeEl = input.modeSelector ? document.querySelector(input.modeSelector) : null;
  const originalMode = modeEl && input.modeAttr ? modeEl.getAttribute(input.modeAttr) : null;
  const rootHadModeAttr = input.modeAttr ? root.getAttribute(input.modeAttr) : null;

  const key = (sel: string): string | null => {
    try {
      const list: number[] = [];
      if (root.matches(sel)) list.push(0);
      root.querySelectorAll(sel).forEach((e) => {
        const i = index.get(e);
        if (i !== undefined) list.push(i);
      });
      return list.join(',');
    } catch {
      return null;
    }
  };
  const join = (cs: { combinator: string; text: string }[]) =>
    cs.map((c, i) => (i === 0 ? c.text : c.combinator === ' ' ? ` ${c.text}` : ` ${c.combinator} ${c.text}`)).join('');
  // Insert the scope after a leading type selector: header.x → header[data-sf-scope].x
  const anchor = (compound: string, scope: string) => {
    const m = /^([a-zA-Z][\w-]*|\*)/.exec(compound);
    if (!m) return scope + compound;
    return m[1] === '*' ? scope + compound.slice(1) : m[1] + scope + compound.slice(m[1].length);
  };
  const modeRe = input.modeAttr ? new RegExp(`\\[${input.modeAttr}=["']?([\\w-]+)["']?\\]`) : null;

  const placements: MatchResult['placements'] = {};
  const anc: MatchResult['ancestors'] = {};
  for (const mode of input.modes) {
    if (modeEl && input.modeAttr) modeEl.setAttribute(input.modeAttr, mode);
    for (const s of input.selectors) {
      const depths: number[] = [];
      ancestors.forEach((a, d) => {
        try {
          if (a.matches(s.test)) depths.push(d);
        } catch {
          /* invalid selector in this engine */
        }
      });
      if (depths.length) (anc[s.id] ??= {})[mode] = depths;
      const target = key(s.test);
      if (!target) continue;

      root.setAttribute('data-sf-scope', '');
      if (input.modeAttr) root.setAttribute(input.modeAttr, mode);
      let choice: Placement | null = null;
      const n = s.compounds.length;
      for (let k = 0; k < n && !choice; k++) {
        const outer = s.compounds.slice(0, k).map((c) => c.text).join(' ');
        const mm = modeRe ? modeRe.exec(outer) : null;
        const cond = mm && input.modeAttr ? `[${input.modeAttr}="${mm[1]}"]` : '';
        const restJoined = s.compounds
          .slice(k + 1)
          .map((c) => (c.combinator === ' ' ? ` ${c.text}` : ` ${c.combinator} ${c.text}`))
          .join('');
        const a = anchor(s.compounds[k].text, `[data-sf-scope]${cond}`) + restJoined;
        const b = `[data-sf-scope]${cond} ${join(s.compounds.slice(k).map((c, i) => (i === 0 ? { ...c, combinator: '' } : c)))}`;
        const ka = key(a);
        if (ka === target) {
          choice = { k, v: 'A', cond };
          break;
        }
        const kb = key(b);
        if (kb === target) {
          choice = { k, v: 'B', cond };
          break;
        }
        if (ka && kb) {
          const u = [...new Set([...ka.split(','), ...kb.split(',')].map(Number))].sort((x, y) => x - y).join(',');
          if (u === target) choice = { k, v: 'C', cond };
        }
      }
      root.removeAttribute('data-sf-scope');
      if (input.modeAttr) {
        if (rootHadModeAttr === null) root.removeAttribute(input.modeAttr);
        else root.setAttribute(input.modeAttr, rootHadModeAttr);
      }
      (placements[s.id] ??= {})[mode] = choice ?? { k: n - 1, v: 'B', cond: '', approx: true };
    }
  }
  if (modeEl && input.modeAttr) {
    if (originalMode === null) modeEl.removeAttribute(input.modeAttr);
    else modeEl.setAttribute(input.modeAttr, originalMode);
  }
  return { placements, ancestors: anc, ancestorCount: ancestors.length };
}

function serializeInPage(rootSelector: string): CapturedSection {
  const root = document.querySelector(rootSelector)!;
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  const classes = new Set<string>();
  for (const el of all) {
    el.removeAttribute('data-sf-eid');
    el.removeAttribute('data-sf-scope');
    for (const c of Array.from(el.classList)) classes.add(c);
  }
  return { html: root.outerHTML, elementCount: all.length, classes: [...classes], removedHidden: 0 };
}
