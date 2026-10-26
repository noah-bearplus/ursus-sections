// Shared data contracts between pipeline stages.
// Every stage reads/writes these as JSON artifacts inside a project workspace,
// so stages can run in separate processes/workers and be cached independently.

/* ----------------------------------------------------------------------------
 * Recipe — per-source hints. The pipeline is generic; a recipe only narrows it.
 * -------------------------------------------------------------------------- */

export interface Recipe {
  /** Stable id, used as the workspace folder name. e.g. "details-so-inspo" */
  id: string;
  name: string;
  /** Short brand prefix used for generated class names / file names. e.g. "dtl" */
  prefix: string;
  source: RecipeSource;
  viewports?: { desktop: number; mobile: number };
  sanitize?: {
    /** Extra selectors to drop before anything else (analytics, cookie banners...) */
    remove?: string[];
  };
  /** CSS injected before capture, to neutralise app-shell quirks (scroll containers, intro animations). */
  captureCss?: string;
  /** Document state to capture in (e.g. logged-out). null removes an attribute. */
  state?: { htmlAttrs?: Record<string, string | null> };
  /** Colour modes exposed by the source (e.g. html[data-theme=dark]). */
  modes?: RecipeModes;
  /** When omitted the segmenter detects sections automatically. */
  sections?: RecipeSection[];
}

export interface RecipeSource {
  url?: string;
  /** "Save page as… → Webpage, Complete" output */
  savedHtml?: string;
  savedAssetsDir?: string;
}

export interface RecipeModes {
  /** Element + attribute that switches modes, e.g. { selector: "html", attribute: "data-theme" } */
  selector: string;
  attribute: string;
  values: string[];
  default: string;
}

export interface RecipeSection {
  key: string;
  name: string;
  category: SectionCategory;
  /** Root element of the section in the source DOM. */
  selector: string;
  /** Selectors (inside the root) removed before conversion. */
  remove?: string[];
  /** DOM fix-ups applied before conversion (state resets, retagging…). */
  prepare?: PrepareOp[];
  /** Selectors protected from hidden-element pruning (e.g. closed dropdown menus). */
  keep?: string[];
  /** Repeated items that become Shopify blocks. */
  repeaters?: RecipeRepeater[];
  /** Field naming overrides keyed by selector (relative to section root). false = keep static. */
  fields?: Record<string, RecipeFieldHint | false>;
  /** Runtime behaviours to attach (see converter/behaviors). */
  behaviors?: RecipeBehavior[];
  /** Wrap the section with a full-bleed / page-width container in Shopify. */
  layout?: 'full' | 'page-width';
  description?: string;
}

export interface PrepareOp {
  selector: string;
  /** Change the element's tag (e.g. button → a) keeping attributes and children */
  retag?: string;
  setAttr?: Record<string, string>;
  removeAttr?: string[];
  removeClass?: string[];
  /** Remove these properties from the inline style attribute */
  removeStyle?: string[];
  /** Replace the element's text content */
  text?: string;
  /** Wrap the element in a new element, e.g. "div.group-heading" (normalises structural variants) */
  wrap?: string;
}

export interface RecipeBehavior {
  /** Behaviour name from the runtime registry (accordion, dropdown, hover-video…) */
  type: string;
  /** role → selector (relative to the section root) */
  roles: Record<string, string>;
  options?: Record<string, string | number | boolean>;
}

export interface RecipeRepeater {
  /** Selector of each item (relative to section root). */
  item: string;
  blockType: string;
  blockName: string;
  /** How many source items to keep as preset blocks. */
  presetCount?: number;
  max?: number;
}

export interface RecipeFieldHint {
  id?: string;
  /** Settings group header shown above the field in the editor */
  group?: string;
  info?: string;
  label?: string;
  type?: FieldType;
  /** For attribute bindings: which attribute carries the value (href, src…) */
  attr?: string;
}

export type SectionCategory =
  | 'header'
  | 'hero'
  | 'navigation'
  | 'filter'
  | 'grid'
  | 'features'
  | 'cta'
  | 'faq'
  | 'footer'
  | 'other';

/* ----------------------------------------------------------------------------
 * Snapshot — normalised capture of a source page (stage: ingest)
 * -------------------------------------------------------------------------- */

export interface Snapshot {
  meta: SourceMeta;
  /** Relative to the snapshot dir. Sanitised HTML with local asset URLs. */
  htmlPath: string;
  stylesheets: StylesheetRecord[];
  assets: AssetRecord[];
  /** JSON payloads embedded in the page (ld+json, hydration data…) */
  data: EmbeddedData[];
  /** Base font-size of the source root element in px (for rem → px). */
  rootFontSize: number;
}

export interface SourceMeta {
  url: string;
  title: string;
  description?: string;
  generator?: string;
  lang?: string;
  htmlAttrs: Record<string, string>;
  capturedAt: string;
  via: 'saved-page' | 'live';
}

export interface StylesheetRecord {
  id: string;
  order: number;
  inline: boolean;
  href?: string;
  media?: string;
  /** Relative to snapshot dir. */
  path: string;
  bytes: number;
}

export type AssetKind = 'image' | 'font' | 'video' | 'icon' | 'other';

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  /** Absolute URL in the source (best effort for saved pages). */
  originalUrl: string;
  /** Relative to snapshot dir; undefined when the asset was not available offline. */
  path?: string;
  mime?: string;
  bytes?: number;
  sha1?: string;
}

export interface EmbeddedData {
  selector: string;
  type: string;
  content: string;
}

/* ----------------------------------------------------------------------------
 * Design tokens (stage: design)
 * -------------------------------------------------------------------------- */

