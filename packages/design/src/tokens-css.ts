import type { DesignTokens, Token } from '@sf/core';

export interface TokensCssOptions {
  /** Selector that holds base values. Default ":root" */
  rootSelector?: string;
  /** Attribute used to switch modes, e.g. "data-theme". When null, only base values are emitted. */
  modeAttribute?: string | null;
  /** Prefix applied to every custom property name (namespacing for theme embedding). */
  varPrefix?: string;
  /** Only emit these tokens (plus anything they reference). */
  only?: Set<string>;
}

/** Expands a token set to include every token referenced (transitively) by var(). */
export function closeOverReferences(tokens: Token[], wanted: Iterable<string>): Set<string> {
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const out = new Set<string>();
  const stack = [...wanted];
  while (stack.length) {
    const n = stack.pop()!;
    if (out.has(n)) continue;
    const t = byName.get(n);
    if (!t) continue;
    out.add(n);
    for (const v of Object.values(t.values)) for (const m of v.matchAll(/var\(\s*--([\w-]+)/g)) stack.push(m[1]);
  }
  return out;
}

export function renameVars(value: string, prefix: string, known: Set<string>): string {
  if (!prefix) return value;
  return value.replace(/var\(\s*--([\w-]+)/g, (m, n: string) => (known.has(n) ? `var(--${prefix}${n}` : m));
}

export function tokensToCss(design: DesignTokens, opts: TokensCssOptions = {}): string {
  const root = opts.rootSelector ?? ':root';
  const prefix = opts.varPrefix ?? '';
  const attr = opts.modeAttribute === undefined ? 'data-theme' : opts.modeAttribute;
  const tokens = design.tokens.filter((t) => !opts.only || opts.only.has(t.name));
  const known = new Set(design.tokens.map((t) => t.name));
  const decl = (t: Token, v: string) => `  --${prefix}${t.name}: ${renameVars(v, prefix, known)};`;

  const blocks: string[] = [];
  const base = tokens.filter((t) => t.values.base !== undefined).map((t) => decl(t, t.values.base));
  blocks.push(`${root} {\n${base.join('\n')}\n}`);
  if (attr) {
    for (const mode of design.modes) {
      const lines = tokens.filter((t) => t.values[mode] !== undefined && t.values[mode] !== t.values.base).map((t) => decl(t, t.values[mode]));
      if (!lines.length) continue;
      const sel = root === ':root' ? `[${attr}="${mode}"]` : `${root}[${attr}="${mode}"]`;
      blocks.push(`${sel} {\n${lines.join('\n')}\n}`);
    }
  }
  return blocks.join('\n\n') + '\n';
}
