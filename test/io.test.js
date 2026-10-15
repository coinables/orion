'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Graph, ID } = require('../public/js/orion-model.js');
const F = require('../public/js/orion-filter.js');
const IO = require('../public/js/orion-io.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

function sample() {
  const g = new Graph(), t = fx('tx_normal.json');
  g.addTx(t); g.addOutspends(t.txid, fx('outspends_normal.json')); g.addTx(fx('tx_coinbase.json')); g.addTx(fx('tx_opreturn.json'));
  g.annotate(ID.addr(t.vout[0].scriptpubkey_address), 'Suspect, "wallet" #1', 'line one\nline two, with comma');
  g.refreshDerived();
  return { g, t };
}

// minimal RFC 4180 parser for the round-trip checks
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

test('JSON round-trip keeps graph, labels, notes and view', () => {
  const { g, t } = sample();
  const text = IO.toJson(g, { view: { layout: 'timeline', colorBy: 'age' }, now: 0, source: 'https://mempool.space/api' });
  const back = IO.fromJson(text);
  // null fields are "unknown" and are not stored on import; everything else must survive
  const nonNull = (d) => JSON.parse(JSON.stringify(d, (k, v) => (v === null ? undefined : v)));
  assert.deepEqual(nonNull(back.graph.toData()), nonNull(g.toData()));
  const a = back.graph.node(ID.addr(t.vout[0].scriptpubkey_address));
  assert.equal(a.label, 'Suspect, "wallet" #1');
  assert.equal(a.note, 'line one\nline two, with comma');
  assert.deepEqual(back.view, { layout: 'timeline', colorBy: 'age' });
  assert.equal(JSON.parse(text).exported, '1970-01-01T00:00:00.000Z');
});

test('JSON export can be limited to what is visible', () => {
  const { g } = sample();
  const v = F.computeVisible(g, { showData: false, showNonstd: false });
  const back = IO.fromJson(IO.toJson(g, { only: v }));
  assert.equal(back.graph.nodes.size, v.nodes.size);
  assert.equal(back.graph.edges.size, v.edges.size);
  assert.ok(back.graph.nodes.size < g.nodes.size);
});

test('JSON import rejects things that are not workspaces, with a readable message', () => {
  assert.throws(() => IO.fromJson('not json'), /Not a JSON file/);
  assert.throws(() => IO.fromJson('{"a":1}'), /Not an Orion workspace/);
  assert.throws(() => IO.fromJson('null'), /Not an Orion workspace/);
  assert.throws(() => IO.fromJson(JSON.stringify({ format: 'orion-workspace', version: 99, nodes: [], edges: [] })), /newer Orion/);
  assert.throws(() => IO.fromJson(JSON.stringify({ format: 'orion-workspace', version: 1 })), /no nodes/);
});

test('JSON import skips invalid nodes/edges and reports them', () => {
  const doc = { format: 'orion-workspace', version: 1,
    nodes: [{ id: 'a', type: 'addr' }, { id: 'b', type: 'tx' }, { id: 'c', type: 'bogus' }, { type: 'tx' }, null],
    edges: [{ id: 'e1', source: 'a', target: 'b', kind: 'in', amount: 5 }, { id: 'e2', source: 'a', target: 'zzz', kind: 'in', amount: 5 },
            { id: 'e3', source: 'a', target: 'b', kind: 'sideways', amount: 1 }, { id: 'e4', source: 'a', target: 'b', kind: 'in', amount: 'lots' }] };
  const r = IO.fromJson(JSON.stringify(doc));
  assert.equal(r.graph.nodes.size, 2);
  assert.equal(r.graph.edges.size, 1);
  assert.equal(r.warnings.length, 2);
});

test('JSON import ignores prototype-polluting keys and does not pollute Object', () => {
  const evil = '{"format":"orion-workspace","version":1,"nodes":[{"id":"a","type":"addr","__proto__":{"polluted":true},"constructor":{"x":1}}],"edges":[],"view":{"__proto__":{"polluted2":true}}}';
  const r = IO.fromJson(evil);
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  assert.equal(r.graph.node('a').polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(r.graph.node('a'), 'constructor'), false);
});

test('JSON import refuses oversized files', () => {
  const big = { format: 'orion-workspace', version: 1, nodes: new Array(200001).fill({ id: 'x', type: 'tx' }), edges: [] };
  assert.throws(() => IO.fromJson(JSON.stringify(big)), /too large/);
});

test('CSV: edges and nodes have one row per item plus a header, and quoting survives a parse', () => {
  const { g, t } = sample();
  const edges = parseCsv(IO.toCsv(g, 'edges')), nodes = parseCsv(IO.toCsv(g, 'nodes'));
  assert.equal(edges.length, g.edges.size + 1);
  assert.equal(nodes.length, g.nodes.size + 1);
  assert.deepEqual(edges[0], IO.EDGE_COLS);
  assert.deepEqual(nodes[0], IO.NODE_COLS);
  edges.slice(1).forEach((r) => assert.equal(r.length, IO.EDGE_COLS.length));
  nodes.slice(1).forEach((r) => assert.equal(r.length, IO.NODE_COLS.length));
  const col = (rows, name) => rows[0].indexOf(name);
  const labelled = nodes.find((r) => r[col(nodes, 'id')] === ID.addr(t.vout[0].scriptpubkey_address));
  assert.equal(labelled[col(nodes, 'label')], 'Suspect, "wallet" #1');
  assert.equal(labelled[col(nodes, 'note')], 'line one\nline two, with comma');
  const e = edges.find((r) => r[col(edges, 'edge_id')] === ID.edgeOut(t.txid, 0));
  assert.equal(e[col(edges, 'amount_sat')], String(t.vout[0].value));
  assert.equal(e[col(edges, 'time_utc')], '2022-04-05 16:39 UTC');
  assert.equal(e[col(edges, 'target_label')], 'Suspect, "wallet" #1');
});

test('CSV: cells that would run as spreadsheet formulas are defused', () => {
  const g = new Graph();
  g.upsertNode({ id: 'addr:x', type: 'addr', address: 'x' });
  ['=HYPERLINK("http://evil","click")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1'].forEach((evil, i) => {
    g.upsertNode({ id: 'addr:' + i, type: 'addr', address: String(i), label: evil, note: evil });
  });
  const rows = parseCsv(IO.toCsv(g, 'nodes'));
  const li = rows[0].indexOf('label');
  rows.slice(1).forEach((r) => { if (r[li]) assert.ok(r[li].startsWith("'"), 'not defused: ' + JSON.stringify(r[li])); });
  assert.equal(IO.defuse('plain'), 'plain');
  assert.equal(IO.defuse('=1'), "'=1");
});

test('CSV: numbers are written as plain numbers and not defused (amounts are never negative)', () => {
  const { g } = sample();
  const rows = parseCsv(IO.toCsv(g, 'edges'));
  const i = rows[0].indexOf('amount_sat');
  rows.slice(1).forEach((r) => assert.match(r[i], /^\d+$/));
});

test('GraphML: declared keys, directed graph, one node/edge element per item, escaped text', () => {
  const { g } = sample();
  g.annotate(ID.addr(fx('tx_normal.json').vout[1].scriptpubkey_address), '<script>alert(1)</script> & "q" \'s\'', 'ctl\u0001char \ud800 lone');
  const x = IO.toGraphMl(g);
  assert.match(x, /edgedefault="directed"/);
  assert.equal((x.match(/<node /g) || []).length, g.nodes.size);
  assert.equal((x.match(/<edge /g) || []).length, g.edges.size);
  assert.ok(!x.includes('<script>'));
  assert.ok(x.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot; &apos;s&apos;'));
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(x));
  assert.ok(!x.includes('\ud800'));
  // every data key used is declared
  const declared = new Set([...x.matchAll(/<key id="([^"]+)"/g)].map((m) => m[1]));
  [...x.matchAll(/<data key="([^"]+)"/g)].forEach((m) => assert.ok(declared.has(m[1]), 'undeclared key ' + m[1]));
});

test('GraphML is well-formed XML (parsed by Python)', (ctx) => {
  const probe = spawnSync('python', ['-I', '-c', 'import xml.etree.ElementTree'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return ctx.skip('python not available');
  const { g } = sample();
  g.annotate(ID.addr(fx('tx_normal.json').vout[1].scriptpubkey_address), 'a<b>&"\'\u0007 😀', 'x');
  const code = 'import sys,xml.etree.ElementTree as E; r=E.fromstring(sys.stdin.buffer.read()); ns="{http://graphml.graphdrawing.org/xmlns}"; print(len(list(r.iter(ns+"node"))), len(list(r.iter(ns+"edge"))))';
  const r = spawnSync('python', ['-I', '-c', code], { input: Buffer.from(IO.toGraphMl(g), 'utf8'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${g.nodes.size} ${g.edges.size}`);
});

test('export of the visible subset applies to CSV and GraphML too', () => {
  const { g } = sample();
  const v = F.computeVisible(g, { minAmount: 10 ** 8 });
  assert.equal(parseCsv(IO.toCsv(g, 'edges', { only: v })).length, v.edges.size + 1);
  assert.equal((IO.toGraphMl(g, { only: v }).match(/<node /g) || []).length, v.nodes.size);
});

test('import canonicalises address case: one vertex per address however the file spelled it, edges and focus follow', () => {
  const lower = 'bc1qdg78fm9gjwwywsh3545qp4us4rpyrclm9v8udq';
  const doc = { format: 'orion-workspace', version: 1, view: { focus: 'addr:' + lower.toUpperCase() },
    nodes: [{ id: 'addr:' + lower.toUpperCase(), type: 'addr', address: lower.toUpperCase(), label: 'x' },
            { id: 'addr:' + lower, type: 'addr', address: lower, note: 'n' },
            { id: 'addr:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', type: 'addr', address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2' },
            { id: 'tx:' + 'a'.repeat(64), type: 'tx', txid: 'a'.repeat(64) }],
    edges: [{ id: 'out:' + 'a'.repeat(64) + ':0', source: 'tx:' + 'a'.repeat(64), target: 'addr:' + lower.toUpperCase(), kind: 'out', amount: 5, txid: 'a'.repeat(64) }] };
  const r = IO.fromJson(JSON.stringify(doc));
  assert.equal(r.graph.nodes.size, 3, 'the two spellings are one vertex');
  const n = r.graph.node('addr:' + lower);
  assert.equal(n.address, lower);
  assert.equal(n.label, 'x'); assert.equal(n.note, 'n');
  assert.equal(r.graph.edges.get('out:' + 'a'.repeat(64) + ':0').target, 'addr:' + lower);
  assert.equal(r.view.focus, 'addr:' + lower);
  assert.ok(r.graph.node('addr:1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), 'base58 keeps its case');
  assert.equal(r.warnings.length, 0);
});

test('CSV and GraphML carry fiat columns when a converter is given, and leave them empty otherwise', () => {
  const { g, t } = sample();
  const fiat = (e) => (e.amount > 0 ? { value: (e.amount / 1e8 * 45000).toFixed(4), currency: 'USD', price: '45000', basis: '2022-04-05' } : null);
  const withF = parseCsv(IO.toCsv(g, 'edges', { fiat }));
  const none = parseCsv(IO.toCsv(g, 'edges'));
  const col = (rows, name) => rows[0].indexOf(name);
  assert.ok(col(withF, 'fiat_value') > 0 && col(withF, 'fiat_basis') > 0);
  const row = withF.find((r) => r[0] === ID.edgeOut(t.txid, 0));
  assert.equal(row[col(withF, 'fiat_currency')], 'USD');
  assert.equal(row[col(withF, 'fiat_price_per_btc')], '45000');
  assert.equal(Number(row[col(withF, 'fiat_value')]), Number((t.vout[0].value / 1e8 * 45000).toFixed(4)));
  assert.equal(row[col(withF, 'fiat_basis')], '2022-04-05');
  none.slice(1).forEach((r) => assert.equal(r[col(none, 'fiat_value')], ''));
  const x = IO.toGraphMl(g, { fiat });
  assert.match(x, /<data key="e_fiat_currency">USD<\/data>/);
  assert.ok(x.includes('attr.name="fiat_value" attr.type="double"'));
  assert.ok(!IO.toGraphMl(g).includes('<data key="e_fiat_value">'));
});

test('tags, colours, shapes and lookup results survive export and import', () => {
  const { g, t } = sample();
  const id = ID.addr(t.vout[0].scriptpubkey_address);
  const T = require('../public/js/orion-tags.js'), X = require('../public/js/orion-external.js');
  T.apply(g.node(id), { tag: 'EXCH' }); T.apply(g.node(id), { color: '#123abc' });
  g.node(id).ext = { arkham: X.toExt({ arkhamEntity: { name: 'Binance', type: 'cex' }, arkhamLabel: { name: 'Hot Wallet' } }, 1700000000) };
  const back = IO.fromJson(IO.toJson(g)).graph.node(id);
  assert.deepEqual([back.tag, back.color, back.shape], ['EXCH', '#123abc', 'hexagon']);
  assert.equal(back.ext.arkham.name, 'Binance'); assert.equal(back.ext.arkham.at, 1700000000); assert.equal(back.ext.arkham.suggest, 'EXCH');
  const rows = parseCsv(IO.toCsv(g, 'nodes')), h = rows[0], r = rows.find((x) => x[0] === id);
  assert.deepEqual([r[h.indexOf('tag')], r[h.indexOf('color')], r[h.indexOf('shape')], r[h.indexOf('ext_arkham_name')], r[h.indexOf('ext_arkham_type')], r[h.indexOf('ext_arkham_label')]],
                   ['EXCH', '#123abc', 'hexagon', 'Binance', 'cex', 'Hot Wallet']);
  const x = IO.toGraphMl(g);
  assert.match(x, /<data key="n_tag">EXCH<\/data>/); assert.match(x, /<data key="n_ext_arkham_name">Binance<\/data>/);
});

test('import refuses hostile tag, colour, shape and lookup data', () => {
  const doc = { format: 'orion-workspace', version: 1, nodes: [
    { id: 'addr:x', type: 'addr', address: 'x', tag: '<script>alert(1)</script>', color: 'url(javascript:1)', shape: 'blob',
      ext: { arkham: { name: '<img src=x onerror=1>', tags: 'nope', suggest: 'HACK', evil: 1 }, other: { a: 1 } } },
    { id: 'addr:y', type: 'addr', address: 'y', tag: 'exch', color: '#ABCDEF', shape: 'star', ext: 'junk' }], edges: [] };
  const r = IO.fromJson(JSON.stringify(doc));
  const x = r.graph.node('addr:x'), y = r.graph.node('addr:y');
  assert.equal(x.tag, 'scriptalert1script'); assert.ok(!('color' in x) && !('shape' in x), 'no invalid colour or shape');
  assert.deepEqual(Object.keys(x.ext), ['arkham']);
  assert.ok(!('evil' in x.ext.arkham) && x.ext.arkham.suggest === '' && Array.isArray(x.ext.arkham.tags) && x.ext.arkham.tags.length === 0);
  assert.deepEqual([y.tag, y.color, y.shape], ['EXCH', '#abcdef', 'star']);
  assert.ok(!('ext' in y), 'unusable lookup data is dropped');
});
