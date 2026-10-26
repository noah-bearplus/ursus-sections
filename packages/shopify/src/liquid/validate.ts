import { Liquid, Tag, type TagToken, type Context, type Emitter, type TopLevelToken } from 'liquidjs';
import type { ValidationIssue } from '@sf/core';
import { LIMITS, type SectionSchema, type SettingDef } from './schema.ts';

const SETTING_TYPES = new Set([
  'header', 'paragraph', 'text', 'textarea', 'richtext', 'inline_richtext', 'html', 'liquid', 'url', 'image_picker', 'video',
  'video_url', 'checkbox', 'number', 'radio', 'range', 'select', 'color', 'color_background', 'color_scheme',
  'color_scheme_group', 'font_picker', 'collection', 'collection_list', 'product', 'product_list', 'blog', 'page',
  'link_list', 'article', 'metaobject', 'metaobject_list', 'text_alignment',
]);

/** Liquid engine that knows Shopify's block tags well enough to parse theme files. */
export function shopifyParser(): Liquid {
  const engine = new Liquid({ strictFilters: false, strictVariables: false });
  for (const name of ['schema', 'stylesheet', 'javascript', 'style', 'form', 'paginate']) {
    engine.registerTag(
      name,
      class extends Tag {
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          const end = `end${name}`;
          // Consume tokens up to the matching end tag.
          for (let depth = 0; remain.length; ) {
            const t = remain.shift() as TopLevelToken & { name?: string };
            if (t.name === name) depth++;
            if (t.name === end) {
              if (depth === 0) return;
              depth--;
            }
          }
          throw new Error(`tag {% ${name} %} not closed`);
        }
        *render(_ctx: Context, _emitter: Emitter): Generator<unknown, void, unknown> {}
      },
    );
  }
  for (const name of ['render', 'section', 'sections', 'content_for', 'layout']) {
    engine.registerTag(
      name,
      class extends Tag {
        *render(): Generator<unknown, void, unknown> {}
      },
    );
  }
  return engine;
}

export function validateSectionFile(path: string, source: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string) => issues.push({ level: 'error', file: path, message });
  const warn = (message: string) => issues.push({ level: 'warning', file: path, message });

  try {
    shopifyParser().parse(source);
  } catch (e) {
    err(`Liquid syntax: ${(e as Error).message.split('\n')[0]}`);
  }

  const schemas = [...source.matchAll(/\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/g)];
  if (schemas.length !== 1) {
    err(`expected exactly one {% schema %} block, found ${schemas.length}`);
    return issues;
  }
  let schema: SectionSchema;
  try {
    schema = JSON.parse(schemas[0][1]);
  } catch (e) {
    err(`schema is not valid JSON: ${(e as Error).message}`);
    return issues;
  }
  if (!schema.name) err('schema.name is required');
  else if (schema.name.length > LIMITS.name && !schema.name.startsWith('t:')) err(`schema.name "${schema.name}" exceeds ${LIMITS.name} characters`);
  checkSettings(schema.settings ?? [], 'section', err, warn);

  const blockTypes = new Set<string>();
  for (const b of schema.blocks ?? []) {
    if (blockTypes.has(b.type)) err(`duplicate block type "${b.type}"`);
    blockTypes.add(b.type);
    if (!b.type.startsWith('@')) {
      if (!b.name) err(`block "${b.type}" needs a name`);
      else if (b.name.length > LIMITS.blockName && !b.name.startsWith('t:')) err(`block name "${b.name}" exceeds ${LIMITS.blockName} characters`);
      checkSettings(b.settings ?? [], `block ${b.type}`, err, warn);
    }
  }
  if (schema.max_blocks !== undefined && (schema.max_blocks < 1 || schema.max_blocks > LIMITS.maxBlocks)) err(`max_blocks must be 1–${LIMITS.maxBlocks}`);
  for (const p of schema.presets ?? []) {
    if (!p.name) err('preset without name');
    const n = p.blocks?.length ?? 0;
    if (schema.max_blocks !== undefined && n > schema.max_blocks) err(`preset "${p.name}" has ${n} blocks > max_blocks ${schema.max_blocks}`);
    for (const pb of p.blocks ?? []) {
      if (!blockTypes.has(pb.type)) err(`preset block type "${pb.type}" is not declared`);
      const def = schema.blocks?.find((b) => b.type === pb.type);
      for (const k of Object.keys(pb.settings ?? {})) {
        if (!def?.settings.some((s) => s.id === k)) err(`preset block "${pb.type}" sets unknown setting "${k}"`);
      }
    }
    const perType = new Map<string, number>();
    for (const pb of p.blocks ?? []) perType.set(pb.type, (perType.get(pb.type) ?? 0) + 1);
    for (const b of schema.blocks ?? []) if (b.limit !== undefined && (perType.get(b.type) ?? 0) > b.limit) err(`preset exceeds limit of block "${b.type}"`);
  }

  // References to settings that do not exist.
  const sectionIds = new Set((schema.settings ?? []).map((s) => s.id).filter(Boolean));
  for (const m of source.matchAll(/section\.settings\.([a-z0-9_-]+)/gi)) if (!sectionIds.has(m[1])) err(`section.settings.${m[1]} is not defined in the schema`);
  const blockIds = new Set((schema.blocks ?? []).flatMap((b) => b.settings.map((s) => s.id)));
  for (const m of source.matchAll(/block\.settings\.([a-z0-9_-]+)/gi)) if (!blockIds.has(m[1])) err(`block.settings.${m[1]} is not defined in any block`);
  if ((schema.blocks ?? []).length && !source.includes('block.shopify_attributes')) warn('blocks are not rendered with {{ block.shopify_attributes }} (theme editor selection will not work)');
  return issues;
}

