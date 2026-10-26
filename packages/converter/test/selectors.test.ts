import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameworkClass, rewriteSelector, stripClasses, toTestSelector, DEFAULT_SCRUB } from '../src/selectors.ts';

const opts = { classPrefix: 'dtl-', idPrefix: 'dtl-', scrub: DEFAULT_SCRUB, scope: '.sf-dtl-hero' };

test('test selectors drop pseudo-elements, dynamic and state pseudo-classes', () => {
  assert.equal(toTestSelector('.card:hover .title::after', { stripState: false, scrub: DEFAULT_SCRUB }), '.card .title');
  assert.equal(toTestSelector('.faq-item[data-open] .answer', { stripState: true, scrub: DEFAULT_SCRUB }), '.faq-item .answer');
  assert.equal(toTestSelector(':hover > .x', { stripState: false, scrub: DEFAULT_SCRUB }), '* > .x');
});

test('root-anchored placement keeps the type selector first and adds the scope', () => {
  const out = rewriteSelector('html[data-theme=dark] .app > header .nav a:hover', { k: 2, v: 'A', cond: '[data-theme="dark"]' }, { ...opts, scope: '.sf-dtl-header' });
  assert.deepEqual(out, ['header.sf-dtl-header[data-theme="dark"] .dtl-nav a:hover']);
});

test('descendant and combined placements', () => {
  assert.deepEqual(rewriteSelector('.hero h1', { k: 1, v: 'B', cond: '' }, opts), ['.sf-dtl-hero h1']);
  assert.deepEqual(rewriteSelector('*', { k: 0, v: 'C', cond: '' }, opts), ['.sf-dtl-hero', '.sf-dtl-hero *']);
});

test('component scoping attributes become prefixed classes', () => {
  assert.equal(frameworkClass('data-astro-cid-2hxql3dq'), 'cid-2hxql3dq');
  assert.deepEqual(rewriteSelector('.card[data-astro-cid-2hxql3dq] .meta', { k: 0, v: 'B', cond: '' }, opts), ['.sf-dtl-hero .dtl-card.dtl-cid-2hxql3dq .dtl-meta']);
  assert.equal(stripClasses('.sf-x .dtl-cid-abcdef12', (c) => c.startsWith('dtl-cid-')), '.sf-x *');
});
