'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { niceTicks, distToSegment } = require('../public/js/orion-render.js');

const DAY = 86400;

test('niceTicks picks a step that keeps labels apart and aligns to calendar boundaries', () => {
  // two years across 1600 px -> about 2.2 px/day: expect month-ish ticks, not days
  const t0 = Date.UTC(2022, 0, 15) / 1000, t1 = Date.UTC(2024, 0, 15) / 1000;
  const ticks = niceTicks(t0, t1, 1600 / (t1 - t0), 90);
  assert.ok(ticks.length >= 4 && ticks.length < 40, 'got ' + ticks.length);
  for (let i = 1; i < ticks.length; i++) assert.ok((ticks[i].t - ticks[i - 1].t) * 1600 / (t1 - t0) >= 80, 'ticks too close');
  ticks.forEach((t) => assert.ok(t.t >= t0 && t.t <= t1));
  // month/year ticks fall on the first of a month, midnight UTC
  ticks.forEach((t) => { const d = new Date(t.t * 1000); assert.equal(d.getUTCDate(), 1); assert.equal(d.getUTCHours(), 0); });
  assert.match(ticks[0].label, /^20\d\d(-\d\d)?$/);
});

test('niceTicks zooms in to days and hours as pixels per second grow', () => {
  const t0 = Date.UTC(2023, 5, 1) / 1000;
  const days = niceTicks(t0, t0 + 10 * DAY, 1000 / (10 * DAY), 90);
  assert.ok(days.every((t) => t.t % DAY === 0), 'day ticks sit on midnight UTC');
  assert.match(days[0].label, /^\d{4}-\d\d-\d\d$/);
  const hours = niceTicks(t0, t0 + 6 * 3600, 1000 / (6 * 3600), 90);
  assert.match(hours[0].label, /^\d\d-\d\d \d\d:\d\d$/);
  assert.ok(hours.length >= 4);
});

test('niceTicks is empty for a degenerate scale and never returns an unbounded list', () => {
  assert.deepEqual(niceTicks(0, 0, 0, 90), []);
  assert.deepEqual(niceTicks(10, 5, 1, 90), []);
  assert.ok(niceTicks(0, 1e10, 1e-3, 1).length <= 400);
});

test('distToSegment: perpendicular, end caps and zero-length segments', () => {
  assert.equal(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(distToSegment({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
});
