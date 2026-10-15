'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID, decodeOpReturn } = require('../public/js/orion-model.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

test('normal tx: vertices, edges, times, amounts and script types are kept', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const tx = g.node(ID.tx(t.txid));
  assert.equal(tx.loaded, true);
  assert.equal(tx.confirmed, true);
  assert.equal(tx.time, t.status.block_time);
  assert.equal(tx.height, t.status.block_height);
  assert.equal(tx.nIn, t.vin.length);
  assert.equal(tx.nOut, t.vout.length);
  assert.equal(tx.valueOut, t.vout.reduce((s, o) => s + o.value, 0));
  assert.equal(tx.valueIn - tx.valueOut, t.fee);

  t.vout.forEach((o, n) => {
    const e = g.edges.get(ID.edgeOut(t.txid, n));
    assert.equal(e.amount, o.value);
    assert.equal(e.time, t.status.block_time);
    assert.equal(e.target, ID.addr(o.scriptpubkey_address));
    assert.equal(g.node(e.target).scriptType, o.scriptpubkey_type);
  });
  t.vin.forEach((v, i) => {
    const e = g.edges.get(ID.edgeIn(t.txid, i));
    assert.equal(e.amount, v.prevout.value);
    assert.equal(e.source, ID.addr(v.prevout.scriptpubkey_address));
    assert.equal(e.target, tx.id);
  });
});

test('funding transactions appear as unloaded stubs with the spent output as an edge', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const stub = g.node(ID.tx(t.vin[0].txid));
  assert.ok(stub, 'funding tx stub exists');
  assert.equal(stub.loaded, false);
  const fund = g.edges.get(ID.edgeOut(t.vin[0].txid, t.vin[0].vout));
  assert.equal(fund.source, stub.id);
  assert.equal(fund.amount, t.vin[0].prevout.value);
  assert.equal(fund.spent, true);
  assert.equal(fund.spentBy.txid, t.txid);
});

test('adding a funding tx later fills in the stub and does not duplicate edges', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const before = g.stats();
  // fabricate the funding tx minimally: same txid, one output matching the spent prevout
  const v = t.vin[0];
  const funding = {
    txid: v.txid, fee: 100, weight: 400, status: { confirmed: true, block_height: 1, block_time: 1000 },
    vin: [{ txid: 'ab'.repeat(32), vout: 0, is_coinbase: false, prevout: { scriptpubkey_address: 'x', scriptpubkey_type: 'p2pkh', value: v.prevout.value + 100 } }],
    vout: []
  };
  funding.vout[v.vout] = v.prevout;
  for (let i = 0; i < v.vout; i++) funding.vout[i] = { scriptpubkey_address: 'filler' + i, scriptpubkey_type: 'p2pkh', value: 1 };
  g.addTx(funding);
  const stub = g.node(ID.tx(v.txid));
  assert.equal(stub.loaded, true);
  assert.equal(stub.time, 1000);
  assert.equal(g.edges.get(ID.edgeOut(v.txid, v.vout)).amount, v.prevout.value);
  // the spent-output edge is the same edge, not a second one
  const outs = [...g.edges.values()].filter((e) => e.id === ID.edgeOut(v.txid, v.vout));
  assert.equal(outs.length, 1);
  assert.ok(g.stats().edges >= before.edges);
});

test('ingesting the same tx twice is idempotent', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const a = g.stats();
  g.addTx(t);
  assert.deepEqual(g.stats(), a);
  // adjacency sets must not grow either
  const tx = g.node(ID.tx(t.txid));
  assert.equal(g.edgesOf(tx.id).length, t.vin.length + t.vout.length);
});

test('coinbase tx does not crash: coinbase vertex, address-less outputs become data/nonstd vertices', () => {
  const t = fx('tx_coinbase.json');
  const g = new Graph();
  assert.doesNotThrow(() => g.addTx(t));
  const tx = g.node(ID.tx(t.txid));
  assert.equal(tx.coinbase, true);
  assert.equal(tx.valueIn, null);
  const cb = g.node(ID.coinbase(t.txid));
  assert.equal(cb.type, 'coinbase');
  const inEdge = g.edges.get(ID.edgeIn(t.txid, 0));
  assert.equal(inEdge.source, cb.id);
  assert.equal(inEdge.amount, tx.valueOut);
  // every output got a vertex of some kind: no vertex id is undefined / missing
  t.vout.forEach((o, n) => {
    const e = g.edges.get(ID.edgeOut(t.txid, n));
    assert.ok(g.node(e.target), 'target vertex exists for vout ' + n);
    if (!o.scriptpubkey_address) assert.notEqual(g.node(e.target).type, 'addr');
  });
});

test('OP_RETURN output becomes a data vertex carrying the payload', () => {
  const t = fx('tx_opreturn.json');
  const g = new Graph();
  assert.doesNotThrow(() => g.addTx(t));
  const n = t.vout.findIndex((o) => o.scriptpubkey_type === 'op_return');
  assert.ok(n >= 0);
  const d = g.node(ID.data(t.txid, n));
  assert.equal(d.type, 'data');
  assert.equal(typeof d.dataHex, 'string');
  const e = g.edges.get(ID.edgeOut(t.txid, n));
  assert.equal(e.target, d.id);
  g.nodes.forEach((node) => assert.equal(typeof node.id, 'string'));
});

