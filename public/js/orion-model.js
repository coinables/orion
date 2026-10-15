/*
 * Orion graph model.
 *
 * A Bitcoin investigation graph with TWO kinds of vertex that matter and a few special ones:
 *   tx        a transaction                       id "tx:<txid>"
 *   addr      an address                          id "addr:<address>"
 *   coinbase  newly minted coins (coinbase input) id "cb:<txid>"
 *   data      an OP_RETURN output                 id "data:<txid>:<vout>"
 *   nonstd    an output with no address           id "ns:<txid>:<vout>"
 *
 * Edges always run in the direction money moves, and every edge belongs to ONE transaction:
 *   in   addr|coinbase|nonstd -> tx    id "in:<txid>:<vin>"    (amount = value of the spent output)
 *   out  tx -> addr|data|nonstd        id "out:<txid>:<vout>"  (amount = value of the output)
 *
 * Unlike the original Orion pages this keeps what the API returns: confirmation time, amounts in
 * satoshis and script types. Plain data (no DOM), so it runs in a browser and under `node --test`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID = {
    tx: function (txid) { return 'tx:' + txid; },
    addr: function (a) { return 'addr:' + a; },
    coinbase: function (txid) { return 'cb:' + txid; },
    data: function (txid, n) { return 'data:' + txid + ':' + n; },
    nonstd: function (txid, n) { return 'ns:' + txid + ':' + n; },
    edgeIn: function (txid, i) { return 'in:' + txid + ':' + i; },
    edgeOut: function (txid, n) { return 'out:' + txid + ':' + n; }
  };

  // ---- OP_RETURN payload ---------------------------------------------------------------------
  function hexToBytes(hex) {
    var out = [];
    for (var i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
    return out;
  }

  /** Decode an OP_RETURN script (hex) into {hex, text}. text is '' unless the payload is mostly printable. */
  function decodeOpReturn(scriptHex) {
    var b = hexToBytes(scriptHex || '');
    var payload = [];
    var i = (b[0] === 0x6a) ? 1 : 0;
    while (i < b.length) {
      var op = b[i++];
      var len;
      if (op >= 1 && op <= 75) len = op;
      else if (op === 0x4c) { len = b[i]; i += 1; }
      else if (op === 0x4d) { len = b[i] | (b[i + 1] << 8); i += 2; }
      else if (op === 0x4e) { len = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) >>> 0; i += 4; }   // 4-byte length; payloads this size don't occur on-chain
      else continue;                                                                                // OP_0 / other opcodes carry no data
      if (!(len >= 0)) break;
      for (var k = 0; k < len && i < b.length; k++) payload.push(b[i++]);
    }
    var hex = payload.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join('');
    var printable = payload.filter(function (x) { return x >= 32 && x < 127; }).length;
    var text = '';
    if (payload.length >= 4 && printable / payload.length >= 0.8) {
      text = payload.slice(0, 120).map(function (x) { return (x >= 32 && x < 127) ? String.fromCharCode(x) : '.'; }).join('');
    }
    return { hex: hex, text: text };
  }

  // ---- Graph ----------------------------------------------------------------------------------
  function Graph() {
    this.nodes = new Map();
    this.edges = new Map();
    this.adj = new Map();            // node id -> Set of incident edge ids
  }

  // Merge rule used everywhere: null/undefined never overwrite a value we already know.
  function mergeInto(target, incoming) {
    Object.keys(incoming).forEach(function (k) {
      var v = incoming[k];
      if (v !== undefined && v !== null) target[k] = v;
    });
    return target;
  }

  Graph.prototype.node = function (id) { return this.nodes.get(id); };

  Graph.prototype.upsertNode = function (n) {
    var cur = this.nodes.get(n.id);
    if (!cur) { cur = { id: n.id, type: n.type }; this.nodes.set(n.id, cur); this.adj.set(n.id, new Set()); }
    if (cur.loaded === true && n.loaded === false) { n = Object.assign({}, n); delete n.loaded; }   // a stub never demotes a loaded tx
    mergeInto(cur, n);
    return cur;
  };

  Graph.prototype.upsertEdge = function (e) {
    var cur = this.edges.get(e.id);
    if (!cur) {
      cur = { id: e.id };
      this.edges.set(e.id, cur);
    }
    mergeInto(cur, e);
    if (!this.adj.has(cur.source)) this.adj.set(cur.source, new Set());
    if (!this.adj.has(cur.target)) this.adj.set(cur.target, new Set());
    this.adj.get(cur.source).add(cur.id);
    this.adj.get(cur.target).add(cur.id);
    return cur;
  };

  Graph.prototype.edgesOf = function (id) {
    var s = this.adj.get(id), out = [];
    if (s) s.forEach(function (eid) { out.push(this.edges.get(eid)); }, this);
    return out;
  };

  function outputNode(g, txid, o, n) {
    // returns the vertex id that receives output n of txid
    if (o.scriptpubkey_address) {
      g.upsertNode({ id: ID.addr(o.scriptpubkey_address), type: 'addr', address: o.scriptpubkey_address, scriptType: o.scriptpubkey_type });
      return ID.addr(o.scriptpubkey_address);
    }
    if (o.scriptpubkey_type === 'op_return') {
      var d = decodeOpReturn(o.scriptpubkey);
      g.upsertNode({ id: ID.data(txid, n), type: 'data', txid: txid, vout: n, scriptType: 'op_return', dataHex: d.hex, dataText: d.text });
      return ID.data(txid, n);
    }
    g.upsertNode({ id: ID.nonstd(txid, n), type: 'nonstd', txid: txid, vout: n, scriptType: o.scriptpubkey_type || 'nonstandard' });
    return ID.nonstd(txid, n);
  }

  /** Your own label and note for a vertex. Empty text clears it. Returns false when the vertex is unknown. */
  Graph.prototype.annotate = function (id, label, note) {
    var n = this.nodes.get(id);
    if (!n) return false;
    label = (label || '').trim(); note = (note || '').trim();
    if (label) n.label = label; else delete n.label;
    if (note) n.note = note; else delete n.note;
    return true;
  };

  /** Ingest one Esplora transaction object. Safe to call repeatedly (idempotent). */
  Graph.prototype.addTx = function (t) {
    var txid = t.txid;
    var confirmed = !!(t.status && t.status.confirmed);
    var time = confirmed && t.status.block_time != null ? t.status.block_time : null;
    var isCoinbase = !!(t.vin && t.vin[0] && t.vin[0].is_coinbase);
    var valueOut = t.vout.reduce(function (s, o) { return s + (o.value || 0); }, 0);
    var valueIn = isCoinbase ? null : t.vin.reduce(function (s, v) { return s + ((v.prevout && v.prevout.value) || 0); }, 0);
    var txId = ID.tx(txid);
    this.upsertNode({
      id: txId, type: 'tx', txid: txid, loaded: true, confirmed: confirmed, time: time,
      height: confirmed ? t.status.block_height : null,
      fee: t.fee != null ? t.fee : null,
      vsize: t.weight ? Math.ceil(t.weight / 4) : (t.size || null),
      nIn: t.vin.length, nOut: t.vout.length, valueIn: valueIn, valueOut: valueOut, coinbase: isCoinbase
    });

    var g = this;
    t.vout.forEach(function (o, n) {
      var target = outputNode(g, txid, o, n);
      g.upsertEdge({ id: ID.edgeOut(txid, n), source: txId, target: target, kind: 'out', txid: txid, vout: n,
                     amount: o.value || 0, time: time, confirmed: confirmed });
    });

    t.vin.forEach(function (v, i) {
      var source, prev = null;
      if (v.is_coinbase || !v.prevout) {
        source = ID.coinbase(txid);
        g.upsertNode({ id: source, type: 'coinbase', txid: txid });
      } else {
        source = outputNode(g, v.txid, v.prevout, v.vout);
        prev = { txid: v.txid, vout: v.vout };
        // the funding transaction: a stub until it is loaded (its own addTx fills in the rest)
        var stubId = ID.tx(v.txid);
        if (!g.nodes.has(stubId)) g.upsertNode({ id: stubId, type: 'tx', txid: v.txid, loaded: false, confirmed: null, time: null });
        var fundId = ID.edgeOut(v.txid, v.vout);
        if (!g.edges.has(fundId)) {
          g.upsertEdge({ id: fundId, source: stubId, target: source, kind: 'out', txid: v.txid, vout: v.vout, amount: v.prevout.value || 0, time: null });
        }
        g.edges.get(fundId).spent = true;
        g.edges.get(fundId).spentBy = { txid: txid, vin: i, time: time };
      }
      g.upsertEdge({ id: ID.edgeIn(txid, i), source: source, target: txId, kind: 'in', txid: txid, vin: i,
                     amount: v.is_coinbase || !v.prevout ? valueOut : (v.prevout.value || 0), time: time, confirmed: confirmed, prev: prev });
    });
    return txId;
  };

  /** Ingest GET /tx/<id>/outspends: marks which outputs are spent, and by whom (with the spender's time). */
  Graph.prototype.addOutspends = function (txid, outspends) {
    var g = this;
    if (g.nodes.has(ID.tx(txid))) g.nodes.get(ID.tx(txid)).outspendsLoaded = true;
    outspends.forEach(function (o, n) {
      var edge = g.edges.get(ID.edgeOut(txid, n));
      if (!edge) return;
      if (!o || !o.spent) { edge.spent = false; return; }
      var confirmed = !!(o.status && o.status.confirmed);
      var time = confirmed && o.status.block_time != null ? o.status.block_time : null;
      edge.spent = true;
      edge.spentBy = { txid: o.txid, vin: o.vin, time: time };
      var spenderId = ID.tx(o.txid);
      if (!g.nodes.has(spenderId)) {
        g.upsertNode({ id: spenderId, type: 'tx', txid: o.txid, loaded: false, confirmed: confirmed, time: time });
      } else if (!g.nodes.get(spenderId).loaded) {
        mergeInto(g.nodes.get(spenderId), { confirmed: confirmed, time: time });
      }
      g.upsertEdge({ id: ID.edgeIn(o.txid, o.vin), source: edge.target, target: spenderId, kind: 'in', txid: o.txid, vin: o.vin,
                     amount: edge.amount, time: time, confirmed: confirmed, prev: { txid: txid, vout: n } });
    });
  };

  Graph.prototype.removeEdge = function (id) {
    var e = this.edges.get(id);
    if (!e) return;
    var a = this.adj.get(e.source), b = this.adj.get(e.target);
    if (a) a.delete(id);
    if (b) b.delete(id);
    this.edges.delete(id);
  };

  Graph.prototype.dropNode = function (id) {
    this.nodes.delete(id); this.adj.delete(id);
  };

  /**
   * Remove a vertex and its edges, then whatever it leaves dangling: vertices with no edges, and
   * unloaded transaction stubs that only hang off vertices nothing else touches. Returns removed ids.
   */
  Graph.prototype.removeNode = function (id) {
    if (!this.nodes.has(id)) return [];
    var removed = [id], g = this, touched = new Set();
    this.edgesOf(id).forEach(function (e) { touched.add(e.source); touched.add(e.target); g.removeEdge(e.id); });
    this.dropNode(id);
    touched.delete(id);
    // candidates: the old neighbours and their neighbours (a funding stub sits one step beyond an input address)
    var queue = [];
    touched.forEach(function (nid) {
      queue.push(nid);
      g.edgesOf(nid).forEach(function (e) { queue.push(e.source === nid ? e.target : e.source); });
    });
    while (queue.length) {
      var nid = queue.pop(), n = this.nodes.get(nid);
      if (!n) continue;
      var edges = this.edgesOf(nid);
      var dangling = edges.length === 0;
      if (!dangling && n.type === 'tx' && n.loaded === false) {
        // a stub whose every neighbour has no other connection: it only existed because of what was removed
        dangling = edges.every(function (e) {
          var other = e.source === nid ? e.target : e.source;
          return g.adj.get(other).size === 1;
        });
      }
      if (!dangling) continue;
      edges.forEach(function (e) {
        var other = e.source === nid ? e.target : e.source;
        g.removeEdge(e.id);
        queue.push(other);
      });
      this.dropNode(nid);
      removed.push(nid);
    }
    return removed;
  };

  /** Compute per-vertex first/last seen, received/sent and degree from the edges. */
  Graph.prototype.refreshDerived = function () {
    this.nodes.forEach(function (n) { n.firstSeen = null; n.lastSeen = null; n.received = 0; n.sent = 0; n.degree = 0; });
    var g = this;
    function touch(n, t) {
      if (t == null) return;
      if (n.firstSeen == null || t < n.firstSeen) n.firstSeen = t;
      if (n.lastSeen == null || t > n.lastSeen) n.lastSeen = t;
    }
    this.edges.forEach(function (e) {
      var s = g.nodes.get(e.source), t = g.nodes.get(e.target);
      if (!s || !t) return;
      s.degree++; t.degree++;
      if (e.kind === 'out') t.received += e.amount; else s.sent += e.amount;
      touch(s, e.time); touch(t, e.time);
    });
    this.nodes.forEach(function (n) { if (n.type === 'tx' && n.time != null) { n.firstSeen = n.time; n.lastSeen = n.time; } });
  };

  /** {min, max, pending, unknown} over confirmed transaction times in the graph (or only the vertices in `only`). */
  Graph.prototype.timeBounds = function (only) {
    var min = null, max = null, pending = 0, unknown = 0;
    this.nodes.forEach(function (n) {
      if (n.type !== 'tx' || (only && !only.has(n.id))) return;
      if (n.time != null) { if (min == null || n.time < min) min = n.time; if (max == null || n.time > max) max = n.time; }
      else if (n.confirmed === false) pending++;
      else unknown++;
    });
    return { min: min, max: max, pending: pending, unknown: unknown };
  };

  Graph.prototype.stats = function () {
    var c = { nodes: this.nodes.size, edges: this.edges.size, tx: 0, txLoaded: 0, addr: 0, data: 0, nonstd: 0, coinbase: 0 };
    this.nodes.forEach(function (n) {
      c[n.type] = (c[n.type] || 0) + 1;
      if (n.type === 'tx' && n.loaded) c.txLoaded++;
    });
    return c;
  };

  Graph.prototype.toData = function () {
    return { nodes: Array.from(this.nodes.values()).map(function (n) { return Object.assign({}, n); }),
             edges: Array.from(this.edges.values()).map(function (e) { return Object.assign({}, e); }) };
  };

  Graph.fromData = function (data) {
    var g = new Graph();
    (data.nodes || []).forEach(function (n) { g.upsertNode(n); });
    (data.edges || []).forEach(function (e) { g.upsertEdge(e); });
    return g;
  };

  return { Graph: Graph, ID: ID, decodeOpReturn: decodeOpReturn, mergeInto: mergeInto };
}));
