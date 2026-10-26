import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ThemeProfile } from '@sf/core';

interface SectionFile {
  name: string;
  source: string;
  schema: Record<string, unknown> | null;
}

/**
 * Reads a Shopify theme folder and extracts the conventions generated sections must follow
 * to feel native: how sections load CSS, wrapper/container classes, colour-scheme and
 * padding settings (copied verbatim), CSS variables, label style, hostile global rules.
 */
export async function analyzeTheme(dir: string): Promise<ThemeProfile> {
  const sections = await readSections(join(dir, 'sections'));
  const blocks = await listFiles(join(dir, 'blocks'), '.liquid');
  const snippets = await listFiles(join(dir, 'snippets'), '.liquid');
  const layout = await readFile(join(dir, 'layout', 'theme.liquid'), 'utf8').catch(() => '');
  const settingsSchema = await readFile(join(dir, 'config', 'settings_schema.json'), 'utf8').catch(() => '[]');
  const snippetText = (await Promise.all(snippets.map((s) => readFile(join(dir, 'snippets', s), 'utf8').catch(() => '')))).join('\n');
  const assetsCss = await readCssAssets(join(dir, 'assets'));
  const themeName = (JSON.parse(stripJsonComments(settingsSchema)) as { name?: string; theme_name?: string }[]).find((x) => x.name === 'theme_info')?.theme_name ?? basename(dir);

  // ---- CSS loading strategy -------------------------------------------------------------
  const count = (re: RegExp) => sections.filter((s) => re.test(s.source)).length;
  const strategies = {
    'stylesheet-tag': count(/\{%-?\s*stylesheet\s*-?%\}/),
    'asset-file': count(/asset_url\s*\|\s*stylesheet_tag/),
    'style-tag': count(/\{%-?\s*style\s*-?%\}/),
  };
  const strategy = (Object.entries(strategies).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'stylesheet-tag') as ThemeProfile['css']['strategy'];

  // ---- global CSS variables ------------------------------------------------------------
  const globals: Record<string, string> = {};
  for (const m of (layout + '\n' + snippetText).matchAll(/(--[\w-]+)\s*:\s*([^;]{1,160});/g)) if (!(m[1] in globals)) globals[m[1]] = m[2].trim();

  // ---- root font size (Dawn: html { font-size: calc(var(--font-body-scale) * 62.5%) }) --
  let rootFontSize = 16;
  const htmlRule = /html\s*\{[^}]*font-size\s*:\s*([^;]+);/.exec(layout + assetsCss);
  if (htmlRule) {
    const pct = /([\d.]+)%/.exec(htmlRule[1]);
    const px = /([\d.]+)px/.exec(htmlRule[1]);
    if (pct) rootFontSize = (16 * parseFloat(pct[1])) / 100;
    else if (px) rootFontSize = parseFloat(px[1]);
  }

  // ---- section conventions ---------------------------------------------------------------
  const allSettings: Record<string, unknown>[] = sections.flatMap((s) => ((s.schema?.settings as Record<string, unknown>[]) ?? []).map((x) => ({ ...x, __section: s.name })));
  const colorSetting = mostCommon(allSettings.filter((x) => x.type === 'color_scheme').map((x) => String(x.id)));
  let colorScheme: ThemeProfile['section']['colorScheme'] = null;
  if (colorSetting) {
    const re = new RegExp(`color-\\{\\{-?\\s*section\\.settings\\.${colorSetting}\\s*-?\\}\\}( gradient)?`);
    const hit = sections.map((s) => re.exec(s.source)?.[0]).find(Boolean);
    colorScheme = { settingType: 'color_scheme', settingId: colorSetting, classTemplate: hit ?? `color-{{ section.settings.${colorSetting} }}` };
  }

  const paddingIds = ['padding_top', 'padding_bottom', 'padding-block-start', 'padding-block-end'];
  const paddingDefs = new Map<string, Record<string, unknown>[]>();
  for (const s of sections) {
    const defs = ((s.schema?.settings as Record<string, unknown>[]) ?? []).filter((x) => paddingIds.includes(String(x.id)));
    if (defs.length === 2) {
      const key = JSON.stringify(defs.map((d) => ({ ...d, default: undefined })));
      paddingDefs.set(key, [...(paddingDefs.get(key) ?? []), ...[defs as unknown as Record<string, unknown>]]);
    }
  }
  const paddingSettings = [...paddingDefs.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[1][0] as unknown as unknown[] | undefined;
  let padding: ThemeProfile['section']['padding'] = null;
  if (paddingSettings) {
    const styleBlock = sections
      .map((s) => /\{%-?\s*style\s*-?%\}([\s\S]*?section-\{\{\s*section\.id\s*\}\}-padding[\s\S]*?)\{%-?\s*endstyle\s*-?%\}/.exec(s.source)?.[0])
      .find(Boolean);
    const spacingSnippet = snippets.includes('spacing-style.liquid');
    padding = {
      settings: paddingSettings,
      style: styleBlock ?? (spacingSnippet ? "{% render 'spacing-style', settings: section.settings %}" : null),
      className: styleBlock ? 'section-{{ section.id }}-padding' : spacingSnippet ? 'spacing-style' : null,
    };
  }

  const containerClass = mostCommon(
    sections.flatMap((s) => [...s.source.matchAll(/class="[^"]*\b(page-width|container|page-container|section--page-width)\b/g)].map((m) => m[1])),
  );
  const tag = mostCommon(sections.map((s) => s.schema?.tag as string | undefined).filter(Boolean) as string[]);
  const className = mostCommon(sections.map((s) => s.schema?.class as string | undefined).filter(Boolean) as string[]);
  const disabledOn = mostCommonJson(sections.map((s) => s.schema?.disabled_on).filter(Boolean));
  const anim = /settings\.animations_reveal_on_scroll[\s\S]{0,80}?(scroll-trigger animate--[\w-]+)/.exec(sections.map((s) => s.source).join('\n'));

  const labels = allSettings.map((x) => String(x.label ?? '')).filter(Boolean);
  const usesTranslationKeys = labels.filter((l) => l.startsWith('t:')).length > labels.length / 2;

  // ---- typography & buttons ---------------------------------------------------------------
  const markup = sections.map((s) => s.source).join('\n');
  const headings = [...new Set([...markup.matchAll(/class="[^"]*\b(h[0-6]|hxl|hxxl)\b/g)].map((m) => m[1]))];
  const btnPrimary = /class="(button button--primary)/.test(markup) ? 'button button--primary' : /class="(button)\b/.test(markup) ? 'button' : null;
  const btnSecondary = /button--secondary/.test(markup) ? 'button button--secondary' : null;
  const richtext = /class="[^"]*\brte\b/.test(markup) ? 'rte' : null;

  const fontVar = (cands: string[]) => cands.find((c) => c in globals) ?? null;
  const fonts = {
    heading: fontVar(['--font-heading-family', '--font-heading--family', '--font-heading']),
    body: fontVar(['--font-body-family', '--font-body--family', '--font-body']),
  };

  const adapter: ThemeProfile['adapter'] = blocks.length > 0 && globals['--color-foreground-rgb'] !== undefined ? 'horizon' : colorScheme && padding ? 'dawn' : 'generic';
  const profile: ThemeProfile = {
    name: themeName,
    architecture: blocks.length > 0 ? 'os2-theme-blocks' : sections.some((s) => s.schema) ? 'os2-sections' : 'unknown',
    adapter,
    css: { strategy, rootFontSize, globals },
    section: {
      containerClass: containerClass ?? null,
      colorScheme,
      padding,
      tag: tag ?? null,
      className: className ?? null,
      disabledOn: disabledOn ?? null,
      animation: anim ? { settingPath: 'settings.animations_reveal_on_scroll', classes: anim[1] } : null,
    },
    schema: { usesTranslationKeys, presetsCategory: false },
    classes: { headings, buttonPrimary: btnPrimary, buttonSecondary: btnSecondary, richtext },
    fonts,
    roleMap: buildRoleMap(globals, fonts),
    hazards: detectHazards(assetsCss),
    stats: { sections: sections.length, snippets: snippets.length, blocks: blocks.length },
  };
  return profile;
}