test('outspends mark outputs spent, create spender stubs and carry the spender time', () => {
  const t = fx('tx_normal.json');
  const sp = fx('outspends_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, sp);
  sp.forEach((o, n) => {
    const e = g.edges.get(ID.edgeOut(t.txid, n));
    assert.equal(e.spent, !!o.spent);
    if (o.spent) {
      assert.equal(e.spentBy.txid, o.txid);
      const stub = g.node(ID.tx(o.txid));
      assert.ok(stub);
      assert.equal(stub.time, o.status.confirmed ? o.status.block_time : null);
      const inE = g.edges.get(ID.edgeIn(o.txid, o.vin));
      assert.equal(inE.source, e.target);
      assert.equal(inE.target, stub.id);
      assert.equal(inE.amount, e.amount);
    }
  });
});

test('spender transactions connect to the graph through the output they spend', () => {
  const t = fx('tx_normal.json');
  const sp = fx('outspends_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, sp);
  const before = g.stats().edges;
  const spender = fx('tx_spender_0.json');
  g.addTx(spender);
  assert.equal(g.node(ID.tx(spender.txid)).loaded, true);
  // the spender's own input edge for the spent output must be the one created from outspends
  const spentVin = spender.vin.findIndex((v) => v.txid === t.txid);
  assert.ok(spentVin >= 0);
  assert.ok(g.edges.has(ID.edgeIn(spender.txid, spentVin)));
  assert.ok(g.stats().edges > before);
});

test('removeNode drops the vertex, its edges and vertices left orphaned', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  const removed = g.removeNode(ID.tx(t.txid));
  assert.ok(removed.includes(ID.tx(t.txid)));
  assert.equal(g.nodes.size, 0);
  assert.equal(g.edges.size, 0);
});

test('refreshDerived computes first/last seen, received, sent and degree', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.refreshDerived();
  const a = g.node(ID.addr(t.vout[0].scriptpubkey_address));
  assert.equal(a.received, t.vout[0].value);
  assert.equal(a.firstSeen, t.status.block_time);
  assert.equal(a.degree, 1);
  const tx = g.node(ID.tx(t.txid));
  assert.equal(tx.degree, t.vin.length + t.vout.length);
});

test('timeBounds reports min/max of confirmed times and counts pending separately', () => {
  const g = new Graph();
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: 100, confirmed: true });
  g.upsertNode({ id: 'tx:b', type: 'tx', txid: 'b', time: 300, confirmed: true });
  g.upsertNode({ id: 'tx:c', type: 'tx', txid: 'c', time: null, confirmed: false });
  g.upsertNode({ id: 'tx:d', type: 'tx', txid: 'd', time: null, confirmed: null });
  assert.deepEqual(g.timeBounds(), { min: 100, max: 300, pending: 1, unknown: 1 });
});

test('toData/fromData round-trips', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, fx('outspends_normal.json'));
  const copy = Graph.fromData(JSON.parse(JSON.stringify(g.toData())));
  assert.deepEqual(copy.stats(), g.stats());
  assert.deepEqual(copy.toData(), g.toData());
});

test('null never overwrites known data on merge', () => {
  const g = new Graph();
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: 5, confirmed: true, loaded: true });
  g.upsertNode({ id: 'tx:a', type: 'tx', txid: 'a', time: null, confirmed: null, loaded: false });
  const n = g.node('tx:a');
  assert.equal(n.time, 5);
  assert.equal(n.confirmed, true);
  // `loaded: false` is a real value, but an unloaded stub must not demote a loaded tx
  assert.equal(n.loaded, true);
});

test('decodeOpReturn extracts printable text and raw hex', () => {
  // 6a 0b "hello world"
  const hex = '6a0b' + Buffer.from('hello world').toString('hex');
  const d = decodeOpReturn(hex);
  assert.equal(d.text, 'hello world');
  assert.equal(d.hex, Buffer.from('hello world').toString('hex'));
  // binary payload yields hex but no text
  const bin = decodeOpReturn('6a20' + '00'.repeat(16) + 'ff'.repeat(16));
  assert.equal(bin.text, '');
  assert.equal(bin.hex.length, 64);
  // PUSHDATA1
  const long = 'a'.repeat(80);
  const p1 = decodeOpReturn('6a4c50' + Buffer.from(long).toString('hex'));
  assert.equal(p1.text.length, 80);
  // empty / malformed never throws
  assert.deepEqual(decodeOpReturn('6a'), { hex: '', text: '' });
  assert.doesNotThrow(() => decodeOpReturn('6a4d'));
  assert.doesNotThrow(() => decodeOpReturn(undefined));
});

test('removeNode also drops spender stubs that only hung off the removed transaction', () => {
  const t = fx('tx_normal.json');
  const g = new Graph();
  g.addTx(t);
  g.addOutspends(t.txid, fx('outspends_normal.json'));
  assert.ok(g.nodes.size > 5);
  g.removeNode(ID.tx(t.txid));
  assert.equal(g.nodes.size, 0);
  assert.equal(g.edges.size, 0);
});

test('removeNode keeps a stub that is still connected to something else', () => {
  const t = fx('tx_normal.json'), sp = fx('outspends_normal.json'), other = fx('tx_spender_0.json');
  const g = new Graph();
  g.addTx(t); g.addOutspends(t.txid, sp); g.addTx(other);          // `other` is loaded and spends one of t's outputs
  g.removeNode(ID.tx(t.txid));
  assert.ok(g.node(ID.tx(other.txid)), 'the loaded spender stays');
  assert.equal(g.node(ID.tx(other.txid)).loaded, true);
});
