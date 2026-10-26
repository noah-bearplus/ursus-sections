import selectorParser from 'postcss-selector-parser';

type Node = selectorParser.Node;
type Selector = selectorParser.Selector;

/** Pseudo-classes whose truth depends on user interaction / runtime state. */
const DYNAMIC_PSEUDOS = new Set([
  ':hover',
  ':active',
  ':focus',
  ':focus-visible',
  ':focus-within',
  ':visited',
  ':link',
  ':any-link',
  ':target',
  ':checked',
  ':indeterminate',
  ':placeholder-shown',
  ':autofill',
  ':-webkit-autofill',
  ':user-invalid',
  ':invalid',
  ':valid',
  ':popover-open',
  ':open',
  ':modal',
  ':fullscreen',
  ':playing',
  ':paused',
  ':-moz-focusring',
  ':-moz-ui-invalid',
]);

const LEGACY_PSEUDO_ELEMENTS = new Set([':before', ':after', ':first-line', ':first-letter', ':marker', ':placeholder', ':selection']);

/** Attribute/class names that commonly toggle at runtime (open/active/expanded states). */
const STATE_ATTR = /^(data-(open|state|active|expanded|selected|visible|playing|ready|loaded|current|enter-[\w-]+|should-play)|aria-(expanded|pressed|selected|checked|current|hidden)|open|hidden)$/;
const STATE_CLASS = /^(is-[\w-]+|has-[\w-]+|active|open|opened|show|shown|visible|selected|current|expanded)$/;

export interface FrameworkScrub {
  /** Attribute name patterns that are framework scoping artefacts (removed from HTML and selectors). */
  attributes: RegExp[];
}

export const DEFAULT_SCRUB: FrameworkScrub = {
  attributes: [/^data-astro-cid-/, /^data-v-[0-9a-f]{6,}$/, /^_ngcontent-/, /^_nghost-/, /^data-svelte-h$/, /^data-reactroot$/],
};

export function splitSelectorList(selector: string): string[] {
  try {
    return selectorParser().astSync(selector).nodes.map((n) => n.toString().trim());
  } catch {
    return [selector];
  }
}

function isPseudoElement(n: Node): boolean {
  return n.type === 'pseudo' && (n.value.startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(n.value.toLowerCase()));
}

function isFrameworkAttr(n: Node, scrub: FrameworkScrub): boolean {
  return n.type === 'attribute' && isFrameworkAttrName((n as selectorParser.Attribute).attribute, scrub);
}

export function isFrameworkAttrName(name: string, scrub: FrameworkScrub = DEFAULT_SCRUB): boolean {
  return scrub.attributes.some((re) => re.test(name));
}

/**
 * Component-scoping attributes ([data-astro-cid-x], [data-v-x]) carry meaning: they keep one
 * component's ".wrapper" from styling another's. They become classes instead of disappearing.
 */