/** Semantic roles → CSS expressions available in this theme (used by the "Match theme" style source). */
function buildRoleMap(g: Record<string, string>, fonts: ThemeProfile['fonts']): Record<string, string> {
  const map: Record<string, string> = {};
  if ('--color-foreground-rgb' in g) {
    // Horizon family: full colours + "r g b" companions
    map.text = 'var(--color-foreground)';
    map['text-muted'] = 'rgb(var(--color-foreground-rgb) / 0.7)';
    map.background = 'var(--color-background)';
    map.surface = 'rgb(var(--color-foreground-rgb) / 0.06)';
    map['surface-strong'] = 'rgb(var(--color-foreground-rgb) / 0.12)';
    map.border = 'rgb(var(--color-foreground-rgb) / 0.14)';
    map.accent = g['--color-primary-button-background'] ? 'var(--color-primary-button-background)' : 'var(--color-foreground)';
    map['on-accent'] = g['--color-primary-button-text'] ? 'var(--color-primary-button-text)' : 'var(--color-background)';
  } else if ('--color-foreground' in g) {
    // Dawn family: "r,g,b" triplets
    map.text = 'rgb(var(--color-foreground))';
    map['text-muted'] = 'rgba(var(--color-foreground), 0.75)';
    map.background = 'rgb(var(--color-background))';
    map.surface = 'rgba(var(--color-foreground), 0.06)';
    map['surface-strong'] = 'rgba(var(--color-foreground), 0.12)';
    map.border = 'rgba(var(--color-foreground), 0.15)';
    map.accent = '--color-button' in g ? 'rgb(var(--color-button))' : 'rgb(var(--color-foreground))';
    map['on-accent'] = '--color-button-text' in g ? 'rgb(var(--color-button-text))' : 'rgb(var(--color-background))';
  }
  if (fonts.heading) map['font-heading'] = `var(${fonts.heading})`;
  if (fonts.body) map['font-body'] = `var(${fonts.body})`;
  return map;
}

