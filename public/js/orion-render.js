/*
 * Orion Canvas 2D renderer: pan, zoom, drag, hover, selection, time axis, labels.
 * It draws what it is given (graph + visible set + positions + style) and reports interaction through callbacks.
 * No data is ever put into the DOM as HTML: everything is drawn on the canvas or handed to the host as plain values.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-style.js'));
  else root.OrionRender = factory(root.OrionStyle);
}(typeof self !== 'undefined' ? self : this, function (Style) {
  'use strict';

  var DAY = 86400;
  // [seconds, unit] - unit 'm' means calendar months, 'y' calendar years, otherwise seconds aligned to the epoch
  var STEPS = [[60, 's'], [300, 's'], [900, 's'], [3600, 's'], [3 * 3600, 's'], [6 * 3600, 's'], [12 * 3600, 's'], [DAY, 's'], [2 * DAY, 's'],
               [7 * DAY, 's'], [14 * DAY, 's'], [1, 'm'], [3, 'm'], [6, 'm'], [1, 'y'], [2, 'y'], [5, 'y'], [10, 'y'], [20, 'y']];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function labelFor(t, step) {
    var d = new Date(t * 1000), y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
    if (step[1] === 'y') return '' + y;
    if (step[1] === 'm') return y + '-' + mo;
    if (step[0] < DAY) return mo + '-' + da + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return y + '-' + mo + '-' + da;
  }

  /**
   * Axis ticks for a time span. pxPerSec is the SCREEN scale (world scale times zoom); minPx = least spacing.
   * Returns [{t, label}] sorted by t. Empty when the scale is degenerate.
   */
  function niceTicks(tMin, tMax, pxPerSec, minPx) {
    if (!(pxPerSec > 0) || !(tMax >= tMin)) return [];
    var step = STEPS[STEPS.length - 1];
    for (var i = 0; i < STEPS.length; i++) {
      var secs = STEPS[i][1] === 's' ? STEPS[i][0] : STEPS[i][1] === 'm' ? STEPS[i][0] * 30.4 * DAY : STEPS[i][0] * 365.25 * DAY;
      if (secs * pxPerSec >= minPx) { step = STEPS[i]; break; }
    }
    var out = [], t;
    if (step[1] === 's') {
      for (t = Math.ceil(tMin / step[0]) * step[0]; t <= tMax && out.length < 400; t += step[0]) out.push({ t: t, label: labelFor(t, step) });
    } else {
      var d = new Date(tMin * 1000), y = d.getUTCFullYear(), m = step[1] === 'y' ? 0 : d.getUTCMonth();
      var inc = step[1] === 'y' ? step[0] * 12 : step[0];
      if (step[1] === 'y') y = Math.floor(y / step[0]) * step[0]; else m = Math.floor(m / inc) * inc;
      var guard = 0;
      for (var months = y * 12 + m; guard < 400; months += inc, guard++) {
        t = Date.UTC(Math.floor(months / 12), months % 12, 1) / 1000;
        if (t > tMax) break;
        if (t >= tMin) out.push({ t: t, label: labelFor(t, step) });
      }
    }
    return out;
  }

  /** Distance from point p to segment ab (all {x,y}). */
  function distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    var t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function Renderer(canvas, callbacks) {
    var self = this;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks || {};
    this.view = { x: 0, y: 0, k: 1 };
    this.data = null;
    this.cur = new Map();
    this.target = new Map();
    this.anim = null;
    this.hover = { node: null, edge: null };
    this.insets = { bottom: 0 };              // canvas rows covered by overlays (the step bar): fit() and centerOn() keep clear of them
    this.autoFit = false;                     // true while the view is the result of fit(): it is then refitted when the canvas changes size
    this.selected = new Set();
    this.dirty = true;
    this.dpr = 1;
    this.drag = null;
    this.theme = { bg: '#1c141d', text: '#f2f2f2', dim: '#8d7f8d', grid: 'rgba(242,242,242,0.07)', edge: 'rgba(174,231,248,0.42)', accent: '#AEE7F8', select: '#ffffff', known: '#f2c94c' };

    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', function (e) { self._down(e); });
    canvas.addEventListener('pointermove', function (e) { self._move(e); });
    canvas.addEventListener('pointerup', function (e) { self._up(e); });
    canvas.addEventListener('pointercancel', function (e) { self._up(e, true); });
    canvas.addEventListener('pointerleave', function () { if (!self.drag) self._setHover(null, null, null); });
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); self._wheel(e); }, { passive: false });
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var h = self._pick(self._local(e));
      if (self.cb.onContext) self.cb.onContext(h.node, h.edge, { x: e.clientX, y: e.clientY });
    });
    canvas.addEventListener('dblclick', function (e) {
      var h = self._pick(self._local(e));
      if (h.node && self.cb.onExpand) self.cb.onExpand(h.node);
    });
    this.resize();
    (function loop() { self._frame(); (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : setTimeout)(loop, 16); })();
  }

  Renderer.prototype.resize = function () {
    var r = this.canvas.getBoundingClientRect(), oldW = this.w, oldH = this.h;
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.w = Math.max(1, Math.round(r.width)); this.h = Math.max(1, Math.round(r.height));
    if (oldW && oldH) { this.view.x += (this.w - oldW) / 2; this.view.y += (this.h - oldH) / 2; }   // what was in the middle stays in the middle
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.dirty = true;
  };

  Renderer.prototype.invalidate = function () { this.dirty = true; };

  /** d = { graph, visible, style, known, axis, range:{from,to}, showLabels } */
  Renderer.prototype.setData = function (d) { this.data = d; this.dirty = true; };

  Renderer.prototype.setSelection = function (ids) { this.selected = new Set(ids || []); this.dirty = true; };

  /** Move the displayed positions to `pos`; animated unless `instant`. Vertices not in `pos` keep their old place. */
  Renderer.prototype.setPositions = function (pos, instant) {
    var self = this, fresh = new Map();
    pos.forEach(function (p, id) { fresh.set(id, { x: p.x, y: p.y }); });
    if (instant || !this.cur.size) {
      this.cur = fresh; this.target = new Map(); this.anim = null;
    } else {
      // vertices that appear for the first time start at a neighbour (or their target) instead of flying in from the origin
      fresh.forEach(function (p, id) { if (!self.cur.has(id)) self.cur.set(id, { x: p.x, y: p.y }); });
      var from = new Map(); self.cur.forEach(function (p, id) { from.set(id, { x: p.x, y: p.y }); });
      this.target = fresh; this.anim = { t0: performance.now(), ms: 350, from: from };
    }
    this.dirty = true;
  };

  Renderer.prototype.positionOf = function (id) { return this.cur.get(id) || null; };

  Renderer.prototype.fit = function (padding) {
    if (!this.data) return;
    var rect = this.canvas.getBoundingClientRect();                      // panels may have opened since the last resize event
    if (Math.round(rect.width) !== this.w || Math.round(rect.height) !== this.h) this.resize();
    var pad = padding == null ? 60 : padding, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false, self = this;
    var src = this.anim && this.target.size ? this.target : this.cur;
    this.data.visible.nodes.forEach(function (id) {
      var p = src.get(id) || self.cur.get(id); if (!p) return; any = true;
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    });
    this.autoFit = true;
    if (!any) { this.view = { x: this.w / 2, y: this.h / 2, k: 1 }; this.dirty = true; return; }
    var bw = Math.max(maxX - minX, 1), bh = Math.max(maxY - minY, 1);
    var availH = Math.max(80, this.h - (this.insets.bottom || 0));
    var k = Math.min((this.w - 2 * pad) / bw, (availH - 2 * pad) / bh, 2.2);
    k = Math.max(k, 0.05);
    this.view = { k: k, x: this.w / 2 - (minX + bw / 2) * k, y: availH / 2 - (minY + bh / 2) * k };
    this.dirty = true;
  };

  /** Pan so a vertex is in the middle, keeping the zoom. */
  Renderer.prototype.centerOn = function (id) {
    var p = this.target.get(id) || this.cur.get(id);
    if (!p) return;
    this.view.x = this.w / 2 - p.x * this.view.k; this.view.y = (this.h - (this.insets.bottom || 0)) / 2 - p.y * this.view.k; this.dirty = true; this.autoFit = false;
  };

  Renderer.prototype.zoomBy = function (factor, cx, cy) {
    var v = this.view, k = Math.max(0.03, Math.min(6, v.k * factor));
    cx = cx == null ? this.w / 2 : cx; cy = cy == null ? this.h / 2 : cy;
    v.x = cx - (cx - v.x) * (k / v.k); v.y = cy - (cy - v.y) * (k / v.k); v.k = k;
    this.dirty = true; this.autoFit = false;
  };

  // ---- coordinates ----------------------------------------------------------------------------
  Renderer.prototype._local = function (e) { var r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  Renderer.prototype._toWorld = function (p) { return { x: (p.x - this.view.x) / this.view.k, y: (p.y - this.view.y) / this.view.k }; };
  Renderer.prototype._toScreen = function (p) { return { x: p.x * this.view.k + this.view.x, y: p.y * this.view.k + this.view.y }; };
  Renderer.prototype._scale = function () { return Math.max(0.6, Math.min(1.7, this.view.k)); };

  // ---- picking --------------------------------------------------------------------------------
  Renderer.prototype._pick = function (pt) {
    var d = this.data; if (!d) return { node: null, edge: null };
    var self = this, s = this._scale(), best = null, bestD = Infinity;
    d.visible.nodes.forEach(function (id) {
      var p = self.cur.get(id); if (!p) return;
      var sp = self._toScreen(p), r = d.style.nodeRadius(d.graph.nodes.get(id)) * s + 3, dist = Math.hypot(pt.x - sp.x, pt.y - sp.y);
      if (dist <= r && dist < bestD) { best = id; bestD = dist; }
    });
    if (best) return { node: best, edge: null };
    var bestE = null; bestD = Infinity;
    d.visible.edges.forEach(function (id) {
      var e = d.graph.edges.get(id), a = self.cur.get(e.source), b = self.cur.get(e.target); if (!a || !b) return;
      var dist = distToSegment(pt, self._toScreen(a), self._toScreen(b)), tol = Math.max(4, d.style.edgeWidth(e) * s / 2 + 3);
      if (dist <= tol && dist < bestD) { bestE = id; bestD = dist; }
    });
    return { node: null, edge: bestE };
  };

  Renderer.prototype._setHover = function (node, edge, evt) {
    if (this.hover.node !== node || this.hover.edge !== edge) { this.hover = { node: node, edge: edge }; this.dirty = true; }
    if (this.cb.onHover) this.cb.onHover(node, edge, evt ? { x: evt.clientX, y: evt.clientY } : null);
  };

  // ---- interaction ----------------------------------------------------------------------------
  Renderer.prototype._down = function (e) {
    if (e.button !== 0) return;
    var pt = this._local(e), h = this._pick(pt);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (x) { /* synthetic events */ }
    this.drag = { id: h.node, edge: h.edge, start: pt, last: pt, moved: false, view0: { x: this.view.x, y: this.view.y }, shift: e.shiftKey || e.ctrlKey || e.metaKey };
  };

  Renderer.prototype._move = function (e) {
    var pt = this._local(e), d = this.drag;
    if (!d) { var h = this._pick(pt); this._setHover(h.node, h.edge, e); this.canvas.style.cursor = h.node ? 'pointer' : (h.edge ? 'help' : 'grab'); return; }
    if (!d.moved && Math.hypot(pt.x - d.start.x, pt.y - d.start.y) < 4) return;
    d.moved = true;
    if (!d.id) this.autoFit = false;                                  // the user is panning
    if (d.id) {
      var w = this._toWorld(pt), p = this.cur.get(d.id);
      if (p) { p.x = w.x; p.y = w.y; }
      var t = this.target.get(d.id); if (t) { t.x = w.x; t.y = w.y; }
      this.canvas.style.cursor = 'grabbing';
    } else {
      this.view.x = d.view0.x + (pt.x - d.start.x); this.view.y = d.view0.y + (pt.y - d.start.y);
      this.canvas.style.cursor = 'grabbing';
    }
    this.dirty = true;
  };

  Renderer.prototype._up = function (e, cancelled) {
    var d = this.drag; this.drag = null;
    if (!d) return;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    this.canvas.style.cursor = 'grab';
    if (cancelled) return;
    if (d.moved && d.id) { if (this.cb.onMove) this.cb.onMove(d.id, { x: this.cur.get(d.id).x, y: this.cur.get(d.id).y }); return; }
    if (d.moved) return;
    if (d.id) { if (this.cb.onSelect) this.cb.onSelect(d.id, d.shift); }
    else if (d.edge) { if (this.cb.onSelectEdge) this.cb.onSelectEdge(d.edge); }
    else if (this.cb.onSelect) this.cb.onSelect(null, false);
  };

  Renderer.prototype._wheel = function (e) {
    var pt = this._local(e);
    this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), pt.x, pt.y);
  };

  // ---- drawing --------------------------------------------------------------------------------
  Renderer.prototype._frame = function () {
    if (this.anim) {
      var t = Math.min(1, (performance.now() - this.anim.t0) / this.anim.ms), k = 1 - Math.pow(1 - t, 3), self = this;
      this.target.forEach(function (to, id) {
        var from = self.anim.from.get(id) || to, p = self.cur.get(id);
        if (!p) { p = { x: to.x, y: to.y }; self.cur.set(id, p); }
        p.x = from.x + (to.x - from.x) * k; p.y = from.y + (to.y - from.y) * k;
      });
      if (t >= 1) { this.anim = null; this.target = new Map(); }
      this.dirty = true;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  };

  function neighbourhood(graph, ids) {
    var out = new Set();
    ids.forEach(function (id) {
      out.add(id);
      graph.edgesOf(id).forEach(function (e) { out.add(e.source); out.add(e.target); });
    });
    return out;
  }

  // the shape a vertex is drawn with: its own choice (a tag), otherwise by what it is
  var DEFAULT_SHAPE = { tx: 'square', coinbase: 'diamond', data: 'hexagon' };
  function kindOf(n) { return n.shape || DEFAULT_SHAPE[n.type] || 'circle'; }

  function shape(ctx, kind, x, y, r) {
    var i, a;
    ctx.beginPath();
    if (kind === 'square') {
      var q = r * 0.85, c = r * 0.3;
      ctx.moveTo(x - q + c, y - q); ctx.lineTo(x + q - c, y - q); ctx.quadraticCurveTo(x + q, y - q, x + q, y - q + c);
      ctx.lineTo(x + q, y + q - c); ctx.quadraticCurveTo(x + q, y + q, x + q - c, y + q);
      ctx.lineTo(x - q + c, y + q); ctx.quadraticCurveTo(x - q, y + q, x - q, y + q - c);
      ctx.lineTo(x - q, y - q + c); ctx.quadraticCurveTo(x - q, y - q, x - q + c, y - q);
    } else if (kind === 'diamond') {
      ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.15, y); ctx.lineTo(x, y + r * 1.15); ctx.lineTo(x - r * 1.15, y);
    } else if (kind === 'hexagon') {
      for (i = 0; i < 6; i++) { a = Math.PI / 3 * i + Math.PI / 6; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    } else if (kind === 'triangle') {
      ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.1, y + r * 0.8); ctx.lineTo(x - r * 1.1, y + r * 0.8);
    } else if (kind === 'star') {
      for (i = 0; i < 10; i++) { a = -Math.PI / 2 + Math.PI / 5 * i; var rr = i % 2 ? r * 0.55 : r * 1.25; ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
    } else if (kind === 'cross') {
      var L = r * 1.15, w = r * 0.42;
      ctx.moveTo(x - w, y - L); ctx.lineTo(x + w, y - L); ctx.lineTo(x + w, y - w); ctx.lineTo(x + L, y - w); ctx.lineTo(x + L, y + w); ctx.lineTo(x + w, y + w);
      ctx.lineTo(x + w, y + L); ctx.lineTo(x - w, y + L); ctx.lineTo(x - w, y + w); ctx.lineTo(x - L, y + w); ctx.lineTo(x - L, y - w); ctx.lineTo(x - w, y - w);
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.closePath();
  }

  Renderer.prototype.draw = function () {
    var ctx = this.ctx, d = this.data, th = this.theme, v = this.view, self = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = th.bg; ctx.fillRect(0, 0, this.w, this.h);
    if (!d) return;
    var g = d.graph, st = d.style, s = this._scale();

    // time axis
    if (d.axis) this._drawAxis(d.axis, d.range);

    // focus: selection or hover dims everything outside its neighbourhood
    var focusIds = new Set(this.selected); if (this.hover.node) focusIds.add(this.hover.node);
    if (d.focusId && focusIds.size === 1 && focusIds.has(d.focusId)) focusIds.clear();      // the focus view is already narrowed to this vertex: do not fade the next steps
    var near = focusIds.size ? neighbourhood(g, focusIds) : null;
    var hotEdge = this.hover.edge;

    // edges
    ctx.lineCap = 'round';
    var edgeTexts = [];
    d.visible.edges.forEach(function (id) {
      var e = g.edges.get(id), a = self.cur.get(e.source), b = self.cur.get(e.target); if (!a || !b) return;
      var A = self._toScreen(a), B = self._toScreen(b);
      if ((A.x < -50 && B.x < -50) || (A.y < -50 && B.y < -50) || (A.x > self.w + 50 && B.x > self.w + 50) || (A.y > self.h + 50 && B.y > self.h + 50)) return;
      var inFocus = !near || ((focusIds.has(e.source) || focusIds.has(e.target)));
      var w = Math.max(1, st.edgeWidth(e) * s * 0.8);
      var colour = st.edgeColor(e) || th.edge;
      ctx.globalAlpha = id === hotEdge || (self.selectedEdge === id) ? 1 : (inFocus ? (near ? 0.95 : 0.55) : 0.08);
      ctx.strokeStyle = id === hotEdge ? th.select : colour;
      ctx.lineWidth = w;
      ctx.setLineDash(e.kind === 'out' && e.spent === false ? [6, 4] : []);
      var ra = st.nodeRadius(g.nodes.get(e.source)) * s, rb = st.nodeRadius(g.nodes.get(e.target)) * s + 2;
      var dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      var x1 = A.x + ux * ra * 0.6, y1 = A.y + uy * ra * 0.6, x2 = B.x - ux * rb, y2 = B.y - uy * rb;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      ctx.setLineDash([]);
      if (len > ra + rb + 14) {                                             // arrowhead
        var ah = 5 + w * 0.9, nx = -uy, ny = ux;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.moveTo(x2 + ux * 1, y2 + uy * 1); ctx.lineTo(x2 - ux * ah + nx * ah * 0.55, y2 - uy * ah + ny * ah * 0.55);
        ctx.lineTo(x2 - ux * ah - nx * ah * 0.55, y2 - uy * ah - ny * ah * 0.55); ctx.closePath(); ctx.fill();
      }
      if (d.edgeLabel && edgeTexts.length < 250) {
        var seg = Math.hypot(x2 - x1, y2 - y1);
        if (seg > 70 && x1 > -200 && x1 < self.w + 200) edgeTexts.push({ e: e, mx: (x1 + x2) / 2, my: (y1 + y2) / 2, seg: seg, alpha: ctx.globalAlpha });
      }
    });
    ctx.globalAlpha = 1;
    if (edgeTexts.length) {                                              // amounts along the edges, only where the edge is long enough to carry the text
      ctx.font = '10.5px Calibri, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      edgeTexts.forEach(function (t) {
        var text = d.edgeLabel(t.e); if (!text) return;
        if (ctx.measureText(text).width + 14 > t.seg) return;
        ctx.globalAlpha = Math.min(1, t.alpha + 0.15);
        ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(28,20,29,0.92)'; ctx.strokeText(text, t.mx, t.my - 5);
        ctx.fillStyle = '#d8eef5'; ctx.fillText(text, t.mx, t.my - 5);
      });
      ctx.globalAlpha = 1;
    }

    // nodes
    var labels = [], badges = [];
    d.visible.nodes.forEach(function (id) {
      var n = g.nodes.get(id), p = self.cur.get(id); if (!p) return;
      var P = self._toScreen(p), r = st.nodeRadius(n) * s;
      if (P.x < -r - 4 || P.y < -r - 4 || P.x > self.w + r + 4 || P.y > self.h + r + 4) return;
      var dimmed = near && !near.has(id), colour = st.nodeColor(n);
      var hollow = n.type === 'tx' && n.loaded === false;
      ctx.globalAlpha = dimmed ? 0.15 : 1;
      shape(ctx, kindOf(n), P.x, P.y, r);
      if (hollow) { ctx.fillStyle = 'rgba(28,20,29,0.9)'; ctx.fill(); ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]); }
      else {
        ctx.fillStyle = colour; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        if (n.type === 'tx' && n.confirmed === false) ctx.setLineDash([3, 2]);
        ctx.stroke(); ctx.setLineDash([]);
      }
      var known = n.type === 'addr' && d.known && d.known[n.address];
      if (n.label || known || self.selected.has(id) || id === self.hover.node) {
        shape(ctx, kindOf(n), P.x, P.y, r + 3.5);
        ctx.lineWidth = self.selected.has(id) ? 3 : 2;
        ctx.strokeStyle = self.selected.has(id) ? th.select : (n.label ? th.accent : th.known);
        ctx.stroke();
      }
      if (n.ext) {                                                         // a small blue dot: something was looked up about this wallet
        ctx.beginPath(); ctx.arc(P.x + r * 0.85, P.y - r * 0.85, 3.4, 0, Math.PI * 2); ctx.fillStyle = '#4da3ff'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (n.tag && !dimmed) badges.push({ text: n.tag, x: P.x, y: P.y - r - 6, color: colour });
      var text = null;
      if (n.label) text = n.label;
      else if (known) text = known.label;
      else if (self.selected.has(id) || id === self.hover.node || (d.showLabels && v.k >= 0.9)) {
        text = n.type === 'tx' ? Style.shortId(n.txid, 5) : n.type === 'addr' ? Style.shortId(n.address, 6) : n.type === 'coinbase' ? 'coinbase' : n.type === 'data' ? (n.dataText ? '“' + n.dataText.slice(0, 18) + '”' : 'OP_RETURN') : 'non-standard';
      }
      if (text && !dimmed) labels.push({ text: text, x: P.x, y: P.y + r + 12, strong: !!(n.label || known), sel: self.selected.has(id) });
    });
    ctx.font = 'bold 9.5px Calibri, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    badges.forEach(function (b) {                                          // the tag, in its own colour, above the vertex
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(28,20,29,0.95)'; ctx.strokeText(b.text, b.x, b.y);
      ctx.fillStyle = b.color; ctx.fillText(b.text, b.x, b.y);
    });
    ctx.font = '11px Calibri, Arial, sans-serif';
    labels.forEach(function (l) {
      var t = l.text.length > 34 ? l.text.slice(0, 33) + '…' : l.text;
      ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(28,20,29,0.9)'; ctx.strokeText(t, l.x, l.y);
      ctx.fillStyle = l.strong ? th.accent : th.text; ctx.fillText(t, l.x, l.y);
    });
  };

  function fmtGap(sec, short) {
    if (sec >= 365.25 * DAY * 1.5) return (sec / (365.25 * DAY)).toFixed(1) + (short ? 'y' : ' years');
    if (sec >= 60 * DAY) return Math.round(sec / (30.44 * DAY)) + (short ? 'mo' : ' months');
    if (sec >= 2 * DAY) return Math.round(sec / DAY) + (short ? 'd' : ' days');
    if (sec >= 3600) return Math.round(sec / 3600) + (short ? 'h' : ' hours');
    return Math.max(1, Math.round(sec / 60)) + (short ? 'm' : ' min');
  }

  Renderer.prototype._drawAxis = function (axis, range) {
    var ctx = this.ctx, v = this.view, th = this.theme, h = this.h, w = this.w;
    function sx(worldX) { return worldX * v.k + v.x; }
    ctx.font = '11px Calibri, Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(242,242,242,0.04)'; ctx.fillRect(0, 0, w, 22);
    ctx.lineWidth = 1;
    if (axis.mode === 'compact' && axis.knots.length > 1) {
      var short = (axis.tMax - axis.tMin) < 3 * DAY, lastX = -1e9, step = [short ? 60 : DAY, 's'];
      axis.knots.forEach(function (kn) {
        var x = sx(axis.x0 + kn.x);
        if (x < -60 || x > w + 60) return;
        ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 22); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
        if (x - lastX >= 92) { ctx.fillStyle = th.dim; ctx.fillText(labelFor(kn.t, step), x + 4, 15); lastX = x; }
      });
      axis.breaks.forEach(function (b) {
        var xa = sx(axis.x0 + b.x0), xb = sx(axis.x0 + b.x1);
        if (xb < 0 || xa > w) return;
        ctx.fillStyle = 'rgba(242,201,76,0.05)'; ctx.fillRect(xa, 22, xb - xa, h);
        ctx.strokeStyle = 'rgba(242,201,76,0.35)'; ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.moveTo(xa, 22); ctx.lineTo(xa, h); ctx.moveTo(xb, 22); ctx.lineTo(xb, h); ctx.stroke(); ctx.setLineDash([]);
        var room = xb - xa;
        if (room > 28) { ctx.fillStyle = '#f2c94c'; ctx.textAlign = 'center'; ctx.fillText(room > 110 ? '⋯ ' + fmtGap(b.seconds) + ' ⋯' : fmtGap(b.seconds, true), (xa + xb) / 2, 36); ctx.textAlign = 'left'; }
      });
    } else if (axis.pxPerSec > 0) {
      niceTicks(axis.tMin, axis.tMax, axis.pxPerSec * v.k, 90).forEach(function (tk) {
        var x = sx(axis.x0 + (tk.t - axis.tMin) * axis.pxPerSec);
        if (x < -40 || x > w + 40) return;
        ctx.strokeStyle = th.grid; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 22); ctx.lineTo(Math.round(x) + 0.5, h); ctx.stroke();
        ctx.fillStyle = th.dim; ctx.fillText(tk.label, x + 4, 15);
      });
    } else {
      ctx.fillStyle = th.dim; ctx.fillText(Style.fmtTime(axis.tMin), sx(axis.x0) + 4, 15);
    }
    if (range && axis.xOf && (range.from != null || range.to != null) && axis.knots.length > 1) {
      var xa2 = range.from != null ? sx(axis.xOf(range.from)) : 0, xb2 = range.to != null ? sx(axis.xOf(range.to)) : w;
      ctx.fillStyle = 'rgba(174,231,248,0.10)'; ctx.fillRect(Math.max(0, xa2), 0, Math.max(0, Math.min(w, xb2) - Math.max(0, xa2)), 22);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      if (xa2 > 0) ctx.fillRect(0, 22, Math.min(w, xa2), h);
      if (xb2 < w) ctx.fillRect(Math.max(0, xb2), 22, w - xb2, h);
    }
    if (axis.hasPending) {
      var px = sx(axis.pendingX);
      ctx.strokeStyle = 'rgba(242,201,76,0.5)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(px - 40 * v.k, 22); ctx.lineTo(px - 40 * v.k, h); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#f2c94c'; ctx.fillText('unconfirmed', px - 36 * v.k, 15);
    }
  };

  /** PNG data URL of the current view (for "save image"). */
  Renderer.prototype.toDataUrl = function () { this.draw(); return this.canvas.toDataURL('image/png'); };

  return { Renderer: Renderer, niceTicks: niceTicks, distToSegment: distToSegment, kindOf: kindOf, shape: shape };
}));
