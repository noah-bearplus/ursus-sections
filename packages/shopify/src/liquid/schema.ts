import type { FieldIR, SectionIR, ThemeProfile } from '@sf/core';
import { titleCase } from '@sf/core';

export interface SettingDef {
  type: string;
  id?: string;
  label?: string;
  content?: string;
  default?: unknown;
  info?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
}

export interface SectionSchema {
  name: string;
  tag?: string;
  class?: string;
  limit?: number;
  max_blocks?: number;
  enabled_on?: unknown;
  disabled_on?: unknown;
  settings: SettingDef[];
  blocks?: { type: string; name: string; limit?: number; settings: SettingDef[] }[];
  presets?: { name: string; blocks?: { type: string; settings?: Record<string, unknown> }[] }[];
}

/** Shopify limits we design against (validated again in validate.ts). */
export const LIMITS = { name: 25, blockName: 25, maxBlocks: 50, label: 70 };

export function shortName(name: string, max = LIMITS.name): string {
  if (name.length <= max) return name;
  const tail = name.split(/\s+[·|—-]\s+/).pop()!;
  return tail.length <= max ? tail : tail.slice(0, max).trim();
}

export function buildSchema(ir: SectionIR, profile: ThemeProfile, opts: { fallbackFields: Set<string> }): SectionSchema {
  const settings: SettingDef[] = [];
  const groups = new Map<string, FieldIR[]>();
  const ungrouped: FieldIR[] = [];
  for (const f of ir.fields) (f.group ? groups.set(f.group, [...(groups.get(f.group) ?? []), f]) : ungrouped.push(f));

  const fb = (v: string) => fallbackValue(v, ir);
  const push = (f: FieldIR, key: string) => settings.push(...settingsFor(f, opts.fallbackFields.has(key + f.id), fb));
  ungrouped.forEach((f) => push(f, ''));
  for (const [g, fs] of groups) {
    settings.push({ type: 'header', content: g });
    fs.forEach((f) => push(f, ''));
  }

  // Appearance: colour mode, style source, theme colour scheme, theme padding.
  settings.push({ type: 'header', content: 'Appearance' });
  if (ir.modes) {
    settings.push({
      type: 'select',
      id: 'color_mode',
      label: 'Colour mode',
      options: ir.modes.values.map((v) => ({ value: v, label: titleCase(v) })),
      default: ir.modes.default,
    });
  }
  const hasThemeStyle = Object.keys(profile.roleMap).length > 0;
  settings.push({
    type: 'select',
    id: 'style_source',
    label: 'Style source',
    options: [
      { value: 'original', label: 'Original design' },
      ...(hasThemeStyle ? [{ value: 'theme', label: 'Match theme colours & fonts' }] : []),
    ],
    default: 'original',
    info: hasThemeStyle ? 'Original keeps the cloned look. Match theme uses your colour scheme and fonts.' : undefined,
  });
  if (profile.section.colorScheme && hasThemeStyle) {
    settings.push({
      type: 'color_scheme',
      id: profile.section.colorScheme.settingId,
      label: 'Colour scheme',
      default: 'scheme-1',
      info: 'Used when Style source is Match theme.',
    });
  }
  if (profile.section.padding) {
    for (const p of profile.section.padding.settings as SettingDef[]) settings.push({ ...p, default: 0 });
  }

  const blocks = ir.repeaters.map((r) => ({
    type: r.blockType,
    name: shortName(r.blockName, LIMITS.blockName),
    ...(r.max < LIMITS.maxBlocks ? { limit: r.max } : {}),
    settings: r.fields.flatMap((f) => settingsFor(f, opts.fallbackFields.has(`${r.id}.${f.id}`), fb)),
  }));

  const presetBlocks = ir.repeaters.flatMap((r) =>
    r.items.slice(0, r.presetCount).map((item) => {
      const s: Record<string, unknown> = {};
      for (const f of r.fields) {
        const v = item[f.id];
        if (v === undefined || v === '') continue;
        if (f.type === 'image') {
          if (opts.fallbackFields.has(`${r.id}.${f.id}`)) s[`${f.id}_fallback`] = fallbackValue(String(v), ir);
          continue;
        }
        if (f.type === 'url' && !isSafeUrlValue(String(v))) continue;
        s[f.id] = normaliseDefault(f, v);
      }
      return { type: r.blockType, settings: s };
    }),
  );

  const schema: SectionSchema = {
    name: shortName(ir.name),
    tag: ir.category === 'header' ? 'header' : ir.category === 'footer' ? 'footer' : (profile.section.tag ?? 'section'),
    class: [profile.section.className, 'sf-section'].filter(Boolean).join(' '),
    settings: settings.filter((s) => s.type !== 'select' || (s.options?.length ?? 0) > 0),
  };
  if (ir.category === 'header') schema.enabled_on = { groups: ['header'] };
  else if (ir.category === 'footer') schema.enabled_on = { groups: ['footer'] };
  else if (profile.section.disabledOn) schema.disabled_on = profile.section.disabledOn;
  if (blocks.length) {
    schema.blocks = blocks;
    schema.max_blocks = Math.min(LIMITS.maxBlocks, ir.repeaters.reduce((n, r) => n + r.max, 0));
  }
  schema.presets = [{ name: shortName(ir.name), ...(presetBlocks.length ? { blocks: presetBlocks.slice(0, schema.max_blocks ?? LIMITS.maxBlocks) } : {}) }];
  return schema;
}

