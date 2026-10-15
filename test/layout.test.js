'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/orion-model.js');
const F = require('../public/js/orion-filter.js');
const L = require('../public/js/orion-layout.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

function realGraph() {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t);
  g.addOutspends(t.txid, fx('outspends_normal.json'));
  [0, 1].forEach((i) => g.addTx(fx(`tx_spender_${i}.json`)));
  g.addTx(fx('tx_coinbase.json'));
  g.addTx(fx('tx_opreturn.json'));
  g.refreshDerived();
  return g;
}

function allDistinct(pos, minDist) {
  const pts = [...pos.values()];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < minDist) return false;
  }
  return true;
}

test('every layout positions every visible vertex with finite numbers and no overlaps', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  ['flow', 'timeline', 'force'].forEach((name) => {
    const { pos } = L.layout(name, g, v);
    assert.equal(pos.size, v.nodes.size, name);
    pos.forEach((p, id) => { assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), `${name} ${id}`); });
    assert.ok(allDistinct(pos, 8), name + ' overlap');
  });
});

test('flow: money moves left to right on an acyclic graph', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t); g.addOutspends(t.txid, fx('outspends_normal.json')); g.addTx(fx('tx_coinbase.json')); g.addTx(fx('tx_opreturn.json'));
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutFlow(g, v);
  v.edges.forEach((id) => {
    const e = g.edges.get(id);
    assert.ok(pos.get(e.source).x < pos.get(e.target).x, `${e.source} -> ${e.target}`);
  });
});

test('flow: address reuse makes cycles; only the edges that close a cycle may point backwards', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const { pos } = L.layoutFlow(g, v);
  let back = 0;
  v.edges.forEach((id) => { const e = g.edges.get(id); if (pos.get(e.source).x >= pos.get(e.target).x) back++; });
  assert.ok(back / v.edges.size < 0.2, `${back} of ${v.edges.size} edges point backwards`);
});

test('flow: survives a cycle in imported data', () => {
  const g = new Graph();
  g.upsertNode({ id: 'a', type: 'addr' }); g.upsertNode({ id: 'b', type: 'tx', time: 1, confirmed: true });
  g.upsertEdge({ id: 'e1', source: 'a', target: 'b', kind: 'in', amount: 5 });
  g.upsertEdge({ id: 'e2', source: 'b', target: 'a', kind: 'out', amount: 5 });
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutFlow(g, v);
  assert.equal(pos.size, 2);
});

test('timeline: transaction x follows confirmation time', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const { pos, axis } = L.layoutTimeline(g, v, { width: 1000 });
  const txs = [...v.nodes].map((id) => g.node(id)).filter((n) => n.type === 'tx' && n.time != null);
  assert.ok(txs.length >= 3);
  txs.forEach((a) => txs.forEach((b) => {
    if (a.time < b.time) assert.ok(pos.get(a.id).x < pos.get(b.id).x);
    if (a.time === b.time) assert.equal(pos.get(a.id).x, pos.get(b.id).x);
  }));
  const xs = txs.map((n) => pos.get(n.id).x);
  assert.equal(Math.min(...xs), 0);
  assert.ok(Math.max(...xs) <= 1000 + 1e-9);
  assert.equal(axis.tMin, Math.min(...txs.map((n) => n.time)));
  assert.equal(axis.tMax, Math.max(...txs.map((n) => n.time)));
});

test('timeline: lanes never overlap horizontally', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const sep = 54;
  const { pos } = L.layoutTimeline(g, v, { minSep: sep });
  const byLane = new Map();
  pos.forEach((p) => { const k = p.y; if (!byLane.has(k)) byLane.set(k, []); byLane.get(k).push(p.x); });
  byLane.forEach((xs) => {
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= sep - 1e-9, `gap ${xs[i] - xs[i - 1]}`);
  });
});

