import postcss, { type AtRule, type Root, type Rule } from 'postcss';

export interface CustomPropDecl {
  name: string;
  value: string;
  selector: string;
  media?: string;
  /** Colour mode this declaration belongs to (undefined = base) */
  mode?: string;
  /** true when the selector targets the document root (global token) */
  global: boolean;
}

export interface FontFaceDecl {
  family: string;
  weight?: string;
  style?: string;
  src: string;
  urls: string[];
}

export function parseCss(css: string, from?: string): Root {
  return postcss.parse(css, { from });
}

function mediaOf(node: Rule): string | undefined {
  const parts: string[] = [];
  for (let p = node.parent; p && p.type !== 'root'; p = p.parent as typeof p) {
    if (p.type === 'atrule' && (p as AtRule).name === 'media') parts.unshift((p as AtRule).params);
  }
  return parts.length ? parts.join(' and ') : undefined;
}

/** Selectors that define document-level tokens: :root, html, body, [data-theme=x], html[data-theme=x]… */
function classifyRootSelector(selector: string, modeAttr?: string): { global: boolean; mode?: string } {
  const parts = selector.split(',').map((s) => s.trim());
  let mode: string | undefined;
  let global = false;
  for (const p of parts) {
    const m = modeAttr ? new RegExp(`^(?::root|html)?\\[${modeAttr}=["']?([\\w-]+)["']?\\]$`).exec(p) : null;
    if (m) {
      // ":root,[data-theme=light]" means the light values are also the base
      mode = parts.some((x) => x === ':root' || x === 'html') ? undefined : m[1];
      global = true;
    } else if (p === ':root' || p === 'html' || p === ':host' || p === 'body') {
      global = true;
    }
  }
  return { global, mode };
}

export function collectCustomProps(roots: Root[], modeAttr?: string): CustomPropDecl[] {
  const out: CustomPropDecl[] = [];
  for (const root of roots) {
    root.walkRules((rule) => {
      if (rule.parent?.type === 'atrule' && /keyframes/.test((rule.parent as AtRule).name)) return;
      const { global, mode } = classifyRootSelector(rule.selector, modeAttr);
      rule.each((node) => {
        if (node.type === 'decl' && node.prop.startsWith('--')) {
          out.push({
            name: node.prop.slice(2),
            value: node.value.trim(),
            selector: rule.selector,
            media: mediaOf(rule),
            mode,
            global,
          });
        }
      });
    });
  }
  return out;
}

export function collectFontFaces(roots: Root[]): FontFaceDecl[] {
  const out: FontFaceDecl[] = [];
  for (const root of roots) {
    root.walkAtRules('font-face', (at) => {
      const get = (p: string) => {
        let v: string | undefined;
        at.walkDecls(p, (d) => {
          v = d.value;
        });
        return v;
      };
      const src = get('src') ?? '';
      const urls = [...src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
      out.push({ family: (get('font-family') ?? '').replace(/^['"]|['"]$/g, ''), weight: get('font-weight'), style: get('font-style'), src, urls });
    });
  }
  return out;
}

export function collectKeyframes(roots: Root[]): string[] {
  const names = new Set<string>();
  for (const root of roots) root.walkAtRules(/keyframes$/, (at) => void names.add(at.params.trim()));
  return [...names];
}

/** Width breakpoints used by media queries, most used first. */
export function collectBreakpoints(roots: Root[]): { px: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const root of roots) {
    root.walkAtRules('media', (at) => {
      for (const m of at.params.matchAll(/(min|max)-width\s*:\s*([\d.]+)px/g)) {
        let px = Number(m[2]);
        if (m[1] === 'max') px = Math.round(px + 1); // max-width:768px ≈ breakpoint 769
        counts.set(px, (counts.get(px) ?? 0) + 1);
      }
    });
  }
  return [...counts.entries()].map(([px, count]) => ({ px, count })).sort((a, b) => b.count - a.count);
}

export function countVarUsage(cssTexts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const css of cssTexts) {
    for (const m of css.matchAll(/var\(\s*--([\w-]+)/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return counts;
}
