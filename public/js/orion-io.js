/*
 * Orion import / export. Pure string in, string out (no DOM, no downloads), so it is testable under node.
 *
 *   JSON     the full workspace: graph, labels, notes and view settings. The only format that imports back.
 *   CSV      nodes and edges as two tables, for spreadsheets and for Gephi / Maltego table import.
 *   GraphML  a directed graph with typed attributes, for Gephi, Maltego, yEd, Cytoscape, NetworkX.
 *
 * Exports can be limited to what is currently visible. Every exporter treats labels and notes as untrusted text:
 * CSV cells are defused against spreadsheet formula injection and XML is escaped.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-model.js'), require('./orion-style.js'), require('./orion-address.js'), require('./orion-tags.js'), require('./orion-external.js'));
  else root.OrionIO = factory(root.OrionModel, root.OrionStyle, root.OrionAddress, root.OrionTags, root.OrionExternal);
}(typeof self !== 'undefined' ? self : this, function (Model, Style, Addr, Tags, Ext) {
  'use strict';

  var FORMAT = 'orion-workspace', VERSION = 1;
  var NODE_TYPES = { tx: 1, addr: 1, coinbase: 1, data: 1, nonstd: 1 };
  var EDGE_KINDS = { 'in': 1, out: 1 };
  var MAX_NODES = 200000, MAX_EDGES = 400000, MAX_TEXT = 20000;
  var BAD_KEYS = { '__proto__': 1, constructor: 1, prototype: 1 };

  function pick(graph, only) {
    var nodes = [], edges = [];
    graph.nodes.forEach(function (n) { if (!only || only.nodes.has(n.id)) nodes.push(n); });
    graph.edges.forEach(function (e) { if (!only || only.edges.has(e.id)) edges.push(e); });
    return { nodes: nodes, edges: edges };
  }

  // ---- JSON -----------------------------------------------------------------------------------
  function toJson(graph, opts) {
    opts = opts || {};
    var p = pick(graph, opts.only);
    return JSON.stringify({
      format: FORMAT, version: VERSION,
      exported: new Date(opts.now != null ? opts.now : Date.now()).toISOString(),
      source: opts.source || null,
      view: opts.view || null,
      positions: opts.positions || null,
      nodes: p.nodes, edges: p.edges
    }, null, 1);
  }

  function clean(v, depth) {
    // deep copy of plain data without prototype-polluting keys; strings are capped
    if (depth > 6) return null;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return (typeof v === 'number' && !isFinite(v)) ? null : v;
    if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
    if (Array.isArray(v)) return v.slice(0, 1000).map(function (x) { return clean(x, depth + 1); });
    if (typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { if (!BAD_KEYS[k]) o[k] = clean(v[k], depth + 1); });
      return o;
    }
    return null;
  }

  /** Returns { graph, view, positions, warnings } or throws Error with a user-readable message. */
  function fromJson(text) {
    var d;
    try { d = JSON.parse(text); } catch (e) { throw new Error('Not a JSON file.'); }
    if (!d || typeof d !== 'object' || d.format !== FORMAT) throw new Error('Not an Orion workspace file (missing format "' + FORMAT + '").');
    if (typeof d.version !== 'number' || d.version > VERSION) throw new Error('This file was written by a newer Orion (version ' + d.version + ').');
    if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('The file has no nodes/edges lists.');
    if (d.nodes.length > MAX_NODES || d.edges.length > MAX_EDGES) throw new Error('The file is too large to open (limit ' + MAX_NODES + ' nodes / ' + MAX_EDGES + ' edges).');

    var warnings = [], g = new Model.Graph(), dropped = 0, idMap = new Map();
    d.nodes.forEach(function (n) {
      if (!n || typeof n.id !== 'string' || !n.id || !NODE_TYPES[n.type]) { dropped++; return; }
      var c = clean(n, 0);
      Tags.sanitize(c);                                                     // tag / colour / shape: only valid values ever reach a canvas
      if ('ext' in c) { var x = Ext.cleanExt(c.ext); if (x) c.ext = x; else delete c.ext; }
      if (c.type === 'addr' && typeof c.address === 'string') {            // bech32 is case-insensitive: one vertex per address, however it was written
        var canon = Addr.normalise(c.address), cid = 'addr:' + canon;
        if (cid !== c.id) { idMap.set(c.id, cid); c.id = cid; }
        c.address = canon;
      }
      g.upsertNode(c);
    });
    var badEdges = 0;
    d.edges.forEach(function (e) {
      if (!e || typeof e.id !== 'string' || !EDGE_KINDS[e.kind] || typeof e.amount !== 'number') { badEdges++; return; }
      var c = clean(e, 0);
      if (idMap.has(c.source)) c.source = idMap.get(c.source);
      if (idMap.has(c.target)) c.target = idMap.get(c.target);
      if (!g.nodes.has(c.source) || !g.nodes.has(c.target)) { badEdges++; return; }
      g.upsertEdge(c);
    });
    g.refreshDerived();
    if (dropped) warnings.push(dropped + ' invalid node(s) skipped');
    if (badEdges) warnings.push(badEdges + ' invalid edge(s) skipped');
    var view = d.view ? clean(d.view, 0) : null;
    if (view && typeof view.focus === 'string' && idMap.has(view.focus)) view.focus = idMap.get(view.focus);
    return { graph: g, view: view, positions: d.positions ? clean(d.positions, 0) : null, warnings: warnings };
  }

  // ---- CSV ------------------------------------------------------------------------------------
  /** A cell that starts with = + - @ TAB CR can run as a formula in Excel/LibreOffice/Sheets: prefix it with a quote. */
  function defuse(s) { return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }

  function cell(v, numeric) {
    if (v === null || v === undefined) return '';
    if (numeric || typeof v === 'number' || typeof v === 'boolean') return String(v);
    var s = defuse(String(v));
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function row(cells) { return cells.join(','); }

  var NODE_COLS = ['id', 'type', 'label', 'note', 'address', 'txid', 'vout', 'script_type', 'time_unix', 'time_utc', 'height', 'confirmed',
                   'first_seen_unix', 'last_seen_unix', 'received_sat', 'sent_sat', 'degree', 'op_return_text', 'op_return_hex',
                   'tag', 'color', 'shape', 'ext_arkham_name', 'ext_arkham_type', 'ext_arkham_label'];
  var EDGE_COLS = ['edge_id', 'txid', 'kind', 'source', 'source_label', 'target', 'target_label', 'amount_sat', 'amount_btc', 'time_unix', 'time_utc',
                   'confirmed', 'spent', 'spent_by_txid', 'fiat_value', 'fiat_currency', 'fiat_price_per_btc', 'fiat_basis'];

  function toCsv(graph, which, opts) {
    opts = opts || {};
    var p = pick(graph, opts.only), lines = [];
    function labelOf(id) { var n = graph.nodes.get(id); return n && n.label ? n.label : ''; }
    if (which === 'edges') {
      lines.push(row(EDGE_COLS));
      p.edges.forEach(function (e) {
        var txn = graph.nodes.get(e.kind === 'out' ? e.source : e.target), t = txn && txn.time != null ? txn.time : e.time;
        var f = opts.fiat ? opts.fiat(e) : null;                       // {value, currency, price, basis} as strings, or null
        lines.push(row([cell(e.id), cell(e.txid), cell(e.kind), cell(e.source), cell(labelOf(e.source)), cell(e.target), cell(labelOf(e.target)),
                        cell(e.amount, true), cell(Style.fmtBtc(e.amount), true), cell(t), cell(t != null ? Style.fmtTime(t) : ''),
                        cell(txn && txn.confirmed != null ? txn.confirmed : ''), cell(e.spent != null ? e.spent : ''), cell(e.spentBy ? e.spentBy.txid : ''),
                        cell(f ? f.value : '', true), cell(f ? f.currency : ''), cell(f ? f.price : '', true), cell(f ? f.basis : '')]));
      });
    } else {
      lines.push(row(NODE_COLS));
      p.nodes.forEach(function (n) {
        var ark = (n.ext && n.ext.arkham) || {};
        lines.push(row([cell(n.id), cell(n.type), cell(n.label), cell(n.note), cell(n.address), cell(n.txid), cell(n.vout), cell(n.scriptType),
                        cell(n.time), cell(n.time != null ? Style.fmtTime(n.time) : ''), cell(n.height), cell(n.confirmed),
                        cell(n.firstSeen), cell(n.lastSeen), cell(n.received), cell(n.sent), cell(n.degree), cell(n.dataText), cell(n.dataHex),
                        cell(n.tag), cell(n.color), cell(n.shape), cell(ark.name), cell(ark.type), cell(ark.label)]));
      });
    }
    return lines.join('\r\n') + '\r\n';
  }

  // ---- GraphML --------------------------------------------------------------------------------
  /** Drop characters that cannot appear in XML 1.0 (control characters, lone surrogates, U+FFFE/U+FFFF). */
  function xmlSafe(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { out += str[i] + str[i + 1]; i++; }       // a valid pair stays
        continue;                                                                   // otherwise the lone high surrogate goes
      }
      if (c >= 0xDC00 && c <= 0xDFFF) continue;                                     // lone low surrogate
      if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) continue;
      if (c === 0xFFFE || c === 0xFFFF) continue;
      out += str[i];
    }
    return out;
  }
  function xml(v) {
    return xmlSafe(String(v)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  var G_NODE = [['label', 'string'], ['type', 'string'], ['note', 'string'], ['address', 'string'], ['txid', 'string'], ['script_type', 'string'],
                ['time', 'long'], ['time_utc', 'string'], ['received', 'long'], ['sent', 'long'], ['degree', 'int'], ['op_return_text', 'string'],
                ['tag', 'string'], ['color', 'string'], ['shape', 'string'], ['ext_arkham_name', 'string'], ['ext_arkham_type', 'string']];
  var G_EDGE = [['kind', 'string'], ['txid', 'string'], ['amount', 'long'], ['amount_btc', 'string'], ['time', 'long'], ['time_utc', 'string'], ['spent', 'boolean'],
                ['fiat_value', 'double'], ['fiat_currency', 'string'], ['fiat_price_per_btc', 'double'], ['fiat_basis', 'string']];

  function toGraphMl(graph, opts) {
    opts = opts || {};
    var p = pick(graph, opts.only), out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
    G_NODE.forEach(function (k) { out.push('  <key id="n_' + k[0] + '" for="node" attr.name="' + k[0] + '" attr.type="' + k[1] + '"/>'); });
    G_EDGE.forEach(function (k) { out.push('  <key id="e_' + k[0] + '" for="edge" attr.name="' + k[0] + '" attr.type="' + k[1] + '"/>'); });
    out.push('  <graph id="orion" edgedefault="directed">');
    function data(prefix, name, v) { if (v !== null && v !== undefined && v !== '') out.push('      <data key="' + prefix + name + '">' + xml(v) + '</data>'); }
    p.nodes.forEach(function (n) {
      out.push('    <node id="' + xml(n.id) + '">');
      data('n_', 'label', n.label || (n.type === 'tx' ? Style.shortId(n.txid) : n.type === 'addr' ? Style.shortId(n.address, 8) : n.type));
      data('n_', 'type', n.type); data('n_', 'note', n.note); data('n_', 'address', n.address); data('n_', 'txid', n.txid);
      data('n_', 'script_type', n.scriptType); data('n_', 'time', n.time); data('n_', 'time_utc', n.time != null ? Style.fmtTime(n.time) : null);
      data('n_', 'received', n.received); data('n_', 'sent', n.sent); data('n_', 'degree', n.degree); data('n_', 'op_return_text', n.dataText);
      data('n_', 'tag', n.tag); data('n_', 'color', n.color); data('n_', 'shape', n.shape);
      if (n.ext && n.ext.arkham) { data('n_', 'ext_arkham_name', n.ext.arkham.name || n.ext.arkham.label); data('n_', 'ext_arkham_type', n.ext.arkham.type); }
      out.push('    </node>');
    });
    p.edges.forEach(function (e) {
      out.push('    <edge id="' + xml(e.id) + '" source="' + xml(e.source) + '" target="' + xml(e.target) + '">');
      var txn = graph.nodes.get(e.kind === 'out' ? e.source : e.target), t = txn && txn.time != null ? txn.time : e.time;
      data('e_', 'kind', e.kind); data('e_', 'txid', e.txid); data('e_', 'amount', e.amount); data('e_', 'amount_btc', Style.fmtBtc(e.amount));
      data('e_', 'time', t); data('e_', 'time_utc', t != null ? Style.fmtTime(t) : null); data('e_', 'spent', e.spent);
      var f = opts.fiat ? opts.fiat(e) : null;
      if (f) { data('e_', 'fiat_value', f.value); data('e_', 'fiat_currency', f.currency); data('e_', 'fiat_price_per_btc', f.price); data('e_', 'fiat_basis', f.basis); }
      out.push('    </edge>');
    });
    out.push('  </graph>', '</graphml>', '');
    return out.join('\n');
  }

  return { FORMAT: FORMAT, VERSION: VERSION, toJson: toJson, fromJson: fromJson, toCsv: toCsv, toGraphMl: toGraphMl,
           defuse: defuse, xml: xml, NODE_COLS: NODE_COLS, EDGE_COLS: EDGE_COLS };
}));