function settingsFor(f: FieldIR, withFallback: boolean, fb: (v: string) => string): SettingDef[] {
  const base = { id: f.id, label: f.label.slice(0, LIMITS.label), ...(f.info ? { info: f.info } : {}) };
  switch (f.type) {
    case 'image': {
      const out: SettingDef[] = [{ type: 'image_picker', ...base }];
      if (withFallback) {
        out.push({
          type: 'text',
          id: `${f.id}_fallback`,
          label: `${f.label} — demo fallback`.slice(0, LIMITS.label),
          info: 'Theme asset file name or full URL, shown until an image is picked.',
          default: typeof f.default === 'string' && f.default ? fb(f.default) : undefined,
        });
      }
      return out;
    }
    case 'url':
      return [{ type: 'url', ...base, ...(isDefaultableUrl(String(f.default ?? '')) ? { default: String(f.default) } : {}) }];
    case 'checkbox':
      return [{ type: 'checkbox', ...base, default: Boolean(f.default) }];
    case 'select':
      return [{ type: 'select', ...base, options: f.options ?? [], default: f.default }];
    case 'range':
      return [{ type: 'range', ...base, min: f.min, max: f.max, step: f.step, unit: f.unit, default: f.default }];
    default:
      return [{ type: f.type, ...base, ...(f.default !== undefined && f.default !== '' ? { default: normaliseDefault(f, f.default) } : {}) }];
  }
}

function normaliseDefault(f: FieldIR, v: unknown): unknown {
  if (f.type === 'checkbox') return Boolean(v);
  const s = String(v);
  if (f.type === 'richtext') return /^\s*<(p|ul|ol|h[1-6])\b/i.test(s) ? s : `<p>${s}</p>`;
  if (f.type === 'inline_richtext') return s.replace(/<\/?(p|div|ul|ol|li|h[1-6])\b[^>]*>/gi, '');
  return s;
}

/** Shopify only accepts "/collections" and "/collections/all" as url defaults. */
function isDefaultableUrl(v: string): boolean {
  return v === '/collections' || v === '/collections/all';
}

/** Values merchants could have typed themselves (relative store paths). */
function isSafeUrlValue(v: string): boolean {
  return v.startsWith('/') && !v.startsWith('//');
}

export function fallbackValue(v: string, ir: SectionIR): string {
  if (!v.startsWith('assets/')) return v;
  const prefix = ir.classPrefix;
  const b = v.replace(/^assets\//, '');
  return b.startsWith(prefix) ? b : `${prefix}${b}`;
}