export type TokenKind =
  | 'color'
  | 'font-family'
  | 'font-weight'
  | 'font-size'
  | 'line-height'
  | 'letter-spacing'
  | 'font-settings'
  | 'radius'
  | 'shadow'
  | 'easing'
  | 'duration'
  | 'transition'
  | 'size'
  | 'number'
  | 'other';

export interface Token {
  /** Custom property name without leading dashes, e.g. "surface-2" */
  name: string;
  kind: TokenKind;
  group: string;
  /** Raw value per mode ("base" = :root) */
  values: Record<string, string>;
  /** Value with var() references resolved, per mode. */
  resolved: Record<string, string>;
  /** How many declarations reference this token. */
  usage: number;
}

export interface TypeStyle {
  id: string;
  role: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: string;
  fontWeight: string;
  letterSpacing: string;
  fontVariationSettings?: string;
  textTransform?: string;
  count: number;
  sample: string;
}

export interface FontFaceRecord {
  family: string;
  weight?: string;
  style?: string;
  src: string;
  /** false when the font binary was not available (licensed fonts, blocked hosts) */
  available: boolean;
}

export interface DesignTokens {
  source: string;
  modes: string[];
  defaultMode: string;
  tokens: Token[];
  typography: TypeStyle[];
  breakpoints: number[];
  fonts: FontFaceRecord[];
  keyframes: string[];
}

/* ----------------------------------------------------------------------------
 * Section IR (stage: convert) — the hand-off between "web" and "theme" worlds.
 *
 * `template` is clean HTML annotated with data-sf-* markers:
 *   data-sf-text="field"            innerHTML comes from field
 *   data-sf-attr="href:field;..."   attribute(s) come from field(s)
 *   data-sf-if="field"              element rendered only if field is truthy/non-blank
 *   data-sf-repeat="repeaterId"     element is the template of a repeater item
 * Static HTML, Liquid, or any other target is rendered from the same template.
 * -------------------------------------------------------------------------- */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'inline_richtext'
  | 'richtext'
  | 'url'
  | 'image'
  | 'video_url'
  | 'checkbox'
  | 'color'
  | 'select'
  | 'range';

export interface FieldIR {
  id: string;
  type: FieldType;
  label: string;
  default?: string | number | boolean;
  /** Extra info shown in the theme editor */
  info?: string;
  /** For select fields */
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Settings-panel grouping header */
  group?: string;
}

export interface RepeaterIR {
  id: string;
  blockType: string;
  blockName: string;
  fields: FieldIR[];
  /** Values for each source item, keyed by field id. */
  items: Record<string, string | number | boolean>[];
  presetCount: number;
  max: number;
}

export interface SectionIR {
  key: string;
  name: string;
  category: SectionCategory;
  description?: string;
  /** Namespace class on the root element, e.g. "dtl-hero" */
  rootClass: string;
  /** Class prefix applied to every renamed class, e.g. "dtl-" */
  classPrefix: string;
  template: string;
  css: string;
  js: string;
  fields: FieldIR[];
  repeaters: RepeaterIR[];
  behaviors: string[];
  modes: { attribute: string; values: string[]; default: string } | null;
  /** Asset ids referenced by the section (relative paths in the convert output). */
  assets: string[];
  /** Fonts the section needs (family names). */
  fonts: string[];
  layout: 'full' | 'page-width';
  source: { url: string; selector: string };
  stats: { rulesKept: number; rulesTotal: number; elements: number; cssBytes: number };
}

/* ----------------------------------------------------------------------------
 * Theme profile (stage: theme-analyze)
 * -------------------------------------------------------------------------- */

export interface ThemeProfile {
  name: string;
  /** Detected architecture of the target theme. */
  architecture: 'os2-sections' | 'os2-theme-blocks' | 'legacy' | 'unknown';
  /** Which adapter the generator should use. */
  adapter: 'dawn' | 'horizon' | 'generic';
  css: {
    /** How sections in this theme load their CSS. */
    strategy: 'stylesheet-tag' | 'style-tag' | 'asset-file';
    rootFontSize: number;
    /** CSS custom properties the theme exposes globally (name → sample value). */
    globals: Record<string, string>;
  };
  section: {
    containerClass: string | null;
    colorScheme: { settingType: 'color_scheme' | 'select' | null; settingId: string; classTemplate: string } | null;
    padding: {
      settings: unknown[];
      /** Liquid/CSS snippet used by the theme for padding classes, with {{ section.id }} */
      style: string | null;
      className: string | null;
    } | null;
    tag: string | null;
    className: string | null;
    disabledOn: unknown | null;
    animation: { settingPath: string; classes: string } | null;
  };
  schema: {
    usesTranslationKeys: boolean;
    presetsCategory: boolean;
  };
  classes: {
    headings: string[];
    buttonPrimary: string | null;
    buttonSecondary: string | null;
    richtext: string | null;
  };
  fonts: { heading: string | null; body: string | null };
  /** Maps semantic roles to theme CSS expressions, used by "theme" style source. */
  roleMap: Record<string, string>;
  /** Global theme rules generated sections must neutralise (e.g. "empty-elements-hidden"). */
  hazards: string[];
  stats: { sections: number; snippets: number; blocks: number };
}

/* ----------------------------------------------------------------------------
 * Generated output
 * -------------------------------------------------------------------------- */

export interface GeneratedFile {
  /** Path relative to theme root, e.g. "sections/dtl-hero.liquid" */
  path: string;
  content: string | Buffer;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  file: string;
  message: string;
}
