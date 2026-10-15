/*
 * Orion layouts. Each takes (graph, visible, opts) and returns
 *   { pos: Map<id,{x,y}>, axis: null | { tMin, tMax, x0, x1, pendingX } }
 * x grows to the right, y downwards. Pure functions; deterministic for the same input.
 *
 *   flow      left-to-right in the direction money moves, ordered to reduce crossings
 *   timeline  x = confirmation time, y = lanes packed so nothing overlaps
 *   force     spring layout; starts from existing positions so it can be re-run to tidy up
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionLayout = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // deterministic PRNG (mulberry32) so layouts and tests are repeatable
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function visibleEdges(graph, visible) {
    var out = [];
    visible.edges.forEach(function (id) { out.push(graph.edges.get(id)); });
    return out;
  }

  // ---- flow -----------------------------------------------------------------------------------
  function layoutFlow(graph, visible, opts) {
    opts = opts || {};
    var dx = opts.layerGap || 170, dy = opts.rowGap || 46;
    var ids = Array.from(visible.nodes), edges = visibleEdges(graph, visible);
    var preds = new Map(), succs = new Map();
    ids.forEach(function (id) { preds.set(id, []); succs.set(id, []); });
    edges.forEach(function (e) { succs.get(e.source).push(e.target); preds.get(e.target).push(e.source); });

    // longest-path layering (Kahn). Address reuse makes real data cyclic (an address that is spent from and paid
    // change to its own address), so when the queue runs dry the node with the fewest unresolved inputs is
    // released and its remaining inbound edges are treated as back edges.
    var layer = new Map(), indeg = new Map(), queue = [], done = new Set();
    ids.forEach(function (id) { indeg.set(id, preds.get(id).length); layer.set(id, 0); if (!indeg.get(id)) queue.push(id); });
    var sortedIds = ids.slice().sort();
    while (done.size < ids.length) {
      if (!queue.length) {
        var pick = null;
        sortedIds.forEach(function (id) { if (!done.has(id) && (pick == null || indeg.get(id) < indeg.get(pick))) pick = id; });
        queue.push(pick);
      }
      var u = queue.shift();
      if (done.has(u)) continue;
      done.add(u);
      succs.get(u).forEach(function (v) {
        if (done.has(v)) return;                                    // back edge
        if (layer.get(u) + 1 > layer.get(v)) layer.set(v, layer.get(u) + 1);
        indeg.set(v, indeg.get(v) - 1);
        if (!indeg.get(v)) queue.push(v);
      });
    }

    var cols = new Map();
    ids.forEach(function (id) { var l = layer.get(id); if (!cols.has(l)) cols.set(l, []); cols.get(l).push(id); });
    var order = Array.from(cols.keys()).sort(function (a, b) { return a - b; });

    // initial order: stable by id; then barycentre sweeps down and up
    var rank = new Map();
    order.forEach(function (l) { cols.get(l).sort(); cols.get(l).forEach(function (id, i) { rank.set(id, i); }); });
    function bary(id, nbrs) {
      var xs = nbrs.get(id).map(function (n) { return rank.get(n); });
      return xs.length ? xs.reduce(function (a, b) { return a + b; }, 0) / xs.length : rank.get(id);
    }
    for (var sweep = 0; sweep < 4; sweep++) {
      var seq = sweep % 2 === 0 ? order : order.slice().reverse(), nb = sweep % 2 === 0 ? preds : succs;
      seq.forEach(function (l) {
        var col = cols.get(l);
        var keyed = col.map(function (id) { return { id: id, k: bary(id, nb) }; });
        keyed.sort(function (a, b) { return a.k - b.k || (a.id < b.id ? -1 : 1); });
        col.length = 0; keyed.forEach(function (o, i) { col.push(o.id); rank.set(o.id, i); });
      });
    }

    var pos = new Map();
    order.forEach(function (l, ci) {
      var col = cols.get(l), h = (col.length - 1) * dy;
      col.forEach(function (id, i) { pos.set(id, { x: ci * dx, y: i * dy - h / 2 }); });
    });
    return { pos: pos, axis: null };
  }

  // ---- timeline -------------------------------------------------------------------------------
  /**
   * Maps times to x. 'proportional': x is linear in time. 'compact': gaps are limited to `cap` pixels (and spacing
   * between distinct times to at least `minPx`), so one outlier years later cannot squash a burst of activity into
   * a few pixels. Compressed gaps are reported in `breaks` so the axis can mark them honestly.
   */
  function timeMapper(times, mode, width, minPx, cap) {
    var ts = Array.from(new Set(times)).sort(function (a, b) { return a - b; });
    var tMin = ts.length ? ts[0] : 0, tMax = ts.length ? ts[ts.length - 1] : 0;
    var res = { tMin: tMin, tMax: tMax, mode: mode, pxPerSec: 0, knots: [], breaks: [], x1: 0 };
    if (ts.length < 2) { res.knots = ts.map(function (t) { return { t: t, x: 0 }; }); res.xOf = function () { return 0; }; return res; }
    var span = tMax - tMin, pps = width / span;
    if (mode !== 'compact') {
      res.pxPerSec = pps; res.x1 = width;
      res.knots = ts.map(function (t) { return { t: t, x: (t - tMin) * pps }; });
      res.xOf = function (t) { return (t - tMin) * pps; };
      return res;
    }
    // A gap is "long" when it is more than 8x the median gap. Long gaps are squeezed to `cap` pixels; the rest share
    // the remaining width in proportion to elapsed time (never narrower than minPx, so neighbours stay apart).
    var dts = ts.slice(1).map(function (t, i) { return t - ts[i]; });
    var sorted = dts.slice().sort(function (a, b) { return a - b; });
    var median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    var longGap = dts.map(function (d) { return d > 8 * median; });
    var nLong = longGap.filter(Boolean).length;
    var normalSeconds = dts.reduce(function (s, d, i) { return longGap[i] ? s : s + d; }, 0);
    pps = Math.max(width - nLong * cap, width / 2) / normalSeconds;
    var w = dts.map(function (d, i) { return longGap[i] ? Math.min(cap, d * pps) : Math.max(minPx, d * pps); }), x = [0];
    w.forEach(function (d) { x.push(x[x.length - 1] + d); });
    res.pxPerSec = pps; res.x1 = x[x.length - 1];
    res.knots = ts.map(function (t, i) { return { t: t, x: x[i] }; });
    dts.forEach(function (d, i) { if (longGap[i]) res.breaks.push({ x0: x[i], x1: x[i + 1], seconds: d, t0: ts[i], t1: ts[i + 1] }); });
    res.xOf = function (t) {
      if (t <= tMin) return 0;
      if (t >= tMax) return res.x1;
      var lo = 0, hi = ts.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
      return x[lo] + (t - ts[lo]) / (ts[hi] - ts[lo]) * (x[hi] - x[lo]);
    };
    return res;
  }

  function layoutTimeline(graph, visible, opts) {
    opts = opts || {};
    var width = opts.width || 1600, gap = opts.gap || 70, laneH = opts.laneHeight || 40, minSep = opts.minSep || 54;
    var ids = Array.from(visible.nodes), edges = visibleEdges(graph, visible);

    var times = [];
    ids.forEach(function (id) { var n = graph.nodes.get(id); if (n.type === 'tx' && n.time != null) times.push(n.time); });
    var tm = timeMapper(times, opts.scale === 'compact' ? 'compact' : 'proportional', width, opts.minPx || 40, opts.gapCap || Math.max(120, width * 0.1));
    var tMin = tm.tMin, tMax = tm.tMax, xOf = tm.xOf;
    var pendingX = tm.x1 + gap * 1.5;

    var adjacent = new Map();
    ids.forEach(function (id) { adjacent.set(id, []); });
    edges.forEach(function (e) { adjacent.get(e.source).push(e.target); adjacent.get(e.target).push(e.source); });

    var x = new Map();
    // 1. transactions with a known time
    ids.forEach(function (id) {
      var n = graph.nodes.get(id);
      if (n.type === 'tx') {
        if (n.time != null) x.set(id, xOf(n.time));
        else if (n.confirmed === false) x.set(id, pendingX);
      }
    });
    // 2. other vertices sit between the transaction that creates them and the one that spends them
    var order = ids.filter(function (id) { return !x.has(id); }).sort();
    function resolve(id) {
      var n = graph.nodes.get(id), before = [], after = [];
      graph.edgesOf(id).forEach(function (e) {
        if (!visible.edges.has(e.id)) return;
        if (e.target === id) { var s = x.get(e.source); if (s != null) before.push(s); }
        else { var t = x.get(e.target); if (t != null) after.push(t); }
      });
      if (before.length && after.length) return (Math.max.apply(null, before) + Math.min.apply(null, after)) / 2;
      if (before.length) return Math.max.apply(null, before) + gap;
      if (after.length) return Math.min.apply(null, after) - gap;
      return null;
    }
    // addresses/data/coinbase first (they hang off transactions), then unknown-time stubs, repeated until stable
    for (var pass = 0; pass < 4; pass++) {
      order.forEach(function (id) {
        if (x.has(id)) return;
        var v = resolve(id);
        if (v != null) x.set(id, v);
      });
    }
    var fallback = 0;
    order.forEach(function (id) { if (!x.has(id)) { x.set(id, fallback); fallback += gap; } });

    // 3. lane packing: left to right, each vertex takes the free lane closest to where its neighbours are
    var sorted = ids.slice().sort(function (a, b) { return x.get(a) - x.get(b) || (a < b ? -1 : 1); });
    var laneEnd = [];                    // lane index (0, 1, -1, 2, -2 ... mapped to slots) -> last x used
    var laneOf = new Map();
    function slotToLane(k) { return k % 2 === 0 ? k / 2 : -(k + 1) / 2; }
    function laneToSlot(l) { return l >= 0 ? l * 2 : -l * 2 - 1; }
    sorted.forEach(function (id) {
      var placed = adjacent.get(id).filter(function (n) { return laneOf.has(n); }).map(function (n) { return laneOf.get(n); });
      var want = placed.length ? Math.round(placed.reduce(function (a, b) { return a + b; }, 0) / placed.length) : 0;
      var best = null;
      for (var d = 0; d < sorted.length + 2 && best == null; d++) {
        var cands = d === 0 ? [want] : [want + d, want - d];
        for (var c = 0; c < cands.length; c++) {
          var slot = laneToSlot(cands[c]);
          if (laneEnd[slot] == null || x.get(id) - laneEnd[slot] >= minSep) { best = cands[c]; break; }
        }
      }
      laneEnd[laneToSlot(best)] = x.get(id);
      laneOf.set(id, best);
    });

    var pos = new Map();
    ids.forEach(function (id) { pos.set(id, { x: x.get(id), y: laneOf.get(id) * laneH }); });
    return { pos: pos, axis: { tMin: tMin, tMax: tMax, x0: 0, x1: tm.x1, pendingX: pendingX, pxPerSec: tm.pxPerSec, mode: tm.mode, knots: tm.knots, breaks: tm.breaks, xOf: xOf,
                               hasPending: ids.some(function (id) { var n = graph.nodes.get(id); return n.type === 'tx' && n.time == null && n.confirmed === false; }) } };
  }

  // ---- force ----------------------------------------------------------------------------------
  function layoutForce(graph, visible, opts) {
    opts = opts || {};
    var ids = Array.from(visible.nodes).sort(), edges = visibleEdges(graph, visible);
    var n = ids.length, rand = rng(opts.seed == null ? 1 : opts.seed);
    var k = opts.spacing || 70;
    var idx = new Map(); ids.forEach(function (id, i) { idx.set(id, i); });
    var px = new Float64Array(n), py = new Float64Array(n), dxs = new Float64Array(n), dys = new Float64Array(n);
    var start = opts.start;                                           // Map id -> {x,y}: continue from where things are
    ids.forEach(function (id, i) {
      var p = start && start.get(id);
      if (p) { px[i] = p.x; py[i] = p.y; }
      else { var r = k * Math.sqrt(n) * 0.5 * rand(), a = rand() * Math.PI * 2; px[i] = Math.cos(a) * r; py[i] = Math.sin(a) * r; }
    });
    var links = edges.map(function (e) { return [idx.get(e.source), idx.get(e.target)]; });
    var iters = opts.iterations || Math.max(n > 2000 ? 10 : 30, Math.min(300, Math.floor(4e7 / Math.max(1, n * n))));
    var temp = k * 3, cool = temp / (iters + 1);
    for (var it = 0; it < iters; it++) {
      dxs.fill(0); dys.fill(0);
      for (var i = 0; i < n; i++) {
        for (var j = i + 1; j < n; j++) {
          var ddx = px[i] - px[j], ddy = py[i] - py[j];
          var d2 = ddx * ddx + ddy * ddy;
          if (d2 < 0.01) { ddx = rand() - 0.5; ddy = rand() - 0.5; d2 = ddx * ddx + ddy * ddy + 0.01; }
          var f = (k * k) / d2;                                       // repulsion ~ k^2/d, applied along the unit vector
          dxs[i] += ddx * f; dys[i] += ddy * f; dxs[j] -= ddx * f; dys[j] -= ddy * f;
        }
      }
      links.forEach(function (l) {
        var a = l[0], b = l[1], ex = px[a] - px[b], ey = py[a] - py[b];
        var d = Math.sqrt(ex * ex + ey * ey) || 0.01, f = d / k;      // attraction ~ d^2/k along the unit vector
        dxs[a] -= ex * f; dys[a] -= ey * f; dxs[b] += ex * f; dys[b] += ey * f;
      });
      for (var m = 0; m < n; m++) {                                    // gentle pull to the centre keeps components together
        dxs[m] -= px[m] * 0.06; dys[m] -= py[m] * 0.06;
        var len = Math.sqrt(dxs[m] * dxs[m] + dys[m] * dys[m]) || 0.01, step = Math.min(len, temp);
        px[m] += dxs[m] / len * step; py[m] += dys[m] / len * step;
      }
      temp -= cool;
    }
    var pos = new Map();
    ids.forEach(function (id, i) { pos.set(id, { x: px[i], y: py[i] }); });
    return { pos: pos, axis: null };
  }

  function layout(name, graph, visible, opts) {
    if (name === 'timeline') return layoutTimeline(graph, visible, opts);
    if (name === 'force') return layoutForce(graph, visible, opts);
    return layoutFlow(graph, visible, opts);
  }

  /** Bounding box of positions: {minX,minY,maxX,maxY}; null if empty. */
  function bounds(pos) {
    var b = null;
    pos.forEach(function (p) {
      if (!b) b = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      else { if (p.x < b.minX) b.minX = p.x; if (p.x > b.maxX) b.maxX = p.x; if (p.y < b.minY) b.minY = p.y; if (p.y > b.maxY) b.maxY = p.y; }
    });
    return b;
  }

  return { layout: layout, timeMapper: timeMapper, layoutFlow: layoutFlow, layoutTimeline: layoutTimeline, layoutForce: layoutForce, bounds: bounds, rng: rng };
}));
