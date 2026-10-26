import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseHTML } from 'linkedom';
import type { AssetKind, AssetRecord, Logger, Recipe, Snapshot, StylesheetRecord, Workspace } from '@sf/core';
import { sha1 } from '@sf/core';
import { sanitizeDocument } from './sanitize.ts';
import { sniffMime, extForMime } from './mime.ts';

/**
 * What every ingest adapter (saved page, live crawl, HAR, …) must provide:
 * the page HTML plus a way to find a local copy of any URL it references.
 */
export interface RawPage {
  html: string;
  baseUrl: string;
  via: Snapshot['meta']['via'];
  /** Returns an absolute local path for a reference (as written in the HTML/CSS), or null. */
  resolveLocal(ref: string, baseUrl: string): Promise<string | null>;
}

export async function rawFromSavedPage(htmlPath: string, assetsDir?: string, urlHint?: string): Promise<RawPage> {
  const html = await readFile(htmlPath, 'utf8');
  const savedFrom = /<!--\s*saved from url=\(\d+\)(\S+)\s*-->/.exec(html)?.[1];
  const baseUrl = urlHint ?? savedFrom ?? 'https://example.com/';
  const dir = assetsDir ?? (await guessAssetsDir(htmlPath));
  const index = new Map<string, string>();
  if (dir) for (const f of await readdir(dir)) index.set(f, join(dir, f));

  return {
    html,
    baseUrl,
    via: 'saved-page',
    async resolveLocal(ref) {
      if (!ref || ref.startsWith('data:')) return null;
      let clean = ref.split('#')[0].split('?')[0];
      try {
        clean = decodeURIComponent(clean);
      } catch {
        /* keep raw */
      }
      // Browsers save as "./<Title>_files/<name>"; the folder may have been renamed, so match on name.
      const m = /_files\/(.+)$/.exec(clean);
      const name = m ? m[1] : null;
      if (name && index.has(name)) return index.get(name)!;
      if (index.has(basename(clean)) && !/^https?:/.test(clean)) return index.get(basename(clean))!;
      return null;
    },
  };
}

async function guessAssetsDir(htmlPath: string): Promise<string | undefined> {
  const dir = dirname(htmlPath);
  const stem = basename(htmlPath, extname(htmlPath));
  for (const cand of [join(dir, `${stem}_files`), join(dir, `${stem}-files`)]) {
    if ((await stat(cand).catch(() => null))?.isDirectory()) return cand;
  }
  return undefined;
}

const URL_ATTRS: [string, string][] = [
  ['img', 'src'],
  ['img', 'srcset'],
  ['source', 'src'],
  ['source', 'srcset'],
  ['video', 'src'],
  ['video', 'poster'],
  ['link[rel~="icon"]', 'href'],
  ['link[rel="apple-touch-icon"]', 'href'],
  ['image', 'href'],
  ['use', 'href'],
  ['a', 'href'],
];

/**
 * Normalises a raw page into a Snapshot: sanitised DOM, ordered stylesheet files,
 * deduplicated local assets with correct extensions, absolute URLs for the rest.
 */
