import { Liquid, Tag, type Context, type Emitter, type TagToken, type TopLevelToken } from 'liquidjs';
import type { SectionSchema } from '../liquid/schema.ts';

/**
 * Minimal Shopify runtime for previewing generated sections outside a store:
 * section/blocks objects built from schema defaults + first preset, and shims for the
 * Shopify-only filters and tags our generator emits. Not a theme emulator — it exists so
 * the pipeline can screenshot real Liquid output and diff it against the HTML clone.
 */
export interface PreviewOptions {
  /** asset file name → URL used in the preview document */
  assetUrl: (name: string) => string;
  /** Override setting values (section level) */
  settings?: Record<string, unknown>;
  sectionId?: string;
}

export async function renderSectionPreview(source: string, opts: PreviewOptions): Promise<{ html: string; css: string[]; js: string[] }> {
  const schemaJson = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/.exec(source)?.[1] ?? '{}';
  const schema = JSON.parse(schemaJson) as SectionSchema;
  const css: string[] = [];
  const js: string[] = [];
  const engine = new Liquid({ strictFilters: false, strictVariables: false, outputEscape: undefined });

  const capture = (name: string, sink: string[] | null, wrap?: (s: string) => string) =>
    engine.registerTag(
      name,
      class extends Tag {
        private tpl: TopLevelToken[] = [];
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          for (;;) {
            const t = remain.shift() as (TopLevelToken & { name?: string }) | undefined;
            if (!t) throw new Error(`{% ${name} %} not closed`);
            if (t.name === `end${name}`) break;
            this.tpl.push(t);
          }
        }
        *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
          const templates = this.liquid.parser.parseTokens(this.tpl);
          const out = (yield this.liquid.renderer.renderTemplates(templates, ctx)) as string;
          if (sink) sink.push(out);
          else if (wrap) emitter.write(wrap(out));
        }
      },
    );
  capture('schema', null, () => '');
  capture('stylesheet', css);
  capture('javascript', js);
  capture('style', null, (s) => `<style>${s}</style>`);
  engine.registerTag(
    'render',
    class extends Tag {
      *render(): Generator<unknown, void, unknown> {}
    },
  );
  engine.registerTag(
    'form',
    class extends Tag {
      private tpl: TopLevelToken[] = [];
      private args: string;
      constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
        super(token, remain, liquid);
        this.args = token.args;
        for (;;) {
          const t = remain.shift() as (TopLevelToken & { name?: string }) | undefined;
          if (!t) throw new Error('{% form %} not closed');
          if (t.name === 'endform') break;
          this.tpl.push(t);
        }
      }
      *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
        const cls = /class:\s*'([^']*)'/.exec(this.args)?.[1] ?? '';
        const inner = (yield this.liquid.renderer.renderTemplates(this.liquid.parser.parseTokens(this.tpl), ctx.spawn({ form: { posted_successfully: false, errors: null } }))) as string;
        emitter.write(`<form method="post" action="/contact#contact_form" class="${cls}">${inner}</form>`);
      }
    },
  );

  engine.registerFilter('asset_url', (name: string) => opts.assetUrl(String(name)));
  engine.registerFilter('image_url', (img: unknown, ...args: unknown[]) => {
    void args;
    if (!img) return '';
    return typeof img === 'string' ? img : ((img as { src?: string }).src ?? '');
  });
  engine.registerFilter('stylesheet_tag', (url: string) => `<link rel="stylesheet" href="${url}">`);
  engine.registerFilter('script_tag', (url: string) => `<script src="${url}" defer></script>`);
  engine.registerFilter('t', (key: string) => String(key));
  engine.registerFilter('placeholder_svg_tag', () => '<svg class="placeholder-svg" viewBox="0 0 10 10"></svg>');

  const defaults = (settings: SectionSchema['settings']) => {
    const out: Record<string, unknown> = {};
    for (const s of settings) if (s.id) out[s.id] = s.default ?? (s.type === 'checkbox' ? false : '');
    return out;
  };
  const sectionId = opts.sectionId ?? 'template--preview__main';
  const preset = schema.presets?.[0];
  const blocks = (preset?.blocks ?? []).map((b, i) => {
    const def = schema.blocks?.find((x) => x.type === b.type);
    const settings = { ...defaults(def?.settings ?? []), ...(b.settings ?? {}) };
    return { id: `block-${i + 1}`, type: b.type, settings, shopify_attributes: `data-shopify-editor-block='{"id":"block-${i + 1}","type":"${b.type}"}'` };
  });
  const section = { id: sectionId, settings: { ...defaults(schema.settings ?? []), ...(opts.settings ?? {}) }, blocks };
  const html = await engine.parseAndRender(source, {
    section,
    settings: { animations_reveal_on_scroll: false },
    routes: { root_url: '/', search_url: '/search', account_login_url: '/account/login', account_register_url: '/account/register', cart_url: '/cart' },
    request: { design_mode: false, page_type: 'index' },
    customer: null,
  });
  return {
    html: `<div id="shopify-section-${sectionId}" class="shopify-section">${html}</div>`,
    css,
    js,
  };
}
