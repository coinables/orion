'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Graph, ID } = require('../public/js/orion-model.js');
const Steps = require('../public/js/orion-steps.js');
const S = require('../public/js/orion-style.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

// A pays t1 -> (B 600, C 300); B is spent in t2 -> D; C is unspent.
function chain() {
  const g = new Graph();
  const tx = (txid, time, ins, outs) => ({ txid, fee: 100, weight: 400, status: { confirmed: true, block_height: 1, block_time: time },
    vin: ins.map(([ptxid, vout, addr, value]) => ({ txid: ptxid, vout, prevout: { scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value } })),
    vout: outs.map(([addr, value]) => ({ scriptpubkey_address: addr, scriptpubkey_type: 'p2pkh', value })) });
  g.addTx(tx('t1', 1000, [['t0', 0, 'A', 1000]], [['B', 600], ['C', 300]]));
  g.addTx(tx('t2', 2000, [['t1', 0, 'B', 600]], [['D', 500]]));
  g.addOutspends('t1', [{ spent: true, txid: 't2', vin: 0, status: { confirmed: true, block_time: 2000 } }, { spent: false }]);
  g.addOutspends('t2', [{ spent: false }]);
  return g;
}
const ids = (rows) => rows.map((r) => r.id);

test('transaction: next are the wallets it paid (with spent / unspent), previous the wallets that paid in', () => {
  const g = chain();
  const next = Steps.neighbours(g, ID.tx('t1'), 'next');
  assert.deepEqual(ids(next), [ID.addr('B'), ID.addr('C')], 'largest amount first');
  assert.equal(next[0].amount, 600); assert.equal(next[0].spent, true); assert.equal(next[0].spender, 't2');
  assert.equal(next[1].spent, false);
  assert.ok(next.every((r) => r.navigable && r.type === 'addr' && r.time === 1000));
  const prev = Steps.neighbours(g, ID.tx('t1'), 'prev');
  assert.deepEqual(ids(prev), [ID.addr('A')]);
  assert.equal(prev[0].amount, 1000);
});

test('wallet: previous are the transactions that paid it, next the ones that spent from it, plus unspent coins as information', () => {
  const g = chain();
  assert.deepEqual(ids(Steps.neighbours(g, ID.addr('B'), 'prev')), [ID.tx('t1')]);
  assert.deepEqual(ids(Steps.neighbours(g, ID.addr('B'), 'next')), [ID.tx('t2')]);
  const c = Steps.neighbours(g, ID.addr('C'), 'next');
  assert.equal(c.length, 1);
  assert.equal(c[0].navigable, false); assert.equal(c[0].type, 'unspent'); assert.equal(c[0].amount, 300);
  assert.deepEqual(Steps.counts(g, ID.addr('C')), { prev: 1, next: 0, prevInfo: 1, nextInfo: 1 });
  assert.match(Steps.emptyReason(g, ID.addr('C'), 'next'), /Unspent/);
});

test('transactions-only mode steps straight to the neighbouring transactions and names the wallet between', () => {
  const g = chain();
  const opts = { viaWallets: false };
  const next = Steps.neighbours(g, ID.tx('t1'), 'next', opts);
  assert.equal(next[0].id, ID.tx('t2')); assert.equal(next[0].via, ID.addr('B')); assert.equal(next[0].amount, 600);
  assert.equal(next[1].navigable, false); assert.equal(next[1].type, 'unspent'); assert.equal(next[1].via, ID.addr('C'));
  const prev = Steps.neighbours(g, ID.tx('t2'), 'prev', opts);
  assert.deepEqual(ids(prev), [ID.tx('t1')]);
  assert.equal(prev[0].via, ID.addr('B'));
  assert.deepEqual(Steps.counts(g, ID.tx('t1'), opts), { prev: 1, next: 1, prevInfo: 1, nextInfo: 2 });
});

test('several outputs spent by one transaction merge into one step; amounts add up', () => {
  const g = new Graph();
  g.addTx({ txid: 'a', fee: 1, weight: 400, status: { confirmed: true, block_time: 10 }, vin: [{ txid: 'z', vout: 0, prevout: { scriptpubkey_address: 'S', scriptpubkey_type: 'p2pkh', value: 9 } }],
            vout: [{ scriptpubkey_address: 'X', scriptpubkey_type: 'p2pkh', value: 4 }, { scriptpubkey_address: 'Y', scriptpubkey_type: 'p2pkh', value: 3 }] });
  g.addOutspends('a', [{ spent: true, txid: 'b', vin: 0, status: { confirmed: true, block_time: 20 } }, { spent: true, txid: 'b', vin: 1, status: { confirmed: true, block_time: 20 } }]);
  const r = Steps.neighbours(g, ID.tx('a'), 'next', { viaWallets: false });
  assert.equal(r.length, 1);
  assert.equal(r[0].id, ID.tx('b')); assert.equal(r[0].amount, 7); assert.equal(r[0].count, 2);
});

test('coinbase and OP_RETURN are shown as information, never as somewhere to go', () => {
  const g = new Graph();
  g.addTx(fx('tx_coinbase.json'));
  const t = fx('tx_coinbase.json');
  const prev = Steps.neighbours(g, ID.tx(t.txid), 'prev');
  assert.equal(prev.length, 1);
  assert.equal(prev[0].type, 'coinbase'); assert.equal(prev[0].navigable, false); assert.match(prev[0].note, /newly created/);
  assert.match(Steps.emptyReason(g, ID.tx(t.txid), 'prev'), /Coinbase/);
  const next = Steps.neighbours(g, ID.tx(t.txid), 'next');
  assert.ok(next.some((r) => r.type === 'data' && !r.navigable && r.note === 'OP_RETURN'));
  assert.ok(next.every((r) => r.navigable === (r.type === 'addr')));
  assert.ok(next.findIndex((r) => !r.navigable) > next.findLastIndex((r) => r.navigable), 'moveable rows come first');
});

test('real fixtures: every moveable row points at a vertex that exists, in both modes', () => {
  const g = new Graph();
  const t = fx('tx_normal.json');
  g.addTx(t); g.addOutspends(t.txid, fx('outspends_normal.json')); g.addTx(fx('tx_spender_0.json')); g.addTx(fx('tx_opreturn.json'));
  g.nodes.forEach((n) => ['prev', 'next'].forEach((dir) => [true, false].forEach((via) => {
    Steps.neighbours(g, n.id, dir, { viaWallets: via }).forEach((r) => { if (r.navigable) assert.ok(g.nodes.has(r.id), `${n.id} ${dir} -> ${r.id}`); });
  })));
});

test('unknown vertex or direction gives no rows; empty reasons name the cause', () => {
  const g = chain();
  assert.deepEqual(Steps.neighbours(g, 'nope', 'next'), []);
  assert.deepEqual(Steps.neighbours(g, ID.tx('t1'), 'sideways'), []);
  assert.match(Steps.emptyReason(g, ID.tx('t0'), 'next'), /Not loaded/);
  g.upsertNode({ id: ID.addr('Q'), type: 'addr', address: 'Q' });
  assert.match(Steps.emptyReason(g, ID.addr('Q'), 'next'), /History of this wallet is not loaded/);
  assert.equal(Steps.emptyReason(g, 'nope', 'next'), 'Nothing selected');
});

test('fmtBtcShort keeps amounts short on the canvas', () => {
  assert.equal(S.fmtBtcShort(0), '0 sat');
  assert.equal(S.fmtBtcShort(546), '546 sat');
  assert.equal(S.fmtBtcShort(9999), '9,999 sat');
  assert.equal(S.fmtBtcShort(10000), '0.0001 BTC');
  assert.equal(S.fmtBtcShort(10470), '0.0001047 BTC');
  assert.equal(S.fmtBtcShort(2115000), '0.02115 BTC');
  assert.equal(S.fmtBtcShort(100000000), '1 BTC');
  assert.equal(S.fmtBtcShort(123456789), '1.23456789 BTC');
  assert.equal(S.fmtBtcShort(null), '?');
});

test('a transaction that is not loaded yet is timed by when its output was spent, unconfirmed ones stay untimed', () => {
  const g = chain();
  // t0 funded A and is a stub: its edge has no time, but t1 (time 1000) spent that output
  const prev = Steps.neighbours(g, ID.addr('A'), 'prev');
  assert.equal(prev.length, 1);
  assert.equal(prev[0].id, ID.tx('t0'));
  assert.equal(prev[0].time, 1000, 'priced at the moment it was spent');
  g.addTx({ txid: 'u1', fee: 1, weight: 400, status: { confirmed: false }, vin: [{ txid: 'u0', vout: 0, prevout: { scriptpubkey_address: 'U', scriptpubkey_type: 'p2pkh', value: 5 } }],
            vout: [{ scriptpubkey_address: 'V', scriptpubkey_type: 'p2pkh', value: 4 }] });
  assert.equal(Steps.neighbours(g, ID.tx('u1'), 'next')[0].time, null, 'unconfirmed: no time');
});
