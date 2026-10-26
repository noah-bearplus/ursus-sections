import type { ThemeProfile } from '@sf/core';

/**
 * Used when no theme folder is given: self-contained sections that work in any
 * Online Store 2.0 theme (own padding settings, no reliance on theme variables).
 */
export const GENERIC_PROFILE: ThemeProfile = {
  name: 'Generic OS 2.0',
  architecture: 'os2-sections',
  adapter: 'generic',
  css: { strategy: 'stylesheet-tag', rootFontSize: 16, globals: {} },
  section: {
    containerClass: null,
    colorScheme: null,
    padding: {
      settings: [
        { type: 'range', id: 'padding_top', min: 0, max: 160, step: 4, unit: 'px', label: 'Top padding', default: 0 },
        { type: 'range', id: 'padding_bottom', min: 0, max: 160, step: 4, unit: 'px', label: 'Bottom padding', default: 0 },
      ],
      style:
        '{%- style -%}\n  #shopify-section-{{ section.id }} .sf-section-padding {\n    padding-top: {{ section.settings.padding_top }}px;\n    padding-bottom: {{ section.settings.padding_bottom }}px;\n  }\n{%- endstyle -%}',
      className: 'sf-section-padding',
    },
    tag: 'section',
    className: null,
    disabledOn: null,
    animation: null,
  },
  schema: { usesTranslationKeys: false, presetsCategory: false },
  classes: { headings: [], buttonPrimary: null, buttonSecondary: null, richtext: null },
  fonts: { heading: null, body: null },
  roleMap: {},
  hazards: ['empty-elements-hidden'],
  stats: { sections: 0, snippets: 0, blocks: 0 },
};
