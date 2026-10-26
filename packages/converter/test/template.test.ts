import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplate } from '../src/template.ts';
import { renderStatic } from '../src/render-static.ts';
import type { SectionIR } from '@sf/core';

const html = `<section class="dtl-hero sf-dtl-hero">
  <h1 class="dtl-title">Hello <em>world</em></h1>
  <a class="dtl-cta" href="/pricing"><span class="dtl-cta-label">Get started</span></a>
  <div class="dtl-list">
    <div class="dtl-card" data-sf-item="card"><img class="dtl-card-img" src="assets/a.webp" alt="Alpha preview"><span class="dtl-card-title">Alpha</span><span class="dtl-badge">New</span><a class="dtl-card-link" href="/a" aria-label="Open Alpha">x</a></div>
    <div class="dtl-card" data-sf-item="card"><img class="dtl-card-img" src="assets/b.webp" alt="Beta preview"><span class="dtl-card-title">Beta</span><a class="dtl-card-link" href="/b" aria-label="Open Beta">x</a></div>
    <div class="dtl-card" data-sf-item="card" data-active="true"><img class="dtl-card-img" src="assets/c.webp" alt="Gamma preview"><span class="dtl-card-title">Gamma</span><a class="dtl-card-link" href="/c" aria-label="Open Gamma">x</a></div>
  </div>
  <nav class="dtl-links"><a href="/x">X</a><a href="/y">Y</a></nav>
</section>`;

test('fields, repeaters, optional elements, derived attributes and link lists', () => {
  const t = buildTemplate(html, { prefix: 'dtl', repeaters: [{ item: '', blockType: 'card', blockName: 'Card', presetCount: 3 }] });
  const ids = t.fields.map((f) => `${f.id}:${f.type}`);
  assert.ok(ids.includes('title:inline_richtext'), ids.join());
  assert.ok(ids.includes('cta_link:url'));
  assert.ok(ids.includes('cta_label:text'));
  assert.ok(t.fields.some((f) => f.type === 'textarea' && String(f.default).includes('X | /x')), 'link list → textarea');

  const card = t.repeaters[0];
  assert.equal(card.items.length, 3);
  const cardIds = card.fields.map((f) => f.id);
  assert.ok(cardIds.includes('img'));
  // An optional element that carries a field is rendered only when that field is filled.
  assert.ok(cardIds.includes('badge'), cardIds.join());
  assert.match(t.template, /data-sf-if="badge"/);
  assert.deepEqual(card.items.map((i) => i.badge), ['New', '', '']);
  assert.ok(cardIds.includes('active'), 'attribute present on one item → checkbox');
  assert.deepEqual(card.items.map((i) => i.active), [false, false, true]);
  assert.match(t.template, /aria-label="Open \{\{sf:title\}\}"/);
  assert.match(t.template, /alt="\{\{sf:title\}\} preview"/);
});

test('static rendering reproduces the source content', () => {
  const t = buildTemplate(html, { prefix: 'dtl', repeaters: [{ item: '', blockType: 'card', blockName: 'Card' }] });
  const ir = { ...t, key: 'hero', name: 'Hero', category: 'hero', rootClass: 'sf-dtl-hero', classPrefix: 'dtl-', css: '', js: '', behaviors: [], modes: null, assets: [], fonts: [], layout: 'full', source: { url: '', selector: '' }, stats: { rulesKept: 0, rulesTotal: 0, elements: 0, cssBytes: 0 } } as SectionIR;
  const out = renderStatic(ir);
  for (const s of ['Hello <em>world</em>', 'Get started', 'Alpha', 'Beta', 'Gamma', 'aria-label="Open Beta"', 'href="/y"']) assert.ok(out.includes(s), s);
  assert.equal((out.match(/dtl-badge/g) ?? []).length, 1);
  assert.equal((out.match(/data-active/g) ?? []).length, 1);
});

test('static rendering rewrites asset paths that are not fields', () => {
  const ir = {
    key: 'hero', name: 'Hero', category: 'hero', rootClass: 'sf-dtl-hero', classPrefix: 'dtl-', css: '', js: '', behaviors: [], modes: null, assets: [], fonts: [], layout: 'full',
    source: { url: '', selector: '' }, stats: { rulesKept: 0, rulesTotal: 0, elements: 0, cssBytes: 0 }, fields: [], repeaters: [],
    template: '<div class="sf-dtl-hero" style="background:url(assets/bg.webp)"><img src="assets/avatar.webp" srcset="assets/avatar.webp 1x, assets/avatar@2x.webp 2x" alt=""></div>',
  } as unknown as SectionIR;
  const out = renderStatic(ir, { assetUrl: (p) => `../../snapshot/${p}` });
  assert.match(out, /src="\.\.\/\.\.\/snapshot\/assets\/avatar\.webp"/);
  assert.match(out, /srcset="\.\.\/\.\.\/snapshot\/assets\/avatar\.webp 1x, \.\.\/\.\.\/snapshot\/assets\/avatar@2x\.webp 2x"/);
  assert.match(out, /url\(\.\.\/\.\.\/snapshot\/assets\/bg\.webp\)/);
});
