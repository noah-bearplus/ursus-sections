/**
 * Removes everything in a captured page that is not part of the site's design:
 * browser-extension UI, tracking/runtime scripts, resource hints.
 * Works on a linkedom (or browser) Document.
 */

/** Elements injected by popular browser extensions (CSS Peeper, Grammarly, dictionaries, Loom…). */
const EXTENSION_SELECTORS = [
  'plasmo-csui',
  'ddict-div',
  'grammarly-desktop-integration',
  'grammarly-extension',
  'loom-container',
  '[data-extension-id]',
  '[data-extension-name]',
  '[id^="give-freely-root"]',
  '#lastpass-notification',
  '[id^="__endic_"]',
  'deepl-input-controller',
  'veepn-guard-alert',
];

const RESOURCE_HINTS = ['preload', 'prefetch', 'preconnect', 'dns-prefetch', 'modulepreload', 'manifest'];

export interface SanitizeReport {
  removedExtensions: number;
  removedScripts: number;
  removedHints: number;
  removedCustom: number;
  jsonScripts: { selector: string; type: string; content: string }[];
}

export function sanitizeDocument(document: Document, extraRemove: string[] = []): SanitizeReport {
  const report: SanitizeReport = { removedExtensions: 0, removedScripts: 0, removedHints: 0, removedCustom: 0, jsonScripts: [] };

  for (const sel of EXTENSION_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      el.remove();
      report.removedExtensions++;
    }
  }

  // Anything hanging directly off <html> that is not head/body was injected after load.
  for (const el of Array.from(document.documentElement.children)) {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'head' && tag !== 'body') {
      el.remove();
      report.removedExtensions++;
    }
  }

  // Custom elements at the end of <body> whose only content is a declarative shadow root are
  // almost always extension overlays.
  for (const el of Array.from(document.body?.children ?? [])) {
    const tag = el.tagName.toLowerCase();
    if (!tag.includes('-')) continue;
    const kids = Array.from(el.children);
    if (kids.length === 1 && kids[0].tagName.toLowerCase() === 'template' && kids[0].hasAttribute('shadowrootmode')) {
      el.remove();
      report.removedExtensions++;
    }
  }

  for (const sel of extraRemove) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      el.remove();
      report.removedCustom++;
    }
  }

  let i = 0;
  for (const s of Array.from(document.querySelectorAll('script'))) {
    const type = (s.getAttribute('type') ?? '').toLowerCase();
    if (type.includes('json')) {
      const attrs = Array.from(s.attributes)
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => `[${a.name}]`)
        .join('');
      report.jsonScripts.push({ selector: `script${attrs}` || `script:nth-of-type(${i})`, type, content: s.textContent ?? '' });
    }
    s.remove();
    report.removedScripts++;
    i++;
  }
  for (const n of Array.from(document.querySelectorAll('noscript'))) n.remove();

  for (const l of Array.from(document.querySelectorAll('link[rel]'))) {
    const rels = (l.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    if (rels.some((r) => RESOURCE_HINTS.includes(r))) {
      l.remove();
      report.removedHints++;
    }
  }

  return report;
}