function checkSettings(settings: SettingDef[], where: string, err: (m: string) => void, warn: (m: string) => void): void {
  const ids = new Set<string>();
  for (const s of settings) {
    if (!SETTING_TYPES.has(s.type)) err(`${where}: unknown setting type "${s.type}"`);
    if (s.type === 'header' || s.type === 'paragraph') {
      if (!s.content) err(`${where}: ${s.type} needs content`);
      continue;
    }
    if (!s.id) {
      err(`${where}: setting without id`);
      continue;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(s.id)) err(`${where}: invalid setting id "${s.id}"`);
    if (ids.has(s.id)) err(`${where}: duplicate setting id "${s.id}"`);
    ids.add(s.id);
    if (!s.label) err(`${where}: setting "${s.id}" needs a label`);
    const d = s.default;
    switch (s.type) {
      case 'checkbox':
        if (d !== undefined && typeof d !== 'boolean') err(`${where}: checkbox "${s.id}" default must be boolean`);
        break;
      case 'range': {
        if ([s.min, s.max, s.step].some((x) => typeof x !== 'number')) err(`${where}: range "${s.id}" needs min/max/step`);
        else {
          if ((s.max! - s.min!) / s.step! > 101) err(`${where}: range "${s.id}" has more than 101 steps`);
          if (typeof d !== 'number' || d < s.min! || d > s.max!) err(`${where}: range "${s.id}" default out of bounds`);
        }
        break;
      }
      case 'select':
      case 'radio':
        if (!s.options?.length) err(`${where}: ${s.type} "${s.id}" needs options`);
        else if (d !== undefined && !s.options.some((o) => o.value === d)) err(`${where}: ${s.type} "${s.id}" default is not an option`);
        break;
      case 'url':
        if (d !== undefined && d !== '/collections' && d !== '/collections/all') err(`${where}: url "${s.id}" default must be /collections or /collections/all`);
        break;
      case 'richtext':
        if (typeof d === 'string' && !/^\s*<(p|ul|ol|h[1-6])\b/i.test(d)) err(`${where}: richtext "${s.id}" default must start with a block element`);
        break;
      case 'inline_richtext':
        if (typeof d === 'string' && /<(p|div|ul|ol|h[1-6])\b/i.test(d)) err(`${where}: inline_richtext "${s.id}" default contains block elements`);
        break;
      case 'image_picker':
      case 'video':
        if (d !== undefined) err(`${where}: ${s.type} "${s.id}" cannot have a default`);
        break;
      case 'text':
        if (typeof d === 'string' && d.length > 500) warn(`${where}: text "${s.id}" default is long (${d.length} chars)`);
        break;
    }
  }
}
