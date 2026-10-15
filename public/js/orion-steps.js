/*
 * Orion "follow the money" steps: given the vertex you are looking at, where could you go next, and where did the
 * money come from? Pure functions over the graph, no DOM.
 *
 *   previous   what is upstream:  a transaction <- the wallets that paid into it;  a wallet <- the transactions that paid it
 *   next       what is downstream: a transaction -> the wallets it paid;           a wallet -> the transactions that spent from it
 *
 * With `viaWallets: false` a transaction steps straight to the neighbouring transactions (the wallet in between is
 * reported as `via`), which is the quick way to walk a chain of payments.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-model.js'));
  else root.OrionSteps = factory(root.OrionModel);
}(typeof self !== 'undefined' ? self : this, function (Model) {
  'use strict';

  var ID = Model.ID;

  function txTimeOf(graph, e) {
    var tx = graph.nodes.get(e.kind === 'out' ? e.source : e.target);
    if (tx && tx.time != null) return tx.time;
    if (e.time != null) return e.time;
    if (tx && tx.confirmed === false) return null;                                     // unconfirmed: no time yet
    return e.spentBy && e.spentBy.time != null ? e.spentBy.time : null;               // a transaction not loaded yet: when its output was spent
  }

  /**
   * Rows for one direction. Each row:
   *   { id, type, navigable, amount, time, count, via, spent, spender, note }
   *   id        vertex to move to (null when there is nothing to move to: coinbase, OP_RETURN, an unspent output)
   *   amount    satoshis moved along this step (merged when several edges lead to the same place)
   *   time      when it moved (the carrying transaction's time), for converting the amount
   *   via       the wallet in between, in transactions-only mode
   *   spent     for a wallet reached from a transaction: true / false / null (unknown)
   * Moveable rows come first, largest amount first, then the informational ones.
   */
  function neighbours(graph, id, dir, opts) {
    var n = graph.nodes.get(id);
    if (!n || (dir !== 'prev' && dir !== 'next')) return [];
    var viaWallets = !opts || opts.viaWallets !== false;
    var rows = new Map();

    function add(key, row) {
      var cur = rows.get(key);
      if (cur) {
        cur.amount += row.amount; cur.count++;
        if (row.time != null && (cur.time == null || row.time < cur.time)) cur.time = row.time;
        if (row.spent === false) cur.spent = false;
      } else { row.count = 1; rows.set(key, row); }
    }
    function node(vid) { return graph.nodes.get(vid); }

    graph.edgesOf(id).forEach(function (e) {
      var time = txTimeOf(graph, e), other;

      if (n.type === 'tx') {
        if (dir === 'prev' && e.kind === 'in' && e.target === id) {
          other = node(e.source); if (!other) return;
          if (other.type === 'coinbase') return add('coinbase', { id: null, type: 'coinbase', navigable: false, amount: e.amount, time: time, note: 'newly created coins' });
          if (viaWallets || !e.prev) {
            if (other.type === 'addr') add(other.id, { id: other.id, type: 'addr', navigable: true, amount: e.amount, time: time });
            else add(other.id, { id: null, type: other.type, navigable: false, amount: e.amount, time: time, note: other.type === 'data' ? 'OP_RETURN' : 'non-standard output' });
          } else {
            add(ID.tx(e.prev.txid), { id: ID.tx(e.prev.txid), type: 'tx', navigable: !!node(ID.tx(e.prev.txid)), amount: e.amount, time: time, via: other.id });
          }
        } else if (dir === 'next' && e.kind === 'out' && e.source === id) {
          other = node(e.target); if (!other) return;
          if (viaWallets) {
            if (other.type === 'addr') add(other.id, { id: other.id, type: 'addr', navigable: true, amount: e.amount, time: time,
                                                      spent: e.spent === true ? true : e.spent === false ? false : null, spender: e.spentBy ? e.spentBy.txid : null });
            else add(other.id, { id: null, type: other.type, navigable: false, amount: e.amount, time: time, note: other.type === 'data' ? 'OP_RETURN' : 'non-standard output' });
          } else if (e.spentBy) {
            add(ID.tx(e.spentBy.txid), { id: ID.tx(e.spentBy.txid), type: 'tx', navigable: !!node(ID.tx(e.spentBy.txid)), amount: e.amount, time: time, via: other.id });
          } else if (other.type === 'addr') {
            add('unspent:' + other.id, { id: null, type: 'unspent', navigable: false, amount: e.amount, time: time, via: other.id, spent: e.spent === false ? false : null,
                                         note: e.spent === false ? 'unspent so far' : 'spender not known yet' });
          } else {
            add(other.id, { id: null, type: other.type, navigable: false, amount: e.amount, time: time, note: other.type === 'data' ? 'OP_RETURN' : 'non-standard output' });
          }
        }
      } else if (n.type === 'addr') {
        if (dir === 'prev' && e.kind === 'out' && e.target === id) {                         // a transaction paid this wallet
          other = node(e.source); if (!other) return;
          add(other.id, { id: other.id, type: 'tx', navigable: true, amount: e.amount, time: time });
        } else if (dir === 'next' && e.kind === 'in' && e.source === id) {                   // a transaction spent from this wallet
          other = node(e.target); if (!other) return;
          add(other.id, { id: other.id, type: 'tx', navigable: true, amount: e.amount, time: time });
        } else if (dir === 'next' && e.kind === 'out' && e.target === id && e.spent === false) {
          add('unspent:' + e.id, { id: null, type: 'unspent', navigable: false, amount: e.amount, time: time, spent: false, note: 'unspent so far' });
        }
      }
    });

    var out = Array.from(rows.values());
    out.sort(function (a, b) {
      if (a.navigable !== b.navigable) return a.navigable ? -1 : 1;
      if (b.amount !== a.amount) return b.amount - a.amount;
      return (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time);
    });
    return out;
  }

  /** Counts of things you can move to, for the buttons. */
  function counts(graph, id, opts) {
    var p = neighbours(graph, id, 'prev', opts), n = neighbours(graph, id, 'next', opts);
    return { prev: p.filter(function (r) { return r.navigable; }).length, next: n.filter(function (r) { return r.navigable; }).length,
             prevInfo: p.length, nextInfo: n.length };
  }

  /** Why a direction is empty, for the disabled button's tooltip. */
  function emptyReason(graph, id, dir, opts) {
    var n = graph.nodes.get(id);
    if (!n) return 'Nothing selected';
    var rows = neighbours(graph, id, dir, opts);
    if (rows.some(function (r) { return r.type === 'coinbase'; })) return 'Coinbase: newly created coins, nothing before this';
    if (rows.some(function (r) { return r.type === 'unspent'; })) return 'Unspent so far: the coins have not moved';
    if (n.type === 'tx' && n.loaded === false) return 'Not loaded yet: move to this transaction first';
    if (n.type === 'tx' && dir === 'next' && !n.outspendsLoaded) return 'Spending information not loaded yet';
    if (n.type === 'addr' && n.txCount == null) return 'History of this wallet is not loaded: use Load history';
    return dir === 'prev' ? 'Nothing before this in what is loaded' : 'Nothing after this in what is loaded';
  }

  return { neighbours: neighbours, counts: counts, emptyReason: emptyReason };
}));
