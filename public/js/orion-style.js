/*
 * Orion visual encoding: size, width and colour from data. Pure functions, no DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionStyle = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCRIPT_COLORS = {
    p2pkh: '#e0a458', p2sh: '#9b7fe6', v0_p2wpkh: '#4cc3a1', v0_p2wsh: '#2f9e8f',
    v1_p2tr: '#f06292', p2pk: '#c9b458', multisig: '#d98cc0', op_return: '#9aa3ad',
    nonstandard: '#7c8794', unknown: '#7c8794'
  };
  var TYPE_COLORS = { tx: '#5b8def', addr: '#e0a458', coinbase: '#f2c94c', data: '#9aa3ad', nonstd: '#7c8794' };
  var UNKNOWN = '#6b7280';

  // old -> new: violet -> blue -> teal -> green -> yellow. Every stop is bright enough to read on the dark canvas.
  var AGE_STOPS = [[0.00, [150, 110, 255]], [0.25, [70, 150, 255]], [0.50, [40, 205, 185]], [0.75, [150, 225, 100]], [1.00, [255, 225, 80]]];

  function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  function rgb(a) { return 'rgb(' + Math.round(a[0]) + ',' + Math.round(a[1]) + ',' + Math.round(a[2]) + ')'; }

  /** 0 = oldest, 1 = newest -> CSS colour. */
  function ageColor(t) {
    if (t == null || isNaN(t)) return UNKNOWN;
    t = Math.max(0, Math.min(1, t));
    for (var i = 1; i < AGE_STOPS.length; i++) {
      if (t <= AGE_STOPS[i][0]) {
        var a = AGE_STOPS[i - 1], b = AGE_STOPS[i], k = (t - a[0]) / (b[0] - a[0]);
        return rgb([0, 1, 2].map(function (j) { return a[1][j] + (b[1][j] - a[1][j]) * k; }));
      }
    }
    return rgb(AGE_STOPS[AGE_STOPS.length - 1][1]);
  }

  /** Log scale: returns f(value) in 0..1 over [min,max]. Constant data maps to 0.5. */
  function logScale(min, max) {
    var lo = Math.log10(1 + Math.max(0, min)), hi = Math.log10(1 + Math.max(0, max));
    return function (v) {
      if (!(hi > lo)) return 0.5;
      var x = (Math.log10(1 + Math.max(0, v)) - lo) / (hi - lo);
      return Math.max(0, Math.min(1, x));
    };
  }

  function linScale(min, max) {
    return function (v) { return (max > min) ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0.5; };
  }

  /**
   * Builds the style functions for the currently visible part of the graph.
   * opts: { colorBy: 'type'|'age'|'script', minWidth, maxWidth, minRadius, maxRadius }
   */
  function makeStyle(graph, visible, opts) {
    opts = opts || {};
    var colorBy = opts.colorBy || 'type';
    var minW = opts.minWidth || 1, maxW = opts.maxWidth || 12, minR = opts.minRadius || 5, maxR = opts.maxRadius || 16;

    var aMin = null, aMax = null, tMin = null, tMax = null, vMin = null, vMax = null;
    visible.edges.forEach(function (id) {
      var e = graph.edges.get(id);
      if (aMin == null || e.amount < aMin) aMin = e.amount;
      if (aMax == null || e.amount > aMax) aMax = e.amount;
    });
    visible.nodes.forEach(function (id) {
      var n = graph.nodes.get(id);
      var t = n.type === 'tx' ? n.time : n.firstSeen;
      if (t != null) { if (tMin == null || t < tMin) tMin = t; if (tMax == null || t > tMax) tMax = t; }
      var v = n.type === 'tx' ? n.valueOut : n.received;
      if (v != null) { if (vMin == null || v < vMin) vMin = v; if (vMax == null || v > vMax) vMax = v; }
    });
    var amountScale = logScale(aMin || 0, aMax || 0), valueScale = logScale(vMin || 0, vMax || 0), timeScale = linScale(tMin, tMax);

    function nodeTime(n) { return n.type === 'tx' ? n.time : n.firstSeen; }

    return {
      edgeWidth: function (e) { return minW + (maxW - minW) * amountScale(e.amount); },
      nodeRadius: function (n) {
        if (n.type === 'coinbase') return (minR + maxR) / 2;
        var v = n.type === 'tx' ? n.valueOut : n.received;
        return v == null ? minR : minR + (maxR - minR) * valueScale(v);
      },
      nodeColor: function (n) {
        if (n.color && /^#[0-9a-fA-F]{6}$/.test(n.color)) return n.color;                    // your tag colour, in every colour mode
        if (colorBy === 'age') {
          var t = nodeTime(n);
          return t == null ? UNKNOWN : ageColor(timeScale(t));
        }
        if (colorBy === 'script') {
          if (n.type === 'tx') return TYPE_COLORS.tx;
          if (n.type === 'coinbase') return TYPE_COLORS.coinbase;
          return SCRIPT_COLORS[n.scriptType] || SCRIPT_COLORS.unknown;
        }
        return TYPE_COLORS[n.type] || UNKNOWN;
      },
      edgeColor: function (e) {
        if (colorBy === 'age') {
          var tx = graph.nodes.get(e.kind === 'out' ? e.source : e.target);
          var t = tx && tx.time != null ? tx.time : e.time;
          return t == null ? UNKNOWN : ageColor(timeScale(t));
        }
        return null;                       // renderer uses its neutral/selection colours
      },
      scale: { amountMin: aMin, amountMax: aMax, timeMin: tMin, timeMax: tMax }
    };
  }

  /** Legend entries for the current colour mode: [{label, color}] or, for age, a gradient description. */
  function legend(colorBy, presentScriptTypes) {
    if (colorBy === 'age') return { gradient: AGE_STOPS.map(function (s) { return [s[0], rgb(s[1])]; }), unknown: UNKNOWN };
    if (colorBy === 'script') {
      var types = (presentScriptTypes && presentScriptTypes.length) ? presentScriptTypes : Object.keys(SCRIPT_COLORS);
      return { items: types.map(function (t) { return { label: t, color: SCRIPT_COLORS[t] || SCRIPT_COLORS.unknown }; })
                           .concat([{ label: 'transaction', color: TYPE_COLORS.tx }, { label: 'coinbase', color: TYPE_COLORS.coinbase }]) };
    }
    return { items: [{ label: 'transaction', color: TYPE_COLORS.tx }, { label: 'address', color: TYPE_COLORS.addr },
                     { label: 'coinbase', color: TYPE_COLORS.coinbase }, { label: 'OP_RETURN data', color: TYPE_COLORS.data },
                     { label: 'non-standard output', color: TYPE_COLORS.nonstd }] };
  }

  // ---- formatting -----------------------------------------------------------------------------
  function fmtBtc(sats) {
    if (sats == null) return '?';
    var neg = sats < 0; sats = Math.abs(sats);
    var whole = Math.floor(sats / 1e8), frac = String(sats % 1e8); while (frac.length < 8) frac = '0' + frac;
    return (neg ? '-' : '') + whole + '.' + frac;
  }
  /** Compact amount for the canvas: "546 sat" below 10,000 sat, otherwise BTC without trailing zeros. */
  function fmtBtcShort(sats) {
    if (sats == null) return '?';
    if (sats < 10000) return String(sats).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' sat';
    return (sats / 1e8).toFixed(8).replace(/\.?0+$/, '') + ' BTC';
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  /** UTC always: investigators compare timestamps across time zones. */
  function fmtTime(unix, withTime) {
    if (unix == null) return '—';
    var d = new Date(unix * 1000);
    var s = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    return withTime === false ? s : s + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }
  function shortId(s, n) { n = n || 6; return s && s.length > 2 * n + 1 ? s.slice(0, n) + '…' + s.slice(-n) : (s || ''); }

  return { SCRIPT_COLORS: SCRIPT_COLORS, TYPE_COLORS: TYPE_COLORS, ageColor: ageColor, logScale: logScale, linScale: linScale,
           makeStyle: makeStyle, legend: legend, fmtBtc: fmtBtc, fmtBtcShort: fmtBtcShort, fmtTime: fmtTime, shortId: shortId };
}));