export async function buildSnapshot(ws: Workspace, recipe: Recipe, raw: RawPage, log: Logger): Promise<Snapshot> {
  await ws.clean('snapshot');
  await ws.ensureDir('snapshot', 'styles');
  await ws.ensureDir('snapshot', 'assets');

  const { document } = parseHTML(raw.html);
  const report = sanitizeDocument(document as unknown as Document, recipe.sanitize?.remove);
  log.info(
    `sanitised: ${report.removedExtensions} extension nodes, ${report.removedScripts} scripts, ${report.removedHints} resource hints`,
  );

  const assets = new Map<string, AssetRecord>(); // key: originalUrl
  const byHash = new Map<string, AssetRecord>();

  const absolutize = (ref: string, base: string) => {
    try {
      return new URL(ref, base).href;
    } catch {
      return ref;
    }
  };

  /** Copies a referenced file into snapshot/assets and returns the new relative URL (from snapshot root). */
  const importAsset = async (ref: string, base: string, kindHint?: AssetKind): Promise<string> => {
    if (!ref || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('mailto:') || ref.startsWith('javascript:')) return ref;
    const local = await raw.resolveLocal(ref, base);
    const isSavedRef = /_files\//.test(ref);
    const abs = isSavedRef ? `saved:${basename(ref)}` : absolutize(ref, base);
    if (assets.has(abs)) return assets.get(abs)!.path ?? assets.get(abs)!.originalUrl;
    if (!local) {
      const rec: AssetRecord = { id: `a${assets.size}`, kind: kindHint ?? guessKind(abs), originalUrl: abs };
      assets.set(abs, rec);
      return abs;
    }
    const buf = await readFile(local);
    const hash = sha1(buf);
    const existing = byHash.get(hash);
    if (existing) {
      assets.set(abs, existing);
      return existing.path!;
    }
    const mime = sniffMime(buf) ?? 'application/octet-stream';
    const name = safeAssetName(basename(local), mime);
    let rel = `assets/${name}`;
    if ([...byHash.values()].some((a) => a.path === rel)) rel = `assets/${hash.slice(0, 6)}-${name}`;
    await ws.write(`snapshot/${rel}`, buf);
    const rec: AssetRecord = { id: `a${assets.size}`, kind: kindHint ?? kindForMime(mime), originalUrl: abs, path: rel, mime, bytes: buf.length, sha1: hash };
    assets.set(abs, rec);
    byHash.set(hash, rec);
    return rel;
  };

  const rewriteCssUrls = async (css: string, base: string, fromStylesDir: boolean): Promise<string> => {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    const parts: string[] = [];
    let last = 0;
    for (let m = re.exec(css); m; m = re.exec(css)) {
      parts.push(css.slice(last, m.index));
      const isFont = /@font-face[^}]*$/.test(css.slice(Math.max(0, m.index - 400), m.index));
      const out = await importAsset(m[2], base, isFont ? 'font' : undefined);
      const local = out.startsWith('assets/');
      parts.push(`url("${local && fromStylesDir ? '../' + out : out}")`);
      last = m.index + m[0].length;
    }
    parts.push(css.slice(last));
    return parts.join('');
  };

  // ---- stylesheets, in cascade order --------------------------------------------------------
  const sheetNodes = Array.from(document.querySelectorAll('link[rel~="stylesheet"], style')).filter(
    (n) => !n.closest('template') && !n.closest('svg'),
  );
  type Pending = { node: Element; css: string; href?: string; media?: string; inline: boolean; hash: string };
  const pending: Pending[] = [];
  for (const node of sheetNodes) {
    const isLink = node.tagName.toLowerCase() === 'link';
    let css: string | null = null;
    let href: string | undefined;
    if (isLink) {
      href = node.getAttribute('href') ?? undefined;
      const local = href ? await raw.resolveLocal(href, raw.baseUrl) : null;
      if (local) css = await readFile(local, 'utf8');
      else {
        log.warn(`stylesheet not available offline: ${href}`);
        node.remove();
        continue;
      }
    } else {
      css = node.textContent ?? '';
    }
    const cssBase = isLink && href && !/_files\//.test(href) ? absolutize(href, raw.baseUrl) : raw.baseUrl;
    css = await rewriteCssUrls(css, cssBase, true);
    pending.push({ node, css, href, media: node.getAttribute('media') ?? undefined, inline: !isLink, hash: sha1(css) });
  }
  // Identical sheets loaded twice: keep the last occurrence (that is the one that wins the cascade).
  const lastIndex = new Map<string, number>();
  pending.forEach((p, i) => lastIndex.set(p.hash, i));
  const stylesheets: StylesheetRecord[] = [];
  let order = 0;
  for (const [i, p] of pending.entries()) {
    if (lastIndex.get(p.hash) !== i || !p.css.trim()) {
      p.node.remove();
      continue;
    }
    const label = p.href ? basename(p.href).replace(/\?.*$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_') : 'inline.css';
    const id = `s${String(order).padStart(3, '0')}`;
    const path = `styles/${id}-${label.endsWith('.css') ? label : label + '.css'}`;
    await ws.write(`snapshot/${path}`, p.css);
    const link = document.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', path);
    link.setAttribute('data-sf-sheet', id);
    if (p.media) link.setAttribute('media', p.media);
    p.node.replaceWith(link);
    stylesheets.push({ id, order, inline: p.inline, href: p.href, media: p.media, path, bytes: Buffer.byteLength(p.css) });
    order++;
  }
  // Move every stylesheet into <head> (saved pages often end up with them in <body>).
  for (const l of Array.from(document.querySelectorAll('link[data-sf-sheet]'))) document.head.appendChild(l);

  // ---- element URLs -----------------------------------------------------------------------
  for (const [sel, attr] of URL_ATTRS) {
    for (const el of Array.from(document.querySelectorAll(`${sel}[${attr}]`))) {
      const val = el.getAttribute(attr)!;
      if (attr === 'srcset') {
        const out: string[] = [];
        for (const cand of val.split(',').map((s) => s.trim()).filter(Boolean)) {
          const [u, ...d] = cand.split(/\s+/);
          out.push([await importAsset(u, raw.baseUrl, 'image'), ...d].join(' '));
        }
        el.setAttribute(attr, out.join(', '));
      } else if (sel === 'a') {
        // Links stay links: absolutise but never download.
        if (!/^(#|mailto:|tel:|javascript:)/.test(val)) el.setAttribute(attr, absolutize(val, raw.baseUrl));
      } else {
        el.setAttribute(attr, await importAsset(val, raw.baseUrl, sel === 'video' && attr === 'src' ? 'video' : undefined));
      }
    }
  }
  for (const el of Array.from(document.querySelectorAll('[style*="url("]'))) {
    el.setAttribute('style', await rewriteCssUrls(el.getAttribute('style')!, raw.baseUrl, false));
  }
  // Lazy-load attributes that hold real URLs.
  for (const el of Array.from(document.querySelectorAll('[data-src]'))) {
    const v = el.getAttribute('data-src')!;
    if (/^https?:|^\.\/|_files\//.test(v)) el.setAttribute('data-src', await importAsset(v, raw.baseUrl));
  }

  // ---- head hygiene -----------------------------------------------------------------------
  for (const m of Array.from(document.querySelectorAll('meta[http-equiv], meta[charset]'))) m.remove();
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  document.head.prepend(charset);
  for (const el of Array.from(document.body.querySelectorAll(':scope > meta, :scope > title, :scope > link'))) document.head.appendChild(el);

  const meta = (name: string) =>
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ??
    document.querySelector(`meta[property="${name}"]`)?.getAttribute('content') ??
    undefined;
  const htmlAttrs: Record<string, string> = {};
  for (const a of Array.from(document.documentElement.attributes)) htmlAttrs[a.name] = a.value;

  const htmlOut = '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  await ws.write('snapshot/page.html', htmlOut);

  const snapshot: Snapshot = {
    meta: {
      url: raw.baseUrl,
      title: document.title,
      description: meta('description'),
      generator: meta('generator'),
      lang: document.documentElement.getAttribute('lang') ?? undefined,
      htmlAttrs,
      capturedAt: new Date().toISOString(),
      via: raw.via,
    },
    htmlPath: 'page.html',
    stylesheets,
    assets: [...new Set(assets.values())],
    data: report.jsonScripts,
    rootFontSize: 16,
  };
  await ws.writeJson('snapshot/snapshot.json', snapshot);
  const local = snapshot.assets.filter((a) => a.path).length;
  log.info(`snapshot: ${stylesheets.length} stylesheets, ${local} local assets, ${snapshot.assets.length - local} remote-only`);
  return snapshot;
}

function guessKind(url: string): AssetKind {
  if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url)) return 'font';
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return 'video';
  if (/favicon|\.ico(\?|$)/i.test(url)) return 'icon';
  return 'image';
}

function kindForMime(mime: string): AssetKind {
  if (mime.startsWith('font/')) return 'font';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'image/x-icon') return 'icon';
  if (mime.startsWith('image/')) return 'image';
  return 'other';
}

function safeAssetName(name: string, mime: string): string {
  const ext = extForMime(mime);
  let stem = name.replace(/\?.*$/, '');
  const cur = extname(stem).toLowerCase();
  const knownExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm'];
  if (knownExt.includes(cur)) stem = stem.slice(0, -cur.length);
  stem = stem.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'asset';
  return `${stem}${ext ?? (cur || '.bin')}`;
}
