'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/orion-model.js');
const F = require('../public/js/orion-filter.js');
const S = require('../public/js/orion-style.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

// A small hand-built chain:  A --t1--> B --t2--> C, plus dust and an OP_RETURN, plus a pending tx.
function chain() {
  const g = new Graph();
  const mk = (txid, time, confirmed, ins, outs) => g.addTx({
    txid, fee: 10, weight: 800, status: confirmed ? { confirmed: true, block_height: 1, block_time: time } : { confirmed: false },
    vin: ins.map(([ptxid, vout, addr, value, type]) => ({ txid: ptxid, vout, is_coinbase: false, prevout: { scriptpubkey_address: addr, scriptpubkey_type: type || 'v0_p2wpkh', value } })),
    vout: outs.map(([addr, value, type]) => addr ? { scriptpubkey_address: addr, scriptpubkey_type: type || 'v0_p2wpkh', value }
                                                 : { scriptpubkey_type: 'op_return', scriptpubkey: '6a04' + '41424344', value }),
  });
  mk('t1', 1000, true, [['t0', 0, 'A', 100000]], [['B', 99000], ['dust1', 546], [null, 0]]);
  mk('t2', 2000, true, [['t1', 0, 'B', 99000]], [['C', 98000, 'p2pkh']]);
  mk('t3', null, false, [['t2', 0, 'C', 98000, 'p2pkh']], [['D', 97000]]);
  return g;
}

test('no filter shows everything', () => {
  const g = chain();
  const v = F.computeVisible(g, {});
  assert.equal(v.nodes.size, g.nodes.size);
  assert.equal(v.edges.size, g.edges.size);
  assert.equal(v.hiddenNodes, 0);
});

test('time range hides transactions outside it and the addresses only they touch', () => {
  const g = chain();
  const v = F.computeVisible(g, { timeFrom: 1500, timeTo: 2500, includePending: false });
  assert.ok(v.nodes.has(ID.tx('t2')));
  assert.ok(!v.nodes.has(ID.tx('t1')));
  assert.ok(!v.nodes.has(ID.tx('t3')), 'pending tx hidden when includePending is false');
  assert.ok(v.nodes.has(ID.addr('B')) && v.nodes.has(ID.addr('C')));
  assert.ok(!v.nodes.has(ID.addr('A')), 'A only touches t1');
  assert.ok(!v.nodes.has(ID.addr('D')));
});

test('pending transactions follow includePending', () => {
  const g = chain();
  assert.ok(F.computeVisible(g, { timeFrom: 0, timeTo: 5000, includePending: true }).nodes.has(ID.tx('t3')));
  assert.ok(!F.computeVisible(g, { timeFrom: 0, timeTo: 5000, includePending: false }).nodes.has(ID.tx('t3')));
});

test('unknown-time stubs follow includeUnknownTime and are not treated as pending', () => {
  const g = chain();
  g.addOutspends('t2', [{ spent: true, txid: 'tX', vin: 0, status: { confirmed: true, block_height: 5, block_time: 3000 } }]);
  g.upsertNode({ id: ID.tx('t0'), type: 'tx', txid: 't0', loaded: false, confirmed: null, time: null });
  assert.equal(g.node(ID.tx('t0')).confirmed, null);
  const hidden = F.computeVisible(g, { includeUnknownTime: false });
  const shown = F.computeVisible(g, { includeUnknownTime: true });
  assert.ok(shown.nodes.has(ID.tx('t0')));
  assert.ok(!hidden.nodes.has(ID.tx('t0')));
});

test('an edge is placed at its transaction time, including the funding edges of an unloaded stub', () => {
  const g = chain();
  const fund = g.edges.get(ID.edgeOut('t0', 0));            // belongs to unloaded stub t0, spent by t1
  assert.equal(fund.time, null);
  // t0 has no time, so it follows the unknown-time rule rather than t1's time
  assert.equal(F.edgeTime(g, fund), null);
  const t1in = g.edges.get(ID.edgeIn('t1', 0));
  assert.equal(F.edgeTime(g, t1in), 1000);
});

test('amount filter hides dust edges and vertices left with nothing', () => {
  const g = chain();
  const v = F.computeVisible(g, { minAmount: 1000 });
  assert.ok(!v.nodes.has(ID.addr('dust1')));
  assert.ok(!v.edges.has(ID.edgeOut('t1', 1)));
  assert.ok(v.nodes.has(ID.addr('B')));
  const upper = F.computeVisible(g, { maxAmount: 98500 });
  assert.ok(!upper.edges.has(ID.edgeOut('t1', 0)));
});

test('keep ids stay visible even when every edge is filtered out', () => {
  const g = chain();
  const v = F.computeVisible(g, { minAmount: 10 ** 9 }, new Set([ID.tx('t2')]));
  assert.deepEqual([...v.nodes], [ID.tx('t2')]);
  assert.equal(v.edges.size, 0);
});

test('script-type filter hides addresses of that type and their edges', () => {
  const g = chain();
  const v = F.computeVisible(g, { hiddenScriptTypes: ['p2pkh'] });
  assert.ok(!v.nodes.has(ID.addr('C')));
  assert.ok(!v.edges.has(ID.edgeOut('t2', 0)));
  assert.ok(v.nodes.has(ID.addr('B')));
});

test('OP_RETURN vertices can be hidden', () => {
  const g = chain();
  assert.ok(F.computeVisible(g, {}).nodes.has(ID.data('t1', 2)));
  assert.ok(!F.computeVisible(g, { showData: false }).nodes.has(ID.data('t1', 2)));
});

test('works on real fixtures: coinbase + OP_RETURN do not throw and are filterable', () => {
  const g = new Graph();
  g.addTx(fx('tx_coinbase.json'));
  g.addTx(fx('tx_opreturn.json'));
  g.refreshDerived();
  const all = F.computeVisible(g, {});
  assert.equal(all.nodes.size, g.nodes.size);
  const noData = F.computeVisible(g, { showData: false, showNonstd: false });
  assert.ok(noData.nodes.size < all.nodes.size);
  assert.ok(F.amountRange(g).max > 0);
  assert.ok(Object.keys(F.scriptTypeCounts(g)).length >= 1);
});

// ---- style ----
test('edge width grows with amount on a log scale, within bounds', () => {
  const g = chain();
  const v = F.computeVisible(g, {});
  const st = S.makeStyle(g, v, { minWidth: 1, maxWidth: 12 });
  const big = g.edges.get(ID.edgeOut('t1', 0)), small = g.edges.get(ID.edgeOut('t1', 1));
  assert.ok(st.edgeWidth(big) > st.edgeWidth(small));
  g.edges.forEach((e) => { const w = st.edgeWidth(e); assert.ok(w >= 1 && w <= 12, 'width ' + w); });
  // not random: same input, same output
  assert.equal(st.edgeWidth(big), st.edgeWidth(big));
});

test('constant data maps to the middle of the range rather than NaN', () => {
  assert.equal(S.logScale(5, 5)(5), 0.5);
  assert.equal(S.linScale(7, 7)(7), 0.5);
  const g = new Graph();
  g.addTx(fx('tx_normal.json'));
  const st = S.makeStyle(g, F.computeVisible(g, { minAmount: 0 }), { colorBy: 'age' });
  g.nodes.forEach((n) => assert.ok(/^(rgb\(|#)/.test(st.nodeColor(n)), 'colour ' + st.nodeColor(n)));
});

test('age colouring: older and newer differ, unknown is grey', () => {
  const g = chain();
  g.refreshDerived();
  const st = S.makeStyle(g, F.computeVisible(g, {}), { colorBy: 'age' });
  const old = st.nodeColor(g.node(ID.tx('t1'))), nw = st.nodeColor(g.node(ID.tx('t2')));
  assert.notEqual(old, nw);
  assert.equal(st.nodeColor(g.node(ID.tx('t3'))), '#6b7280');
  assert.equal(S.ageColor(0), 'rgb(150,110,255)');
  assert.equal(S.ageColor(1), 'rgb(255,225,80)');
  // every colour on the scale is light enough to see on the dark background (#1c141d)
  for (let i = 0; i <= 20; i++) {
    const [r, g, b] = S.ageColor(i / 20).match(/\d+/g).map(Number);
    assert.ok(0.2126 * r + 0.7152 * g + 0.0722 * b > 90, 'too dark at ' + i / 20);
  }
  assert.equal(S.ageColor(null), '#6b7280');
  assert.equal(S.ageColor(5), S.ageColor(1), 'clamped');
});

test('script colouring distinguishes script types', () => {
  const g = chain();
  const st = S.makeStyle(g, F.computeVisible(g, {}), { colorBy: 'script' });
  assert.notEqual(st.nodeColor(g.node(ID.addr('B'))), st.nodeColor(g.node(ID.addr('C'))));   // v0_p2wpkh vs p2pkh
  assert.equal(st.nodeColor(g.node(ID.addr('B'))), S.SCRIPT_COLORS.v0_p2wpkh);
});

test('formatting: BTC without float error, UTC times, shortened ids', () => {
  assert.equal(S.fmtBtc(0), '0.00000000');
  assert.equal(S.fmtBtc(1), '0.00000001');
  assert.equal(S.fmtBtc(2100000000000000), '21000000.00000000');
  assert.equal(S.fmtBtc(123456789), '1.23456789');
  assert.equal(S.fmtBtc(null), '?');
  assert.equal(S.fmtTime(0), '1970-01-01 00:00 UTC');
  assert.equal(S.fmtTime(1649176756, false), '2022-04-05');
  assert.equal(S.fmtTime(null), '—');
  assert.equal(S.shortId('abcdefghijklmnopqrstuvwxyz', 4), 'abcd…wxyz');
  assert.equal(S.shortId('abc', 4), 'abc');
});

test('a vertex\'s own colour wins in every colour mode, and a bad colour is ignored', () => {
  const g = chain();
  g.refreshDerived();
  const v = F.computeVisible(g, {});
  ['type', 'age', 'script'].forEach((mode) => {
    const st = S.makeStyle(g, v, { colorBy: mode });
    const n = g.node(ID.addr('B'));
    const before = st.nodeColor(n);
    n.color = '#ff4d4d';
    assert.equal(st.nodeColor(n), '#ff4d4d', mode);
    n.color = 'url(javascript:1)';
    assert.equal(st.nodeColor(n), before, 'invalid colours are not used (' + mode + ')');
    delete n.color;
  });
});