function detectHazards(css: string): string[] {
  const out: string[] = [];
  if (/(div|a|p|section|span|ul|h\d)[^{]*:empty[^{]*\{[^}]*display\s*:\s*none/.test(css)) out.push('empty-elements-hidden');
  if (/(^|[}\s,])h[1-6]\s*,[^{]*\{[^}]*font-size/.test(css)) out.push('global-heading-sizes');
  if (/(^|[}\s,])img\s*\{[^}]*height\s*:\s*auto/.test(css)) out.push('global-img-height-auto');
  return out;
}

async function readSections(dir: string): Promise<SectionFile[]> {
  const files = await listFiles(dir, '.liquid');
  return Promise.all(
    files.map(async (name) => {
      const source = await readFile(join(dir, name), 'utf8');
      const m = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(source);
      let schema: Record<string, unknown> | null = null;
      if (m) {
        try {
          schema = JSON.parse(stripJsonComments(m[1]));
        } catch {
          schema = null;
        }
      }
      return { name, source, schema };
    }),
  );
}

async function readCssAssets(dir: string): Promise<string> {
  const files = (await listFiles(dir, '.css')).filter((f) => /^(base|theme|styles|global)/.test(f) || f.includes('base'));
  return (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8').catch(() => '')))).join('\n');
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const st = await stat(dir).catch(() => null);
  if (!st?.isDirectory()) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
}

function mostCommon(values: string[]): string | undefined {
  const c = new Map<string, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function mostCommonJson(values: unknown[]): unknown {
  const k = mostCommon(values.map((v) => JSON.stringify(v)));
  return k ? JSON.parse(k) : undefined;
}

function stripJsonComments(s: string): string {
  return s.replace(/^\s*\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
}