test('timeline: pending transactions go after the last confirmed one, unknown stubs before their consumer', () => {
  const g = new Graph();
  const mk = (txid, time, ins, outs) => g.addTx({
    txid, fee: 1, weight: 400, status: time == null ? { confirmed: false } : { confirmed: true, block_height: 1, block_time: time },
    vin: ins.map(([ptxid, vout, addr, value]) => ({ txid: ptxid, vout, prevout: { scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value } })),
    vout: outs.map(([addr, value]) => ({ scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value }))
  });
  mk('t1', 1000, [['t0', 0, 'A', 500]], [['B', 400]]);
  mk('t2', 5000, [['t1', 0, 'B', 400]], [['C', 300]]);
  mk('t3', null, [['t2', 0, 'C', 300]], [['D', 200]]);
  const v = F.computeVisible(g, {});
  const { pos, axis } = L.layoutTimeline(g, v, { width: 800 });
  assert.ok(axis.hasPending);
  assert.ok(pos.get(ID.tx('t3')).x > pos.get(ID.tx('t2')).x, 'pending after latest');
  assert.ok(pos.get(ID.tx('t0')).x < pos.get(ID.tx('t1')).x, 'unloaded funding stub before the tx it funds');
  assert.ok(pos.get(ID.addr('B')).x > pos.get(ID.tx('t1')).x && pos.get(ID.addr('B')).x < pos.get(ID.tx('t2')).x, 'address sits between creator and spender');
  assert.ok(pos.get(ID.addr('D')).x > pos.get(ID.tx('t3')).x, 'unspent output after its tx');
});

test('timeline: a single time (everything in one block) spreads vertically instead of stacking', () => {
  const g = new Graph();
  g.addTx(fx('tx_coinbase.json'));
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutTimeline(g, v);
  assert.ok(allDistinct(pos, 8));
  const ys = new Set([...pos.values()].map((p) => p.y));
  assert.ok(ys.size > 1);
});

test('timeline and flow handle an empty selection', () => {
  const g = new Graph();
  const v = F.computeVisible(g, {});
  ['flow', 'timeline', 'force'].forEach((n) => assert.equal(L.layout(n, g, v).pos.size, 0));
  assert.equal(L.bounds(new Map()), null);
});

test('force: deterministic for a seed, and continues from a starting layout', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  const a = L.layoutForce(g, v, { seed: 7 }).pos, b = L.layoutForce(g, v, { seed: 7 }).pos;
  a.forEach((p, id) => { assert.equal(p.x, b.get(id).x); assert.equal(p.y, b.get(id).y); });
  const c = L.layoutForce(g, v, { seed: 99 }).pos;
  assert.ok([...a].some(([id, p]) => p.x !== c.get(id).x), 'different seed differs');
  // starting from a converged layout and running few iterations barely moves things
  const again = L.layoutForce(g, v, { start: a, iterations: 1 }).pos;
  let moved = 0; a.forEach((p, id) => { moved = Math.max(moved, Math.hypot(p.x - again.get(id).x, p.y - again.get(id).y)); });
  assert.ok(moved < 250, 'moved ' + moved);
});

test('force: connected vertices end up closer than unconnected ones on average', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t);
  g.addTx(fx('tx_coinbase.json'));        // a disconnected component
  const v = F.computeVisible(g, {});
  const { pos } = L.layoutForce(g, v, { seed: 3 });
  let linked = 0, nl = 0, free = 0, nf = 0;
  const pairs = new Set();
  v.edges.forEach((id) => { const e = g.edges.get(id); pairs.add(e.source + '|' + e.target); pairs.add(e.target + '|' + e.source); });
  const ids = [...pos.keys()];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const d = Math.hypot(pos.get(ids[i]).x - pos.get(ids[j]).x, pos.get(ids[i]).y - pos.get(ids[j]).y);
    if (pairs.has(ids[i] + '|' + ids[j])) { linked += d; nl++; } else { free += d; nf++; }
  }
  assert.ok(linked / nl < free / nf);
});

test('layout dispatcher defaults to flow', () => {
  const g = realGraph(), v = F.computeVisible(g, {});
  assert.equal(L.layout('nonsense', g, v).axis, null);
  assert.ok(L.layout('timeline', g, v).axis);
});

