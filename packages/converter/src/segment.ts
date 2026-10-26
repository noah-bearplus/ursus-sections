import type { Page } from 'playwright-core';
import type { RecipeSection, SectionCategory } from '@sf/core';

/**
 * Fallback segmentation when a recipe does not list sections: landmarks
 * (header/footer/nav) plus large top-level blocks of <main>.
 */
export async function autoSegment(page: Page): Promise<RecipeSection[]> {
  const found = await page.evaluate(() => {
    const path = (el: Element): string => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts: string[] = [];
      for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
        if (e.id) {
          parts.unshift(`#${CSS.escape(e.id)}`);
          break;
        }
        const parent: Element | null = e.parentElement;
        const idx = parent ? Array.from(parent.children).indexOf(e) + 1 : 1;
        parts.unshift(`${e.tagName.toLowerCase()}:nth-child(${idx})`);
      }
      return parts.join(' > ');
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.height >= 80 && r.width >= 200 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const out: { selector: string; tag: string; cls: string; text: string; top: number }[] = [];
    const push = (el: Element) => {
      if (!visible(el) || out.some((o) => document.querySelector(o.selector)?.contains(el))) return;
      out.push({
        selector: path(el),
        tag: el.tagName.toLowerCase(),
        cls: el.className.toString().slice(0, 60),
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        top: el.getBoundingClientRect().top + window.scrollY,
      });
    };
    const header = document.querySelector('body header, [role=banner]');
    if (header) push(header);
    const main = document.querySelector('main, [role=main]') ?? document.body;
    for (const c of Array.from(main.children)) {
      if (['script', 'style', 'template', 'link'].includes(c.tagName.toLowerCase())) continue;
      push(c);
    }
    const footer = document.querySelector('body footer, [role=contentinfo]');
    if (footer) push(footer);
    return out.sort((a, b) => a.top - b.top);
  });

  const used = new Set<string>();
  return found.map((f, i) => {
    const category: SectionCategory =
      f.tag === 'header' ? 'header' : f.tag === 'footer' ? 'footer' : f.tag === 'nav' ? 'navigation' : i === 1 ? 'hero' : 'other';
    let key = (f.cls.split(/\s+/)[0] || f.tag).replace(/[^a-z0-9]+/gi, '-').toLowerCase() || `section-${i}`;
    while (used.has(key)) key += `-${i}`;
    used.add(key);
    return { key, name: key.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), category, selector: f.selector };
  });
}
