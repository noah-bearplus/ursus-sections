import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SectionIR } from '@sf/core';
import { buildTemplate } from '@sf/converter';
import { generateSection } from '../src/liquid/generate.ts';
import { validateSectionFile } from '../src/liquid/validate.ts';
import { renderSectionPreview } from '../src/preview/render.ts';
import { GENERIC_PROFILE } from '../src/theme/profiles.ts';

function sampleIr(): SectionIR {
  const t = buildTemplate(
    `<div class="dtl-faq sf-dtl-faq"><h2 class="dtl-heading">Questions</h2>
      <div class="dtl-item" data-sf-item="question"><button class="dtl-q"><span>Why?</span></button><div class="dtl-a"><p>Because.</p><p>Really.</p></div></div>
      <div class="dtl-item" data-sf-item="question"><button class="dtl-q"><span>How?</span></button><div class="dtl-a"><p>Like this.</p></div></div>
      <img class="dtl-logo" src="assets/logo.png" alt=""></div>`,
    { prefix: 'dtl', repeaters: [{ item: '', blockType: 'question', blockName: 'Question' }] },
  );
  return { ...t, key: 'faq', name: 'Brand · FAQ', category: 'faq', rootClass: 'sf-dtl-faq', classPrefix: 'dtl-', css: '.sf-dtl-faq{--dtl-text-1:#111;color:var(--dtl-text-1)}', js: '', behaviors: [], modes: { attribute: 'data-theme', values: ['dark', 'light'], default: 'dark' }, assets: ['assets/logo.png'], fonts: [], layout: 'full', source: { url: 'https://example.com', selector: '.faq' }, stats: { rulesKept: 1, rulesTotal: 1, elements: 9, cssBytes: 40 } };
}

test('generated section validates and renders its preset content', async () => {
  const gen = generateSection(sampleIr(), { profile: GENERIC_PROFILE, cssMode: 'single-file' });
  const liquid = String(gen.files[0].content);
  assert.deepEqual(validateSectionFile('sections/dtl-faq.liquid', liquid).filter((i) => i.level === 'error'), []);
  assert.match(liquid, /\{\{ block\.shopify_attributes \}\}/);
  assert.match(liquid, /\{% stylesheet %\}/);
  assert.ok(gen.assets.some((a) => a.to === 'dtl-logo.png'));
  const out = await renderSectionPreview(liquid, { assetUrl: (n) => `/assets/${n}` });
  for (const s of ['Questions', 'Why?', 'How?', '<p>Because.</p><p>Really.</p>', 'data-theme="dark"', '/assets/dtl-logo.png']) assert.ok(out.html.includes(s), s);
});

test('validator rejects invalid schema values', () => {
  const bad = `<div></div>{% schema %}{"name":"A name that is clearly too long for Shopify","settings":[{"type":"url","id":"x","label":"X","default":"https://a.com"},{"type":"range","id":"r","label":"R","min":0,"max":500,"step":1,"default":4}]}{% endschema %}`;
  const msgs = validateSectionFile('s.liquid', bad).map((i) => i.message).join('\n');
  assert.match(msgs, /exceeds 25/);
  assert.match(msgs, /url "x" default/);
  assert.match(msgs, /101 steps/);
});