// ---- time scale ----
const DAYS = 86400;

test('timeMapper proportional is linear in time', () => {
  const m = L.timeMapper([0, 100, 1000], 'proportional', 1000, 40, 120);
  assert.equal(m.xOf(0), 0);
  assert.equal(m.xOf(100), 100);
  assert.equal(m.xOf(1000), 1000);
  assert.equal(m.breaks.length, 0);
});

test('timeMapper compact: one outlier years later cannot squash a burst, and the gap is reported', () => {
  const burst = [0, 60, 120, 600, 3600];                         // an hour of activity
  const times = burst.concat([5 * 365 * DAYS]);                  // ... and one transaction five years later
  const lin = L.timeMapper(times, 'proportional', 1600, 40, 160);
  const cmp = L.timeMapper(times, 'compact', 1600, 40, 160);
  assert.ok(lin.xOf(3600) < 1, 'proportional: the whole burst is under one pixel');
  // compact: neighbours stay readable
  const xs = burst.map((t) => cmp.xOf(t));
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 40 - 1e-9, `gap ${xs[i] - xs[i - 1]}`);
  assert.ok(cmp.x1 < 1700 && cmp.x1 > 200);
  // the five-year gap is capped and flagged, nothing else is
  assert.equal(cmp.breaks.length, 1);
  assert.ok(Math.abs((cmp.breaks[0].x1 - cmp.breaks[0].x0) - 160) < 1e-9);
  assert.equal(cmp.breaks[0].seconds, 5 * 365 * DAYS - 3600);
});

test('timeMapper compact is monotone and exact at the knots; a single time maps to 0', () => {
  const t = [10, 20, 500, 100000, 100001, 9e8];
  const m = L.timeMapper(t, 'compact', 1000, 30, 150);
  let prev = -1;
  t.forEach((x) => { const px = m.xOf(x); assert.ok(px >= prev); prev = px; });
  m.knots.forEach((k) => assert.equal(m.xOf(k.t), k.x));
  assert.equal(m.xOf(-5), 0);
  assert.equal(m.xOf(1e12), m.x1);
  assert.ok(m.xOf(15) > m.xOf(10) && m.xOf(15) < m.xOf(20), 'interpolates between knots');
  const one = L.timeMapper([5], 'compact', 1000, 30, 150);
  assert.equal(one.xOf(5), 0);
});

test('timeline compact layout keeps transactions in time order and exposes the axis mapper', () => {
  const g = new Graph();
  const mk = (txid, time, prev) => g.addTx({ txid, fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: time },
    vin: [{ txid: prev, vout: 0, prevout: { scriptpubkey_address: 'a' + prev, scriptpubkey_type: 'p2pkh', value: 9 } }],
    vout: [{ scriptpubkey_address: 'a' + txid, scriptpubkey_type: 'p2pkh', value: 8 }] });
  mk('t1', 1000, 't0'); mk('t2', 1060, 't1'); mk('t3', 1120, 't2'); mk('t4', 1000 + 4 * 365 * DAYS, 't3');
  const v = F.computeVisible(g, {});
  const { pos, axis } = L.layoutTimeline(g, v, { scale: 'compact', width: 1600 });
  const x = (id) => pos.get(ID.tx(id)).x;
  assert.ok(x('t1') < x('t2') && x('t2') < x('t3') && x('t3') < x('t4'));
  assert.ok(x('t2') - x('t1') >= 40 - 1e-9, 'burst stays readable');
  assert.equal(axis.mode, 'compact');
  assert.equal(axis.breaks.length, 1);
  assert.equal(axis.xOf(1060), x('t2'));
  const prop = L.layoutTimeline(g, v, { scale: 'proportional', width: 1600 });
  assert.ok(prop.pos.get(ID.tx('t3')).x - prop.pos.get(ID.tx('t1')).x < 3, 'proportional squashes the same burst');
  assert.equal(prop.axis.mode, 'proportional');
});
