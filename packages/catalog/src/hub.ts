import type { SectionIR, Workspace } from '@sf/core';
import { escapeHtml } from '@sf/core';

interface VerifyRow {
  section: string;
  viewport: string;
  diff: number;
  heightDelta: number;
}

interface ShopifyReport {
  profile: { name: string; cssStrategy: string };
  sections: {
    key: string;
    handle: string;
    files: string[];
    settings: number;
    blockTypes: string[];
    issues: { level: 'error' | 'warning'; message: string }[];
    visualDiff?: number;
  }[];
}

export interface HubInput {
  /** Path of the catalog index relative to the hub root, when one was built. */
  catalog?: string;
  projects: { id: string; ws: Workspace }[];
}

const pct = (n: number | undefined) => (n === undefined ? '—' : `${(n * 100).toFixed(2)}%`);

/**
 * Start page for a local `sf serve`: one place that links every output of every project
 * (clone, styleguide, per-section fidelity, generated Liquid per theme profile).
 * Links are relative to the hub root, which is the sectionforge home directory (.sf).
 */
export async function buildHub(out: Workspace, input: HubInput): Promise<void> {
  const blocks: string[] = [];
  for (const { id, ws } of input.projects) {
    const base = out.rel(ws.root).split('\\').join('/');
    const index = await ws.readJson<{ sections: string[]; page?: { title?: string } }>('sections', 'index.json');
    const names = new Map<string, string>();
    for (const key of index.sections) {
      const ir = await ws.readJson<SectionIR>('sections', key, 'ir.json').catch(() => null);
      names.set(key, ir?.name ?? key);
    }
    const source = (await ws.readJson<SectionIR>('sections', index.sections[0], 'ir.json').catch(() => null))?.source.url;
    const verify = await ws.readJson<VerifyRow[]>('verify', 'report.json').catch(() => [] as VerifyRow[]);
    const profiles: { slug: string; report: ShopifyReport }[] = [];
    for (const slug of await ws.list('shopify')) {
      const report = await ws.readJson<ShopifyReport>('shopify', slug, 'report.json').catch(() => null);
      if (report) profiles.push({ slug, report });
    }

    const links = [
      ['clone/index.html', 'Bản clone toàn trang', 'Nút ở góc phải chuyển dark / light'],
      ['design/styleguide.html', 'Styleguide', 'Màu, chữ, radius, shadow, motion, component'],
      ...(input.catalog ? [[input.catalog, 'Thư viện section', 'Preview responsive + copy Liquid', true]] : []),
      ['design/tokens.css', 'Design tokens', 'tokens.css'],
    ] as [string, string, string, boolean?][];

    const viewports = [...new Set(verify.map((v) => v.viewport))];
    const verifyRows = index.sections
      .map((key) => {
        const cells = viewports
          .map((vp) => {
            const v = verify.find((r) => r.section === key && r.viewport === vp);
            if (!v) return '<td>—</td>';
            const img = (kind: string) => `${base}/verify/${key}.${vp}.${kind}.png`;
            return `<td><b class="${v.diff < 0.01 ? 'ok' : 'warn'}">${pct(v.diff)}</b>${v.heightDelta ? ` <small>Δh ${v.heightDelta}px</small>` : ''}
  <details><summary>Xem ảnh</summary><figure><figcaption>Gốc</figcaption><img loading="lazy" src="${img('original')}" alt=""></figure><figure><figcaption>Clone</figcaption><img loading="lazy" src="${img('clone')}" alt=""></figure><figure><figcaption>Khác biệt (đỏ)</figcaption><img loading="lazy" src="${img('diff')}" alt=""></figure></details></td>`;
          })
          .join('');
        return `<tr><th>${escapeHtml(names.get(key) ?? key)}<small><a href="${base}/sections/${key}/preview.html">preview.html</a></small></th>${cells}</tr>`;
      })
      .join('\n');

    const shopify = profiles
      .map(({ slug, report }) => {
        const issues = report.sections.flatMap((s) => s.issues);
        const errors = issues.filter((i) => i.level === 'error').length;
        const warnings = issues.length - errors;
        const rows = report.sections
          .map(
            (s) => `<tr><th>${escapeHtml(s.handle)}</th><td>${s.settings}</td><td>${s.blockTypes.length ? escapeHtml(s.blockTypes.join(', ')) : '—'}</td><td>${pct(s.visualDiff)}</td>
  <td class="acts"><a href="${base}/shopify/${slug}/preview/${s.handle}.html">Render Liquid</a><a href="${base}/shopify/${slug}/single-file/${s.handle}.liquid">1 file .liquid</a><a href="${base}/shopify/${slug}/theme/sections/${s.handle}.liquid">theme/sections</a></td></tr>`,
          )
          .join('\n');
        return `<details class="profile"><summary><b>${escapeHtml(report.profile.name)}</b><span>CSS: ${escapeHtml(report.profile.cssStrategy)} · <span class="${errors ? 'bad' : 'ok'}">${errors} lỗi</span> · ${warnings} cảnh báo</span><a href="${base}/shopify/${slug}/README.md">README</a></summary>
<div class="tbl"><table><thead><tr><th>Section</th><th>Settings</th><th>Blocks</th><th>Liquid vs clone</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
      })
      .join('\n');

    blocks.push(`<section class="project">
  <h2>${escapeHtml(index.page?.title ?? id)}</h2>
  <p class="muted">${source ? `Nguồn: ${escapeHtml(source)} · ` : ''}${index.sections.length} section · <code>${escapeHtml(base)}</code></p>
  <div class="links">${links
    .map(([href, title, sub, rootRelative]) => `<a class="link" href="${rootRelative ? href : `${base}/${href}`}"><b>${title}</b><span>${sub}</span></a>`)
    .join('')}</div>
  ${verify.length ? `<h3>Độ giống bản gốc <span class="muted">(pixel diff từng section)</span></h3>
  <div class="tbl"><table class="verify"><thead><tr><th>Section</th>${viewports.map((v) => `<th>${escapeHtml(v)}</th>`).join('')}</tr></thead><tbody>${verifyRows}</tbody></table></div>` : ''}
  ${profiles.length ? `<h3>Liquid cho Shopify <span class="muted">(theo từng profile theme)</span></h3>${shopify}` : ''}
</section>`);
  }

  await out.write(
    'index.html',
    `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sectionforge — kết quả</title>
<style>
:root { --bg:#0c0a09; --panel:#151312; --panel-2:#1d1b19; --line:#2a2725; --text:#f5f5f4; --muted:#a6a09b; --accent:#f25500; --ok:#4ade80; --warn:#fbbf24; --bad:#f87171; color-scheme: dark; }
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Inter, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: inherit; }
.wrap { max-width: 1200px; margin: 0 auto; padding: 40px 16px 96px; }
.brand { font-weight: 650; font-size: 20px; } .brand span { color: var(--accent); }
.muted, small { color: var(--muted); font-weight: 400; }
small { display: block; font-size: 12px; }
code { font: 12px ui-monospace, monospace; }
.project { margin-top: 40px; }
h2 { font-size: 28px; letter-spacing: -.02em; font-weight: 600; }
h3 { font-size: 17px; font-weight: 600; margin: 32px 0 12px; }
.links { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 20px; }
.link { display: block; text-decoration: none; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 16px; transition: border-color .2s; }
.link:hover { border-color: var(--accent); }
.link b { display: block; } .link span { color: var(--muted); font-size: 13px; }
.tbl { overflow-x: auto; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
table { width: 100%; min-width: 640px; border-collapse: collapse; }
.verify { table-layout: fixed; }
.verify thead th:first-child { width: 30%; }
th, td { text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 14px; }
tbody tr:last-child > * { border-bottom: 0; }
thead th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
tbody th { font-weight: 560; }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
td details[open] { margin-top: 8px; }
figure { margin: 8px 0 0; } figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
figure img { display: block; max-width: 100%; border: 1px solid var(--line); border-radius: 8px; }
.profile { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; margin-bottom: 10px; overflow: hidden; }
.profile > summary { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; padding: 14px 16px; color: var(--text); font-size: 15px; }
.profile > summary span { color: var(--muted); font-size: 13px; }
.profile > summary a { margin-left: auto; font-size: 13px; color: var(--muted); }
.profile .tbl { border: 0; border-top: 1px solid var(--line); border-radius: 0; }
.acts { white-space: nowrap; } .acts a { margin-right: 12px; font-size: 13px; }
</style></head><body><main class="wrap">
<div class="brand">section<span>forge</span></div>
<p class="muted" style="margin-top:6px">Kết quả trong <code>.sf/</code>. Chạy lại pipeline thì tải lại trang này.</p>
${blocks.join('\n') || '<p style="margin-top:40px">Chưa có project nào. Chạy <code>npm run sf -- run recipes/&lt;recipe&gt;.json</code> trước.</p>'}
</main></body></html>`,
  );
}
