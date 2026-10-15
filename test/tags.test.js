'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../public/js/orion-tags.js');

test('presets cover the classifications an investigator needs, each with a colour and a shape', () => {
  ['EXCH', 'THREAT', 'VICTIM', 'MIXER', 'MARKET', 'SERVICE', 'GAMBLING', 'PAYMENT', 'WATCH'].forEach((id) => {
    const p = T.preset(id);
    assert.ok(p, id);
    assert.match(p.color, /^#[0-9a-f]{6}$/);
    assert.ok(T.SHAPES.includes(p.shape), id + ' shape');
    assert.ok(p.name.length > 2);
  });
  assert.equal(new Set(T.PRESETS.map((p) => p.id)).size, T.PRESETS.length, 'no duplicate ids');
  assert.equal(T.preset('NOPE'), null);
  assert.equal(T.preset('__proto__'), null, 'prototype keys are not presets');
  assert.equal(T.preset('constructor'), null);
});

test('EXCH and THREAT are visibly different from each other and from the default node colours', () => {
  const defaults = ['#5b8def', '#e0a458', '#f2c94c', '#9aa3ad', '#7c8794'];
  assert.notEqual(T.preset('EXCH').color, T.preset('THREAT').color);
  assert.notEqual(T.preset('EXCH').shape, T.preset('THREAT').shape);
  T.PRESETS.forEach((p) => assert.ok(!defaults.includes(p.color), p.id + ' collides with a default colour'));
});

test('cleanTag: presets are recognised in any case, custom tags are tidied and capped', () => {
  assert.equal(T.cleanTag('exch'), 'EXCH');
  assert.equal(T.cleanTag('  Threat '), 'THREAT');
  assert.equal(T.cleanTag('Lazarus group'), 'Lazarus group');
  assert.equal(T.cleanTag('a'.repeat(50)).length, 20);
  assert.equal(T.cleanTag('<img src=x onerror=1>'), 'img srcx onerror1');
  assert.equal(T.cleanTag('😀😀'), '');
  assert.equal(T.cleanTag(null), '');
  assert.equal(T.cleanTag(5), '');
  assert.equal(T.cleanTag('a   b'), 'a b');
});

test('cleanColor only accepts #rrggbb', () => {
  assert.equal(T.cleanColor('#FF00aa'), '#ff00aa');
  ['red', '#fff', '#ff00aa00', 'rgb(1,2,3)', 'url(http://x)', '#gg0000', '', null, undefined, 5, 'javascript:1', '#ff00aa; background:url(x)'].forEach((c) => assert.equal(T.cleanColor(c), '', String(c)));
});

test('cleanShape only accepts the known shapes', () => {
  T.SHAPES.forEach((s) => assert.equal(T.cleanShape(s), s));
  ['blob', '', null, 'Circle', 'circle ', '__proto__'].forEach((s) => assert.equal(T.cleanShape(s), ''));
});

test('apply: a preset sets tag, colour and shape; the colour and shape can then change on their own', () => {
  const n = { id: 'addr:x', type: 'addr' };
  T.apply(n, { tag: 'EXCH' });
  assert.deepEqual([n.tag, n.color, n.shape], ['EXCH', T.preset('EXCH').color, T.preset('EXCH').shape]);
  T.apply(n, { color: '#123456' });
  assert.deepEqual([n.tag, n.color, n.shape], ['EXCH', '#123456', T.preset('EXCH').shape]);
  T.apply(n, { shape: 'star' });
  assert.equal(n.shape, 'star'); assert.equal(n.color, '#123456');
  T.apply(n, { color: '' });
  assert.ok(!('color' in n), 'an empty colour clears it');
  T.apply(n, { tag: 'THREAT' });
  assert.deepEqual([n.color, n.shape], [T.preset('THREAT').color, T.preset('THREAT').shape], 'choosing another preset restyles');
  T.apply(n, { tag: '' });
  assert.ok(!('tag' in n) && !('color' in n) && !('shape' in n), 'no tag: back to the usual look');
});

test('apply: a custom tag leaves the colour and shape alone; keepStyle keeps them on a preset too', () => {
  const n = { id: 'a', type: 'addr', color: '#112233', shape: 'cross' };
  T.apply(n, { tag: 'Lazarus group' });
  assert.deepEqual([n.tag, n.color, n.shape], ['Lazarus group', '#112233', 'cross']);
  const m = { id: 'b', type: 'addr', color: '#112233' };
  T.apply(m, { tag: 'EXCH' }, true);
  assert.deepEqual([m.tag, m.color, m.shape], ['EXCH', '#112233', undefined]);
});

test('apply: invalid input never reaches the vertex', () => {
  const n = { id: 'a', type: 'addr' };
  T.apply(n, { tag: '<script>', color: 'url(x)', shape: 'blob' });
  assert.equal(n.tag, 'script'); assert.ok(!('color' in n) && !('shape' in n));
  assert.equal(T.apply(null, { tag: 'EXCH' }), null);
  assert.deepEqual(T.apply({ id: 'z' }, null), { id: 'z' });
});

test('sanitize cleans an object from outside in place and drops what is not valid', () => {
  const n = T.sanitize({ id: 'a', tag: 'exch', color: 'RED', shape: 'blob', label: 'keep me' });
  assert.deepEqual(n, { id: 'a', tag: 'EXCH', label: 'keep me' });
  assert.deepEqual(T.sanitize({ id: 'b', color: '#ABCDEF', shape: 'star' }), { id: 'b', color: '#abcdef', shape: 'star' });
  assert.deepEqual(T.sanitize({ id: 'c', tag: 42 }), { id: 'c' });
});

test('resolve and summarise', () => {
  assert.deepEqual(T.resolve({ tag: 'EXCH', color: '#2ecc71', shape: 'hexagon' }), { tag: 'EXCH', name: 'Exchange', color: '#2ecc71', shape: 'hexagon' });
  assert.equal(T.resolve({ tag: 'Lazarus group' }).name, 'Lazarus group');
  assert.deepEqual(T.resolve(null), { tag: '', name: '', color: '', shape: '' });
  const s = T.summarise([{ tag: 'EXCH' }, { tag: 'EXCH' }, { tag: 'THREAT', color: '#000000' }, { tag: 'Custom' }, {}]);
  assert.deepEqual(s.map((x) => [x.tag, x.count]), [['EXCH', 2], ['Custom', 1], ['THREAT', 1]]);
  assert.equal(s.find((x) => x.tag === 'THREAT').color, '#000000', 'a vertex colour overrides the preset in the legend');
  assert.equal(s.find((x) => x.tag === 'EXCH').shape, 'hexagon');
});
