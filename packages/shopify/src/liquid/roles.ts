import type { SectionIR, ThemeProfile } from '@sf/core';

/** Source token name → semantic role. Extend per design system as needed. */
const ROLE_RULES: [RegExp, string][] = [
  [/^(text|text-1|foreground|text-primary|fg)$/, 'text'],
  [/^(text-[2-9]|text-muted|text-secondary|muted)$/, 'text-muted'],
  [/^(surface-[01]|background|bg|page-background|floating-surface-background|workspace-surface-background)$/, 'background'],
  [/^(surface-[23]|floating-surface-[23]|surface|card-background)$/, 'surface'],
  [/^(surface-[4-9]|floating-surface-[4-9]|surface-strong)$/, 'surface-strong'],
  [/^(border|border-\d+(-\d+)?|border-color)$/, 'border'],
  [/^(accent|primary|brand)$/, 'accent'],
  [/^(on-accent|on-primary)$/, 'on-accent'],
  [/^font-body$/, 'font-body'],
  [/^font-(heading|hero-heading|display)$/, 'font-heading'],
];

export function roleOf(token: string): string | null {
  for (const [re, role] of ROLE_RULES) if (re.test(token)) return role;
  return null;
}

/**
 * CSS that re-points the section's design tokens at the theme's own colour scheme and
 * fonts when the merchant picks "Match theme". Same markup, same CSS — only tokens move.
 */
export function themeStyleCss(ir: SectionIR, profile: ThemeProfile): string {
  if (!Object.keys(profile.roleMap).length) return '';
  const prefix = ir.classPrefix;
  const defined = new Set([...ir.css.matchAll(new RegExp(`--${prefix}([\\w-]+)\\s*:`, 'g'))].map((m) => m[1]));
  const lines: string[] = [];
  for (const name of defined) {
    const role = roleOf(name);
    const value = role ? profile.roleMap[role] : undefined;
    if (value) lines.push(`  --${prefix}${name}: ${value};`);
  }
  if (!lines.length) return '';
  const sel = ir.modes ? `.${ir.rootClass}[data-sf-style="theme"][${ir.modes.attribute}]` : `.${ir.rootClass}[data-sf-style="theme"]`;
  return `\n/* "Match theme" style source: tokens follow the theme's colour scheme & fonts */\n${sel} {\n${lines.join('\n')}\n}\n`;
}
