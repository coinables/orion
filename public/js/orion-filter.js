/*
 * Orion filters: decide which vertices and edges are shown. Pure functions, no DOM.
 *
 * state = {
 *   timeFrom, timeTo      unix seconds, null = unbounded. Applies to the TRANSACTION an edge belongs to.
 *   includePending        show unconfirmed transactions            (default true)
 *   includeUnknownTime    show transactions whose time is unknown  (default true)
 *   minAmount             satoshis; edges below it are hidden (dust filter)
 *   maxAmount             satoshis; null = no upper bound
 *   hiddenScriptTypes     array of script types whose addresses are hidden
 *   showData, showNonstd  show OP_RETURN / non-standard outputs    (default true)
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionFilter = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function defaults() {
    return { timeFrom: null, timeTo: null, includePending: true, includeUnknownTime: true,
             minAmount: 0, maxAmount: null, hiddenScriptTypes: [], showData: true, showNonstd: true };
  }

  function normalise(state) {
    var d = defaults(), s = state || {};
    Object.keys(d).forEach(function (k) { if (s[k] !== undefined) d[k] = s[k]; });
    return d;
  }

  /** The transaction vertex an edge belongs to (the source of an output edge, the target of an input edge). */
  function txOfEdge(graph, e) {
    return graph.nodes.get(e.kind === 'out' ? e.source : e.target);
  }

  /** The time an edge is shown at: the time of its transaction, else the edge's own. null when unknown. */
  function edgeTime(graph, e) {
    var tx = txOfEdge(graph, e);
    if (tx && tx.time != null) return tx.time;
    return e.time != null ? e.time : null;
  }

  function timePasses(f, time, confirmed) {
    if (time == null) return confirmed === false ? f.includePending : f.includeUnknownTime;
    if (f.timeFrom != null && time < f.timeFrom) return false;
    if (f.timeTo != null && time > f.timeTo) return false;
    return true;
  }

  /**
   * Narrow a visible set to the neighbourhood of one vertex: everything within `hops` steps along the edges that
   * survived the other filters (so a dust edge that is hidden cannot be walked through), plus the edges among
   * those vertices. Returns the new { nodes, edges }, or the input unchanged when the vertex is not in it.
   */
  function applyFocus(graph, nodes, edges, focus) {
    if (!focus || !nodes.has(focus.id)) return { nodes: nodes, edges: edges };
    var depth = new Map([[focus.id, 0]]), queue = [focus.id], hops = Math.max(0, focus.hops == null ? 2 : focus.hops);
    while (queue.length) {
      var u = queue.shift(), d = depth.get(u);
      if (d >= hops) continue;
      var adj = graph.adj.get(u);
      if (!adj) continue;
      adj.forEach(function (eid) {
        if (!edges.has(eid)) return;
        var e = graph.edges.get(eid), v = e.source === u ? e.target : e.source;
        if (!depth.has(v)) { depth.set(v, d + 1); queue.push(v); }
      });
    }
    var n2 = new Set(depth.keys()), e2 = new Set();
    edges.forEach(function (eid) { var e = graph.edges.get(eid); if (n2.has(e.source) && n2.has(e.target)) e2.add(eid); });
    return { nodes: n2, edges: e2, depth: depth };
  }

  /**
   * Returns { nodes:Set, edges:Set, hiddenEdges:number, hiddenNodes:number }.
   * `keep` = ids that stay visible even with no visible edge (the vertices the user searched for).
   * `focus` = { id, hops } limits the result to that vertex's neighbourhood (applied after every other filter).
   */
  function computeVisible(graph, state, keep, focus) {
    var f = normalise(state), hiddenTypes = new Set(f.hiddenScriptTypes || []);
    var nodes = new Set(), edges = new Set();

    function nodeAllowed(n) {
      if (!n) return false;
      if (n.type === 'data') return f.showData;
      if (n.type === 'nonstd') return f.showNonstd;
      if (n.type === 'addr' && n.scriptType && hiddenTypes.has(n.scriptType)) return false;
      return true;
    }

    // Pass 1: edges whose transaction time is known (or pending). Pass 2: edges of transactions whose time is
    // unknown (unloaded funding/spending stubs) - shown only while the time range is open, or when the
    // address they touch is already on screen through a transaction that passed the range.
    var unknownEdges = [];
    var bounded = f.timeFrom != null || f.timeTo != null;

    function edgeBase(e) {
      var s = graph.nodes.get(e.source), t = graph.nodes.get(e.target), tx = txOfEdge(graph, e);
      if (!s || !t || !tx) return null;
      if (e.amount < f.minAmount) return null;
      if (f.maxAmount != null && e.amount > f.maxAmount) return null;
      if (!nodeAllowed(s) || !nodeAllowed(t)) return null;
      return { s: s, t: t, tx: tx };
    }
    function accept(e) { edges.add(e.id); nodes.add(e.source); nodes.add(e.target); }

    graph.edges.forEach(function (e) {
      var b = edgeBase(e);
      if (!b) return;
      var time = edgeTime(graph, e);
      if (time == null && b.tx.confirmed !== false) {                 // unknown time, not pending
        if (!f.includeUnknownTime) return;
        if (bounded) unknownEdges.push(e); else accept(e);
        return;
      }
      if (timePasses(f, time, b.tx.confirmed)) accept(e);
    });
    unknownEdges.forEach(function (e) {
      var other = e.kind === 'out' ? e.target : e.source;               // the vertex that is not the transaction
      if (nodes.has(other)) accept(e);
    });

    if (keep) keep.forEach(function (id) { if (graph.nodes.has(id) && nodeAllowed(graph.nodes.get(id))) nodes.add(id); });
    if (focus) { var fx = applyFocus(graph, nodes, edges, focus); nodes = fx.nodes; edges = fx.edges; }
    return { nodes: nodes, edges: edges, hiddenNodes: graph.nodes.size - nodes.size, hiddenEdges: graph.edges.size - edges.size };
  }

  /** Smallest and largest edge amount (of the edges in `only` when given), for the dust slider's range. */
  function amountRange(graph, only) {
    var min = null, max = null;
    graph.edges.forEach(function (e) {
      if (only && !only.has(e.id)) return;
      if (min == null || e.amount < min) min = e.amount;
      if (max == null || e.amount > max) max = e.amount;
    });
    return { min: min == null ? 0 : min, max: max == null ? 0 : max };
  }

  /** Script types present on address vertices, with counts, for the legend and the script filter. */
  function scriptTypeCounts(graph) {
    var c = {};
    graph.nodes.forEach(function (n) { if (n.type === 'addr' && n.scriptType) c[n.scriptType] = (c[n.scriptType] || 0) + 1; });
    return c;
  }

  return { defaults: defaults, normalise: normalise, computeVisible: computeVisible, applyFocus: applyFocus, edgeTime: edgeTime,
           timePasses: timePasses, amountRange: amountRange, scriptTypeCounts: scriptTypeCounts };
}));
