'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/orion-model.js');
const F = require('../public/js/orion-filter.js');
const Nav = require('../public/js/orion-nav.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

// A -> t1 -> B -> t2 -> C -> t3 -> D   (a payment chain)
function chain() {
  const g = new Graph();
  const mk = (txid, time, prev, from, to) => g.addTx({
    txid, fee: 1, weight: 400, status: { confirmed: true, block_height: 1, block_time: time },
    vin: [{ txid: prev, vout: 0, prevout: { scriptpubkey_address: from, scriptpubkey_type: 'p2pkh', value: 1000 } }],
    vout: [{ scriptpubkey_address: to, scriptpubkey_type: 'p2pkh', value: 900 }]
  });
  mk('t1', 100, 't0', 'A', 'B'); mk('t2', 200, 't1', 'B', 'C'); mk('t3', 300, 't2', 'C', 'D');
  return g;
}
const ids = (set) => [...set].sort();

// ---- focus ----
test('focus: hops limit the neighbourhood along edges', () => {
  const g = chain();
  const f = (hops, id) => F.computeVisible(g, {}, null, { id, hops });
  assert.deepEqual(ids(f(1, ID.tx('t2')).nodes), [ID.addr('B'), ID.addr('C'), ID.tx('t2')].sort());
  const two = f(2, ID.tx('t2'));
  assert.ok(two.nodes.has(ID.tx('t1')) && two.nodes.has(ID.tx('t3')), 'two hops reach the neighbouring transactions');
  assert.ok(!two.nodes.has(ID.addr('A')) && !two.nodes.has(ID.addr('D')));
  const three = f(3, ID.tx('t2'));
  assert.ok(three.nodes.has(ID.addr('A')) && three.nodes.has(ID.addr('D')));
  assert.equal(f(0, ID.tx('t2')).nodes.size, 1);
});

test('focus: edges are those among the included vertices, and visible counts shrink', () => {
  const g = chain();
  const all = F.computeVisible(g, {});
  const v = F.computeVisible(g, {}, null, { id: ID.addr('B'), hops: 1 });
  assert.deepEqual(ids(v.nodes), [ID.addr('B'), ID.tx('t1'), ID.tx('t2')].sort());
  v.edges.forEach((eid) => { const e = g.edges.get(eid); assert.ok(v.nodes.has(e.source) && v.nodes.has(e.target)); });
  assert.ok(v.edges.size < all.edges.size);
  assert.equal(v.hiddenNodes, g.nodes.size - v.nodes.size);
});

test('focus works from an address and from a stub transaction', () => {
  const g = chain();
  assert.ok(F.computeVisible(g, {}, null, { id: ID.tx('t0'), hops: 2 }).nodes.has(ID.tx('t1')), 'the unloaded funding stub t0 reaches t1 through A');
});

test('focus cannot walk through an edge another filter hides', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t);
  const small = Math.min(...t.vout.map((o) => o.value));
  const through = F.computeVisible(g, {}, null, { id: ID.tx(t.txid), hops: 1 });
  const filtered = F.computeVisible(g, { minAmount: small + 1 }, null, { id: ID.tx(t.txid), hops: 1 });
  assert.ok(filtered.nodes.size < through.nodes.size, 'the small output and its address drop out');
});

test('focus vertex that is not visible leaves the set unchanged; keep makes it visible', () => {
  const g = chain();
  const v = F.computeVisible(g, { hiddenScriptTypes: ['p2pkh'] }, null, { id: ID.addr('B'), hops: 1 });
  assert.equal(v.nodes.size, 0, 'everything is hidden by the script filter');
  const kept = F.computeVisible(g, { hiddenScriptTypes: ['p2pkh'] }, new Set([ID.tx('t2')]), { id: ID.tx('t2'), hops: 1 });
  assert.deepEqual([...kept.nodes], [ID.tx('t2')]);
  assert.equal(F.computeVisible(g, {}, null, { id: 'nope', hops: 1 }).nodes.size, g.nodes.size, 'unknown focus id: nothing is narrowed');
});

test('focus on real fixtures never throws, including coinbase and OP_RETURN', () => {
  const g = new Graph();
  [fx('tx_coinbase.json'), fx('tx_opreturn.json'), fx('tx_normal.json')].forEach((t) => g.addTx(t));
  g.nodes.forEach((n) => { for (const hops of [0, 1, 2, 3]) F.computeVisible(g, {}, null, { id: n.id, hops }); });
});

test('timeBounds and amountRange can be limited to a set', () => {
  const g = chain();
  const only = F.computeVisible(g, {}, null, { id: ID.tx('t2'), hops: 1 });
  assert.deepEqual(g.timeBounds(only.nodes), { min: 200, max: 200, pending: 0, unknown: 0 });
  assert.equal(g.timeBounds().min, 100);
  assert.ok(F.amountRange(g, only.edges).max <= F.amountRange(g).max);
});

// ---- nav ----
test('Nav: visit, back, forward and the forward list being dropped by a new visit', () => {
  const n = new Nav();
  assert.equal(n.current(), null);
  assert.ok(!n.canBack() && !n.canForward());
  n.visit('tx:a'); n.visit('addr:b'); n.visit('tx:c');
  assert.deepEqual(n.entries, ['tx:a', 'addr:b', 'tx:c']);
  assert.ok(n.canBack() && !n.canForward());
  assert.equal(n.goto(1), 'addr:b');
  assert.ok(n.canBack() && n.canForward());
  assert.equal(n.goto(0), 'tx:a');
  assert.ok(!n.canBack());
  n.goto(1);
  assert.equal(n.visit('tx:d'), true);
  assert.deepEqual(n.entries, ['tx:a', 'addr:b', 'tx:d'], 'tx:c (forward) is gone');
  assert.ok(!n.canForward());
});

test('Nav: visiting the current place again changes nothing; out-of-range goto is refused', () => {
  const n = new Nav();
  n.visit('tx:a');
  assert.equal(n.visit('tx:a'), false);
  assert.equal(n.entries.length, 1);
  assert.equal(n.goto(5), null); assert.equal(n.goto(-1), null);
  assert.equal(n.index, 0);
  n.reset();
  assert.equal(n.current(), null);
});

test('Nav: A -> B -> A is three entries (revisiting is not merging)', () => {
  const n = new Nav();
  n.visit('tx:a'); n.visit('tx:b'); n.visit('tx:a');
  assert.equal(n.entries.length, 3);
});

test('Nav hash codec round-trips and refuses malformed or hostile input', () => {
  const t = 'tx:' + '0f58c9a7'.repeat(8);
  assert.equal(Nav.toHash(3, t), '#f3/' + t);
  assert.deepEqual(Nav.parseHash(Nav.toHash(3, t)), { index: 3, id: t });
  assert.deepEqual(Nav.parseHash('#f0/addr:bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq').index, 0);
  assert.deepEqual(Nav.parseHash('#f1/data:' + 'a'.repeat(64) + ':2').id, 'data:' + 'a'.repeat(64) + ':2');
  ['', '#', '#f/tx:a', '#fx/tx:a', '#f1/', '#f1/javascript:alert(1)', '#f1/tx:<img src=x>', '#f1/tx:a b', '#f1/tx:' + 'a'.repeat(300), null, undefined, '#f9999999/tx:a']
    .forEach((bad) => assert.equal(Nav.parseHash(bad), null, String(bad)));
  assert.ok(Nav.isId('tx:abc') && !Nav.isId('abc') && !Nav.isId('tx:'));
});
