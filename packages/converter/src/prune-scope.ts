import postcss from 'postcss';
import { parseHTML } from 'linkedom';
import { DEFAULT_SCRUB, stripClasses, toTestSelector } from './selectors.ts';

/**
 * Component-scope classes (dtl-cid-xxxx) are only needed where two components in the same
 * section share a class name. Drop them from every selector whose match set inside the
 * section does not change without them, then from the markup when nothing uses them.
 */
export function pruneScopeClasses(css: string, html: string, prefix: string): { css: string; html: string; removed: number } {
  const isScope = (c: string) => new RegExp(`^${prefix}-(cid|v)-[0-9a-z]{6,}$`, 'i').test(c);
  if (!new RegExp(`\\.${prefix}-(cid|v)-`, 'i').test(css)) return { css, html, removed: 0 };
  const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = document.body.firstElementChild as Element;
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  const matchSet = (sel: string | null): string | null => {
    if (!sel) return null;
    try {
      const out: number[] = [];
      all.forEach((e, i) => {
        if (e.matches(sel)) out.push(i);
      });
      return out.join(',');
    } catch {
      return null;
    }
  };
  const test = (s: string) => toTestSelector(s, { stripState: true, scrub: DEFAULT_SCRUB });

  let removed = 0;
  const ast = postcss.parse(css);
  ast.walkRules((rule) => {
    const parent = rule.parent as { type: string; name?: string } | undefined;
    if (parent?.type === 'atrule' && /keyframes/i.test(parent.name ?? '')) return;
    rule.selectors = rule.selectors.map((sel) => {
      if (!/(cid|v)-[0-9a-z]{6,}/i.test(sel)) return sel;
      const stripped = stripClasses(sel, isScope);
      const a = matchSet(test(sel));
      if (a !== null && a === matchSet(test(stripped))) {
        removed++;
        return stripped;
      }
      return sel;
    });
  });
  const outCss = ast.toString();
  const stillUsed = new Set([...outCss.matchAll(new RegExp(`\\.(${prefix}-(?:cid|v)-[0-9a-z]{6,})`, 'gi'))].map((m) => m[1]));
  for (const el of all) for (const c of Array.from(el.classList)) if (isScope(c) && !stillUsed.has(c)) el.classList.remove(c);
  return { css: outCss, html: root.outerHTML, removed };
}
