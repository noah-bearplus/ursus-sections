import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from 'postcss';

export interface FlatRule {
  idx: number;
  /** Complex selectors of the rule (split on top-level commas). */
  selectors: string[];
  decls: { prop: string; value: string; important: boolean }[];
  /** Enclosing conditional at-rules, outermost first, e.g. ["@media (max-width:768px)"] */
  context: string[];
  /** True when the rule defines document-level tokens (:root, [data-theme=x]…) */
  global: boolean;
}

export interface FlatKeyframes {
  name: string;
  context: string[];
  css: string;
}

export interface FlatFontFace {
  family: string;
  css: string;
}

export interface FlatCss {
  rules: FlatRule[];
  keyframes: FlatKeyframes[];
  fontFaces: FlatFontFace[];
}

const CONDITIONAL = new Set(['media', 'supports', 'container', 'layer']);

function splitList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of selector) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function isGlobalTokenSelector(sel: string, modeAttr?: string): boolean {
  return splitList(sel).every((s) => {
    if (/^(:root|html|:host)$/.test(s)) return true;
    if (modeAttr && new RegExp(`^(:root|html)?\\[${modeAttr}=["']?[\\w-]+["']?\\]$`).test(s)) return true;
    return false;
  });
}

/** Flattens stylesheets (in cascade order) into rules with their at-rule context. */
export function flattenCss(sheets: string[], modeAttr?: string): FlatCss {
  const rules: FlatRule[] = [];
  const keyframes: FlatKeyframes[] = [];
  const fontFaces: FlatFontFace[] = [];

  const walk = (container: Container<ChildNode>, context: string[]) => {
    container.each((node) => {
      if (node.type === 'rule') {
        const r = node as Rule;
        const decls: FlatRule['decls'] = [];
        r.each((d) => {
          if (d.type === 'decl') decls.push({ prop: (d as Declaration).prop, value: (d as Declaration).value, important: !!(d as Declaration).important });
        });
        // Nested rules (CSS nesting) are rare in production bundles; flatten their selectors naively.
        r.each((child) => {
          if (child.type === 'rule') {
            const nested = child as Rule;
            const sel = splitList(nested.selector)
              .flatMap((ns) => splitList(r.selector).map((ps) => (ns.includes('&') ? ns.replace(/&/g, ps) : `${ps} ${ns}`)))
              .join(',');
            const clone = nested.clone({ selector: sel });
            walk(postcss.root().append(clone), context);
          }
        });
        if (decls.length) {
          rules.push({ idx: rules.length, selectors: splitList(r.selector), decls, context, global: isGlobalTokenSelector(r.selector, modeAttr) });
        }
      } else if (node.type === 'atrule') {
        const a = node as AtRule;
        const name = a.name.toLowerCase();
        if (CONDITIONAL.has(name)) {
          if (a.nodes) walk(a, [...context, `@${a.name} ${a.params}`.trim()]);
        } else if (name.endsWith('keyframes')) {
          keyframes.push({ name: a.params.trim(), context, css: a.toString() });
        } else if (name === 'font-face') {
          let family = '';
          a.walkDecls('font-family', (d) => {
            family = d.value.replace(/^['"]|['"]$/g, '');
          });
          fontFaces.push({ family, css: a.toString() });
        }
      }
    });
  };

  for (const css of sheets) {
    try {
      walk(postcss.parse(css), []);
    } catch (e) {
      // A broken sheet should not stop the pipeline.
      console.warn(`[css-collect] skipped unparsable stylesheet: ${(e as Error).message}`);
    }
  }
  return { rules, keyframes, fontFaces };
}