export function frameworkClass(attrName: string): string {
  return attrName.replace(/^data-/, '').replace(/^_+/, '').replace(/^astro-/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * Removes everything from a selector that cannot be evaluated statically, so we can ask
 * "could this rule ever apply to an element of the section?":
 *  - pseudo-elements, dynamic pseudo-classes (:hover…)
 *  - optionally, runtime state attributes/classes ([data-open], .is-active…)
 *  - framework scoping attributes ([data-astro-cid-x])
 */
export function toTestSelector(selector: string, opts: { stripState: boolean; scrub: FrameworkScrub }): string | null {
  try {
    const out = selectorParser((root) => {
      root.walk((n) => {
        if (isPseudoElement(n)) n.remove();
        else if (n.type === 'pseudo' && DYNAMIC_PSEUDOS.has(n.value.toLowerCase())) n.remove();
        else if (opts.stripState && n.type === 'attribute' && STATE_ATTR.test((n as selectorParser.Attribute).attribute)) n.remove();
        else if (opts.stripState && n.type === 'class' && STATE_CLASS.test(n.value)) n.remove();
      });
      // :not() / :is() that became empty
      root.walk((n) => {
        if (n.type === 'pseudo' && (n as selectorParser.Pseudo).nodes.length) {
          const p = n as selectorParser.Pseudo;
          for (const s of [...p.nodes]) if (!s.nodes.length || s.toString().trim() === '') s.remove();
          if (!p.nodes.length) {
            if (/^:(not|is|where|has)$/i.test(p.value)) p.remove();
          }
        }
      });
      fillEmptyCompounds(root);
    }).processSync(selector);
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** After removals a compound like ".a > [x]" may become ".a > " → put a universal selector there. */
export function fillEmptyCompounds(root: selectorParser.Root): void {
  root.each((sel) => {
    const nodes = sel.nodes;
    const needsStar: number[] = [];
    let compoundEmpty = true;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type === 'combinator') {
        if (compoundEmpty) needsStar.push(i);
        compoundEmpty = true;
      } else if (n.type !== 'comment') compoundEmpty = false;
    }
    if (compoundEmpty && nodes.length) needsStar.push(nodes.length);
    for (const idx of needsStar.reverse()) {
      const star = selectorParser.universal();
      if (idx >= sel.nodes.length) sel.append(star);
      else sel.insertBefore(sel.nodes[idx], star);
    }
  });
}

export interface Compound {
  /** Combinator that precedes this compound (' ', '>', '+', '~'), '' for the first */
  combinator: string;
  text: string;
}

export function compoundsOf(selector: string): Compound[] {
  const out: Compound[] = [];
  try {
    const ast = selectorParser().astSync(selector);
    const sel = ast.nodes[0];
    let cur: string[] = [];
    let comb = '';
    for (const n of sel.nodes) {
      if (n.type === 'combinator') {
        out.push({ combinator: comb, text: cur.join('') });
        comb = n.value.trim() || ' ';
        cur = [];
      } else cur.push(n.toString());
    }
    out.push({ combinator: comb, text: cur.join('') });
  } catch {
    out.push({ combinator: '', text: selector });
  }
  return out.map((c) => ({ ...c, text: c.text.trim() }));
}

export function specificity(selector: string): [number, number, number] {
  let a = 0;
  let b = 0;
  let c = 0;
  try {
    const ast = selectorParser().astSync(selector);
    ast.walk((n) => {
      if (n.type === 'id') a++;
      else if (n.type === 'class' || n.type === 'attribute') b++;
      else if (n.type === 'pseudo') {
        const v = n.value.toLowerCase();
        if (v === ':where') return false;
        if (v.startsWith('::') || LEGACY_PSEUDO_ELEMENTS.has(v)) c++;
        else if (!/^:(not|is|has)$/.test(v)) b++;
      } else if (n.type === 'tag') c++;
      return undefined;
    });
  } catch {
    /* ignore */
  }
  return [a, b, c];
}

export interface RewriteOptions {
  classPrefix: string;
  idPrefix: string;
  scrub: FrameworkScrub;
  /** Selector of the section scope, e.g. ".sf-dtl-hero" */
  scope: string;
}

/** Inserts `scope` into a compound after its type selector: header.x → header.sf-root.x */
export function anchorCompound(compound: string, scope: string): string {
  const m = /^([a-zA-Z][\w-]*|\*)/.exec(compound);
  if (!m) return scope + compound;
  return m[1] === '*' ? scope + compound.slice(1) : m[1] + scope + compound.slice(m[1].length);
}

/**
 * Rewrites one complex selector for use inside the section, given where it was found to
 * apply (see section-capture Placement):
 *   html[data-theme=dark] .app > header .nav a:hover   (k=2, v=A, cond=[data-theme="dark"])
 *     → header.sf-dtl-header[data-theme="dark"] .dtl-nav a:hover
 */
export function rewriteSelector(selector: string, placement: { k: number; v: 'A' | 'B' | 'C'; cond: string }, opts: RewriteOptions): string[] {
  const comps = compoundsOf(selector);
  const inner = comps.slice(placement.k).map((c, i) => ({ combinator: i === 0 ? '' : c.combinator, text: renameCompound(c.text, opts) }));
  if (!inner.length) return [];
  const scope = opts.scope + placement.cond;
  const out: string[] = [];
  if (placement.v === 'A' || placement.v === 'C') {
    out.push(anchorCompound(inner[0].text, scope) + joinCompounds(inner.slice(1), true));
  }
  if (placement.v === 'B' || placement.v === 'C') {
    out.push(`${scope} ${joinCompounds(inner)}`);
  }
  return out;
}

function joinCompounds(cs: Compound[], continuation = false): string {
  return cs
    .map((c, i) => (i === 0 && !continuation ? c.text : c.combinator === ' ' || c.combinator === '' ? ` ${c.text}` : ` ${c.combinator} ${c.text}`))
    .join('');
}

export function renameCompound(text: string, opts: Pick<RewriteOptions, 'classPrefix' | 'idPrefix' | 'scrub'>): string {
  try {
    const out = selectorParser((root) => {
      root.walk((n) => {
        if (n.type === 'class') n.value = prefixName(n.value, opts.classPrefix);
        else if (n.type === 'id') n.value = prefixName(n.value, opts.idPrefix);
        else if (isFrameworkAttr(n, opts.scrub)) n.replaceWith(selectorParser.className({ value: prefixName(frameworkClass((n as selectorParser.Attribute).attribute), opts.classPrefix) }));
        else if (n.type === 'attribute') {
          const a = n as selectorParser.Attribute;
          // [id=x] / [for=x] / [aria-controls=x] refer to renamed ids
          if (['id', 'for', 'aria-controls', 'aria-labelledby'].includes(a.attribute) && a.value) a.value = prefixName(a.value, opts.idPrefix);
          if (a.attribute === 'class' && a.value) a.value = prefixName(a.value, opts.classPrefix);
        }
      });
      fillEmptyCompounds(root);
    }).processSync(text);
    return out.trim() || '*';
  } catch {
    return text;
  }
}

export function prefixName(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name : prefix + name;
}

/** Class names, ids and attribute names referenced by a selector (used to prune HTML). */
export function referencedNames(selector: string): { classes: string[]; ids: string[]; attrs: string[] } {
  const classes: string[] = [];
  const ids: string[] = [];
  const attrs: string[] = [];
  try {
    selectorParser().astSync(selector).walk((n) => {
      if (n.type === 'class') classes.push(n.value);
      else if (n.type === 'id') ids.push(n.value);
      else if (n.type === 'attribute') {
        const a = (n as selectorParser.Attribute).attribute;
        if (isFrameworkAttrName(a)) classes.push(frameworkClass(a));
        else attrs.push(a);
      }
    });
  } catch {
    /* ignore */
  }
  return { classes, ids, attrs };
}

export type { Selector };

/** Removes class selectors matching `test` (keeps the selector valid by filling empty compounds). */
export function stripClasses(selector: string, test: (cls: string) => boolean): string {
  try {
    return selectorParser((root) => {
      root.walkClasses((c) => {
        if (test(c.value)) c.remove();
      });
      fillEmptyCompounds(root);
    })
      .processSync(selector)
      .trim();
  } catch {
    return selector;
  }
}
