/*
 * Orion workspace controller: wires the model, filters, layouts, data source, import/export and the renderer
 * to workspace.html. Everything that comes from the network or from a file reaches the page through
 * textContent / canvas drawing only, never as HTML.
 */
(function () {
  'use strict';

  var M = OrionModel, S = OrionStyle, F = OrionFilter, L = OrionLayout, A = OrionApi, IO = OrionIO, R = OrionRender, NV = OrionNav, AD = OrionAddress, PR = OrionPrice, ST = OrionSteps, TG = OrionTags, XT = OrionExternal;
  var ID = M.ID;
  var KNOWN = window.ORION_KNOWN || {};
  var SAMPLE = '0f58c9a7aee48bd72ffd929fd3ac80bf95db5be13a6493b2f954de9ae659710d';
  var SAVE_KEY = 'orion.workspace.v1', PREF_KEY = 'orion.prefs.v1', TOKEN_KEY = 'orion.ext.token';
  var LAYOUTS = { flow: 1, timeline: 1, force: 1 }, COLORS = { type: 1, age: 1, script: 1 }, SCALES = { compact: 1, proportional: 1 };

  function $(id) { return document.getElementById(id); }
  function el(tag, props, kids) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (props[k] === null || props[k] === undefined || props[k] === false) return;           // no attribute at all (setAttribute('disabled', null) would still disable)
      if (k === 'text') n.textContent = props[k];
      else if (k === 'class') n.className = props[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }
  function num(v, lo, hi, dflt) { v = parseInt(v, 10); return isNaN(v) ? dflt : Math.max(lo, Math.min(hi, v)); }

  // ---- state ----------------------------------------------------------------------------------
  var state = {
    graph: new M.Graph(), layout: 'flow', colorBy: 'type', timeScale: 'compact', filter: F.defaults(),
    keep: new Set(), pinned: new Map(), selected: new Set(), selectedEdge: null,
    source: 'clearnet', customBase: '', capTx: 25, capReq: 80, capPages: 2, showLabels: true, persist: true,
    focus: null, focusOn: true, hops: 2, nav: new NV(), histOk: false, scopeNodes: null,
    fiat: { currency: 'off', basis: 'each', show: 'both', ref: null }, books: {},
    sideCollapsed: false, inspCollapsed: false, edgeLabels: true, viaWallets: true,
    ext: { proxy: 'http://127.0.0.1:8787', token: '', remember: false, consented: false, busy: false }, today: null, todayAt: 0, fiatError: '', priceClient: null,
    retired: { data: 0, price: 0, retried: 0, failed: 0 },
    busy: false, playMs: 90, layoutRes: null, client: null, explorer: null, tb: { min: null, max: null }, amountMax: 0, playTimer: null,
    log: []
  };
  var renderer = null, saveTimer = null, toastTimer = null, clearTimer = null;

  // ---- messages -------------------------------------------------------------------------------
  function log(msg, bad) {
    state.log.unshift({ msg: msg, bad: !!bad });
    state.log.length = Math.min(state.log.length, 60);
    var ul = $('logList'); ul.textContent = '';
    state.log.forEach(function (l) { ul.appendChild(el('li', { text: l.msg, 'class': l.bad ? 'bad' : '' })); });
    $('logCount').textContent = '(' + state.log.length + ')';
  }
  function toast(msg, bad) {
    var t = $('toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 9000 : 5000);
    log(msg, bad);
  }

  // ---- data source ----------------------------------------------------------------------------
  function sourceBase() { return state.source === 'custom' ? state.customBase.trim() : A.PRESETS[state.source].base; }

  function retire(c, key) {
    if (!c) return;
    state.retired[key] += c.total.network; state.retired.retried += c.total.retried; state.retired.failed += c.total.failed;
  }

  /** Where fiat prices come from: the source itself when it is a mempool, otherwise mempool.space. null = nowhere to ask. */
  function priceBase() {
    var p = A.PRESETS[state.source] || A.PRESETS.custom;
    if (p.prices) return p.prices;
    return /^https?:\/\//i.test(state.customBase.trim()) ? state.customBase.trim() : null;
  }

  function makePriceClient() {
    retire(state.priceClient, 'price'); state.priceClient = null;
    var base = priceBase();
    if (!base) return;
    state.priceClient = new A.Client({ base: base, concurrency: 2, delayMs: 300, timeoutMs: state.source === 'tor' ? 120000 : 40000, retries: 2 });
  }

  function updateReqStats() {
    var c = state.client, p = state.priceClient, r = state.retired;
    var data = r.data + (c ? c.total.network : 0), price = r.price + (p ? p.total.network : 0);
    var retried = r.retried + (c ? c.total.retried : 0) + (p ? p.total.retried : 0), failed = r.failed + (c ? c.total.failed : 0) + (p ? p.total.failed : 0);
    $('reqStats').textContent = 'Requests this session: ' + data + ' data' + (price ? ', ' + price + ' price' : '') + (retried ? ' · ' + retried + ' retried' : '') + (failed ? ' · ' + failed + ' failed' : '') + '.';
  }

  function makeClient() {
    retire(state.client, 'data');
    var p = A.PRESETS[state.source] || A.PRESETS.custom;
    state.client = new A.Client({
      base: sourceBase(), concurrency: p.concurrency, delayMs: p.delayMs, timeoutMs: p.timeoutMs, retries: p.retries,
      onRequest: function (path, c) { if (state.busy) $('progressText').textContent = $('progressText').dataset.title + ' — ' + c.network + ' request' + (c.network === 1 ? '' : 's'); }
    });
    state.explorer = new A.Explorer(state.client, state.graph);
    makePriceClient();
    if ($('reqStats')) updateReqStats();
  }

  function setGraph(g) { state.graph = g; state.explorer = new A.Explorer(state.client, g); state.layoutRes = null; }

  function explorerOrigin() {
    if (state.source === 'tor') return A.ONION.replace(/\/api$/, '');
    if (state.source === 'custom' && /^https?:\/\//i.test(state.customBase.trim())) return state.customBase.trim().replace(/\/(api\/?)?$/, '');
    return 'https://mempool.space';
  }

  var SOURCE_HINT = {
    clearnet: 'Requests go from your browser straight to mempool.space, which can see your IP address and what you look up. It publishes no rate limit; if it throttles you (HTTP 429) the page waits and retries.',
    blockstream: 'Blockstream\'s public Esplora API, same format as mempool.space, with no published limit either. It has no price API, so fiat prices still come from mempool.space (only the currency and the dates are sent there).',
    tor: 'Needs Tor Browser (it routes .onion addresses). In an ordinary browser this will not connect. Slower on purpose: 2 requests at a time, 0.8 s apart, 60 s timeout.',
    custom: 'Any Esplora-compatible API, for example your own mempool/electrs. The server must allow cross-origin requests (CORS).'
  };
  function applySourceUi() {
    $('source').value = state.source;
    $('customBase').hidden = state.source !== 'custom';
    $('customBase').value = state.customBase;
    $('sourceHint').textContent = SOURCE_HINT[state.source];
    $('testResult').textContent = ''; $('testResult').className = '';
  }
  function cleanFiat(f) {
    var out = { currency: 'off', basis: 'each', show: 'both', ref: null };
    if (!f || typeof f !== 'object') return out;
    if (f.currency === 'off' || PR.CURRENCIES.indexOf(f.currency) >= 0) out.currency = f.currency;
    if (f.basis === 'each' || f.basis === 'ref' || f.basis === 'today') out.basis = f.basis;
    if (f.show === 'btc' || f.show === 'both' || f.show === 'fiat') out.show = f.show;
    if (f.ref && typeof f.ref.txid === 'string' && /^[0-9a-f]{64}$/.test(f.ref.txid) && typeof f.ref.time === 'number' && isFinite(f.ref.time)) out.ref = { txid: f.ref.txid, time: f.ref.time };
    return out;
  }

  function savePrefs() {
    store.set(PREF_KEY, JSON.stringify({ source: state.source, customBase: state.customBase, capTx: state.capTx, capReq: state.capReq, capPages: state.capPages, showLabels: state.showLabels, persist: state.persist, focusOn: state.focusOn, hops: state.hops, fiat: state.fiat, sideCollapsed: state.sideCollapsed, inspCollapsed: state.inspCollapsed, edgeLabels: state.edgeLabels, viaWallets: state.viaWallets, extProxy: state.ext.proxy, extRemember: state.ext.remember }));
  }
  function loadPrefs() {
    var raw = store.get(PREF_KEY); if (!raw) return;
    try {
      var p = JSON.parse(raw);
      if (A.PRESETS[p.source]) state.source = p.source;
      if (typeof p.customBase === 'string') state.customBase = p.customBase.slice(0, 300);
      state.capTx = num(p.capTx, 1, 500, 25); state.capReq = num(p.capReq, 1, 1000, 80); state.capPages = num(p.capPages, 1, 20, 2);
      state.showLabels = p.showLabels !== false;
      state.persist = p.persist !== false;
      state.focusOn = p.focusOn !== false; state.hops = num(p.hops, 1, 3, 2);
      state.fiat = cleanFiat(p.fiat);
      state.sideCollapsed = p.sideCollapsed === true; state.inspCollapsed = p.inspCollapsed === true;
      state.edgeLabels = p.edgeLabels !== false; state.viaWallets = p.viaWallets !== false;
      if (typeof p.extProxy === 'string' && proxyUrlOk(p.extProxy)) state.ext.proxy = p.extProxy;
      state.ext.remember = p.extRemember === true;
      if (state.ext.remember) state.ext.token = store.get(TOKEN_KEY) || '';
    } catch (e) { /* ignore corrupt prefs */ }
  }

  // ---- running actions ------------------------------------------------------------------------
  function showProgress(title) {
    $('progressText').dataset.title = title; $('progressText').textContent = title + '…'; $('progress').hidden = false;
  }

  /** Runs fn() (resolving to an Explorer result) with a request cap and a cancel button, then reports. */
  function run(title, fn) {
    if (state.busy) { toast('Busy: wait for the current action or cancel it.', true); return Promise.resolve(null); }
    if (state.source === 'custom' && !/^https?:\/\//i.test(state.customBase.trim())) { toast('Enter the URL of your Esplora API first (https://… or http://…).', true); return Promise.resolve(null); }
    state.busy = true;
    var c = state.client; c.resume(); c.resetCount(); c.maxRequests = state.capReq;
    showProgress(title);
    var wasEmpty = state.graph.nodes.size === 0;
    return fn().then(function (r) {
      if (!r) return r;
      var capHit = (r.errors || []).some(function (e) { return /request cap/.test(e); });
      var msg = title + ': ' + (r.added ? '+' + r.added + ' vertices' : 'nothing new') + ', ' + r.requests + ' request' + (r.requests === 1 ? '' : 's') + '.';
      if (r.truncated) msg += ' Stopped at the per-expand limit; raise it under Expansion limits.';
      if (capHit) msg += ' Stopped at the request limit.';
      var errs = (r.errors || []).filter(function (e) { return !/request cap/.test(e); });
      if (errs.length) msg += ' ' + errs.length + ' request(s) failed: ' + errs[0] + (errs.length > 1 ? ' …' : '');
      toast(msg, !!errs.length || !!r.failed);
      return r;
    }).catch(function (e) {
      toast(title + ' failed: ' + (e && e.message ? e.message : e), true); return null;
    }).then(function (r) {
      state.busy = false; $('progress').hidden = true; updateReqStats();
      state.graph.refreshDerived();
      afterGraphChange({ fit: wasEmpty });
      scheduleSave();
      return r;
    });
  }

  function openQuery(raw) {
    if (!(raw || '').trim()) return;
    var q = A.checkQuery(raw);
    if (!q.ok) { toast(q.message, true); return; }
    if ($('q').value.trim() === String(raw).trim()) $('q').value = q.value;                                           // show what was actually looked up
    navigate(q.kind === 'tx' ? ID.tx(q.value) : ID.addr(q.value));
  }

  // ---- focus and navigation -------------------------------------------------------------------
  /** The vertex whose neighbourhood is shown, or null when the whole graph is. */
  function focusOpt() { return state.focusOn && state.focus && state.graph.nodes.has(state.focus) ? { id: state.focus, hops: state.hops } : null; }

  /** What the graph shows before the time range is applied: every other filter, limited to the focus neighbourhood. */
  function scope(extra) {
    return F.computeVisible(state.graph, Object.assign({}, state.filter, { timeFrom: null, timeTo: null }, extra || {}), state.keep, focusOpt());
  }

  function needsLoad(id) {
    var n = state.graph.nodes.get(id), kind = id.slice(0, id.indexOf(':'));
    if (kind === 'tx') return !n || !n.loaded || !n.outspendsLoaded;
    if (kind === 'addr') return !n || n.txCount == null;
    return false;
  }
  function loaderFor(id) {
    var kind = id.slice(0, id.indexOf(':')), val = id.slice(id.indexOf(':') + 1);
    if (kind === 'tx') return { title: 'Open ' + S.shortId(val, 8), fn: function () { return state.explorer.loadTx(val); }, done: function (n) { return !!(n && n.loaded); } };
    if (kind === 'addr') return { title: 'Open ' + S.shortId(val, 8), fn: function () { return state.explorer.expandAddress(val, { pages: state.capPages, cap: state.capPages * 25 }); }, done: function (n) { return !!(n && n.txCount != null); } };
    return null;
  }

  function focusLabel(id) {
    var n = state.graph.nodes.get(id), kind = id.slice(0, id.indexOf(':')), val = id.slice(id.indexOf(':') + 1);
    var text = n && n.label ? n.label : (n && n.type === 'addr' && KNOWN[n.address]) ? KNOWN[n.address].label : (kind === 'tx' ? S.shortId(val, 5) : kind === 'addr' ? S.shortId(val, 6) : kind === 'cb' ? 'coinbase' : kind === 'data' ? 'OP_RETURN' : 'output');
    return (kind === 'tx' ? 'tx ' : kind === 'addr' ? '' : '') + text;
  }

  /** Record a new place in the trail and in the browser's own history (so its Back/Forward buttons work too). */
  function visitNav(id) {
    var first = state.nav.entries.length === 0;
    if (!state.nav.visit(id)) return;
    var hash = NV.toHash(state.nav.index, id);
    try {
      if (first) window.history.replaceState({ orion: 1 }, '', hash); else window.history.pushState({ orion: 1 }, '', hash);
      state.histOk = true;
    } catch (e) { state.histOk = false; }
  }

  function updateNavUi() {
    $('navBack').disabled = !state.nav.canBack(); $('navFwd').disabled = !state.nav.canForward();
    var trail = $('trail'), es = state.nav.entries, cur = state.nav.index;
    trail.textContent = '';
    trail.hidden = es.length === 0;
    if (!es.length) return;
    var from = Math.max(0, cur - 7);
    if (from > 0) trail.appendChild(el('span', { 'class': 'sep', text: '… ›' }));
    for (var i = from; i < es.length && i < from + 14; i++) {
      (function (i) {
        var isCur = i === cur;
        if (i > from) trail.appendChild(el('span', { 'class': 'sep', text: '›' }));
        trail.appendChild(el('button', { type: 'button', 'class': 'crumb' + (isCur ? ' current' : '') + (i > cur ? ' ahead' : ''), title: es[i], 'aria-current': isCur ? 'true' : null,
                                         text: focusLabel(es[i]), onclick: function () { if (!isCur) stepNav(i - cur); } }));
      }(i));
    }
    var c = trail.querySelector('.current'); if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * Make a vertex the focus. Loads it first when needed (a transaction with its outspends, an address with its
   * history). o.fromHistory = a Back/Forward step, which must not add a new entry to the trail.
   */
  function navigate(id, o) {
    o = o || {};
    id = canonicalId(id);
    var load = loaderFor(id);
    if (!state.graph.nodes.has(id) && !load) { toast('That vertex is no longer in the workspace.', true); return Promise.resolve(false); }
    var prev = state.focus, hadKeep = state.keep.has(id);

    function commit() {
      stopPlay(); $('tooltip').hidden = true;
      state.focus = id; state.keep.add(id);
      state.filter.timeFrom = null; state.filter.timeTo = null;       // a window chosen for the old neighbourhood may hide the whole new one
      state.pinned.clear();
      if (!o.fromHistory) visitNav(id);
      state.selected = new Set([id]); state.selectedEdge = null;
      syncSelection();                                                  // open the details panel first, so the fit below sees the canvas at its final size
      var pan = !state.focusOn && o.fromHistory;                        // whole-graph view: Back/Forward move the camera, opening something new still fits everything
      afterGraphChange({ fit: !pan });
      if (pan) renderer.centerOn(id);
      updateNavUi(); scheduleSave();
      return true;
    }

    // stepping onto a wallet shows what is already known about it; its whole history is one click away (Load history)
    var must = needsLoad(id) && !(o.light && id.indexOf('addr:') === 0 && state.graph.nodes.has(id));
    if (!must) return Promise.resolve(commit());
    state.focus = id; state.keep.add(id);                              // provisional, so the refresh at the end of the load already looks right
    return run(load.title, load.fn).then(function () {
      if (load.done(state.graph.nodes.get(id))) return commit();
      state.focus = prev; if (!hadKeep) state.keep.delete(id);          // failed: stay where we were
      afterGraphChange(); updateNavUi();
      return false;
    });
  }

  // ---- Previous / Next: follow the money ------------------------------------------------------
  function stepOpts() { return { viaWallets: state.viaWallets }; }
  function closeStepMenu() {
    var m = $('stepMenu'); if (m.hidden) return;
    m.hidden = true; $('stepPrev').setAttribute('aria-expanded', 'false'); $('stepNext').setAttribute('aria-expanded', 'false');
  }

  var KIND_NAME = { tx: 'Transaction', addr: 'Wallet', coinbase: 'Coinbase', data: 'OP_RETURN', nonstd: 'Output' };

  function renderStepBar() {
    var bar = $('stepbar'), g = state.graph, id = state.focus, n = id && g.nodes.get(id);
    closeStepMenu();
    if (!n) { bar.hidden = true; return; }
    bar.hidden = false;
    var c = ST.counts(g, id, stepOpts());
    [['prev', c.prev, $('stepPrev'), $('stepPrevN')], ['next', c.next, $('stepNext'), $('stepNextN')]].forEach(function (x) {
      x[2].disabled = x[1] === 0; x[3].textContent = x[1] ? String(x[1]) : '';
      x[2].title = x[1] === 0 ? ST.emptyReason(g, id, x[0], stepOpts()) : (x[0] === 'prev' ? 'Where the money came from ([)' : 'Where the money went (])');
    });
    $('stepKind').textContent = KIND_NAME[n.type] || 'Vertex';
    $('stepName').textContent = focusLabel(id).replace(/^tx /, '');
    var amt = '';
    if (n.type === 'tx') amt = (n.time != null ? S.fmtTime(n.time, false) + ' · ' : n.confirmed === false ? 'unconfirmed · ' : '') + (n.loaded ? amountText(n.valueOut, n.time) : 'not loaded');
    else if (n.type === 'addr') amt = 'received ' + mixText(S.fmtBtc(n.received) + ' BTC', fiatSum(n, true)) + (n.txCount != null ? ' · ' + fmtInt(n.txCount) + ' txs on chain' : ' · history not loaded');
    $('stepAmt').textContent = amt;
    var load = $('stepLoad');
    load.hidden = !(n.type === 'addr' && (n.txCount == null || n.histNext));
    load.textContent = n.histNext ? 'Load more history' : 'Load history';
  }

  /** Describe one step row for the list: { what, sub, amt, title }. */
  function stepRowText(r) {
    var g = state.graph, node = r.id && g.nodes.get(r.id), via = r.via && g.nodes.get(r.via);
    var viaText = via ? 'via ' + focusLabel(via.id) : '';
    var what, sub = '';
    if (r.type === 'addr') {
      what = focusLabel(r.id);
      var known = node && node.address && KNOWN[node.address];
      if (known && node.label) what += ' (' + known.label + ')';              // without your own label the known one is already the name
      sub = r.spent === true ? 'spent' + (r.spender ? ' in ' + S.shortId(r.spender, 5) : '') : r.spent === false ? 'unspent so far' : '';
    } else if (r.type === 'tx') {
      what = 'tx ' + S.shortId(node ? node.txid : r.id.slice(3), 6);
      sub = [node && node.time != null ? S.fmtTime(node.time, false) : (node && node.confirmed === false ? 'unconfirmed' : ''), viaText, node && node.loaded === false ? 'not loaded yet' : ''].filter(Boolean).join(' · ');
    } else {
      what = r.type === 'coinbase' ? 'Coinbase' : r.type === 'unspent' ? 'Unspent output' : r.type === 'data' ? 'OP_RETURN data' : 'Non-standard output';
      sub = [r.note, viaText].filter(Boolean).join(' · ');
    }
    if (r.count > 1) sub = (sub ? sub + ' · ' : '') + r.count + ' transfers';
    return { what: what, sub: sub, amt: mixText(S.fmtBtc(r.amount) + ' BTC', fiatOf(r.amount, r.time)) };
  }

  function openStepMenu(dir) {
    var g = state.graph, rows = ST.neighbours(g, state.focus, dir, stepOpts()), menu = $('stepMenu');
    menu.textContent = '';
    menu.appendChild(el('div', { 'class': 'menuhead', text: dir === 'prev' ? 'Previous: where the money came from' : 'Next: where the money went' }));
    rows.forEach(function (r) {
      var t = stepRowText(r), kids = [el('span', { 'class': 'what' }, [t.what, t.sub ? el('small', { text: t.sub }) : null]), el('span', { 'class': 'amt', text: t.amt })];
      if (r.navigable) menu.appendChild(el('button', { type: 'button', 'class': 'steprow', role: 'menuitem', title: r.id, onclick: function () { closeStepMenu(); stepTo(r); } }, kids));
      else menu.appendChild(el('div', { 'class': 'steprow info' }, kids));
    });
    $('toast').hidden = true;
    menu.style.left = dir === 'prev' ? '0' : 'auto'; menu.style.right = dir === 'next' ? '0' : 'auto';
    menu.hidden = false;
    $('stepPrev').setAttribute('aria-expanded', String(dir === 'prev')); $('stepNext').setAttribute('aria-expanded', String(dir === 'next'));
    var first = menu.querySelector('button'); if (first) first.focus();
  }

  function stepTo(row) { navigate(row.id, { light: true }); }

  /** Previous / Next: one place to go means going; several open the list. */
  function stepClick(dir) {
    if (!state.focus || !state.graph.nodes.has(state.focus)) return;
    var menuOpenFor = !$('stepMenu').hidden && $('stepMenu').firstChild && $('stepMenu').firstChild.textContent.indexOf(dir === 'prev' ? 'Previous' : 'Next') === 0;
    if (menuOpenFor) { closeStepMenu(); return; }
    var go = ST.neighbours(state.graph, state.focus, dir, stepOpts()).filter(function (r) { return r.navigable; });
    if (!go.length) { toast(ST.emptyReason(state.graph, state.focus, dir, stepOpts())); return; }
    if (go.length === 1) { stepTo(go[0]); return; }
    openStepMenu(dir);
  }

  /** Back / forward by `delta` steps through the trail. */
  function stepNav(delta) {
    var target = state.nav.index + delta;
    if (target < 0 || target >= state.nav.entries.length || !delta) return;
    if (state.histOk) window.history.go(delta);                        // the popstate handler does the rest
    else { var id = state.nav.goto(target); if (id) navigate(id, { fromHistory: true }); }
  }

  function onPopState() {
    var p = NV.parseHash(window.location.hash);
    if (!p) return;
    p.id = canonicalId(p.id);
    if (state.nav.entries[p.index] === p.id) {
      if (p.index !== state.nav.index) { state.nav.goto(p.index); navigate(p.id, { fromHistory: true }); }
    } else {                                                           // an address typed or shared by hand
      state.nav.reset(); navigate(p.id);
    }
  }

  function expandNode(id, direction) {
    var n = state.graph.nodes.get(id); if (!n) return;
    if (n.type === 'tx') {
      var dirLabel = direction === 'forward' ? 'spenders' : direction === 'backward' ? 'funding transactions' : 'both directions';
      run('Expand ' + S.shortId(n.txid, 6) + ' (' + dirLabel + ')', function () { return state.explorer.expandTx(n.txid, direction || 'both', state.capTx); });
    } else if (n.type === 'addr') {
      var more = n.histNext;
      run((more ? 'More history of ' : 'History of ') + S.shortId(n.address, 8), function () {
        return state.explorer.expandAddress(n.address, { pages: state.capPages, cap: state.capPages * 25, after: more || undefined }).then(function (r) {
          var node = state.graph.nodes.get(id);
          if (node) { node.histNext = r.last || null; node.histDone = !r.last && !r.truncated && !(r.errors && r.errors.length); }
          return r;
        });
      }).then(function () { showInspector(); });
    } else {
      toast('Nothing to expand here: this is a ' + (n.type === 'coinbase' ? 'coinbase (newly created coins)' : n.type === 'data' ? 'OP_RETURN data output' : 'non-standard output') + '.');
    }
  }

  // ---- selection and inspector ----------------------------------------------------------------
  function selectOnly(id) { state.selected = id ? new Set([id]) : new Set(); state.selectedEdge = null; syncSelection(); }
  function syncSelection() {
    renderer.setSelection(Array.from(state.selected)); renderer.selectedEdge = state.selectedEdge;
    showInspector();
  }

  function copy(text) {
    var done = function () { toast('Copied.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { toast('Could not copy; select the text manually.', true); });
    else toast('Copy is not available in this browser.', true);
  }
  function kv(dl, k, v) { if (v === null || v === undefined || v === '') return; dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: String(v) })); }
  /** A row with a Bitcoin amount and, when conversion is on, its fiat value beside it. */
  function kvf(dl, k, btcText, fx) {
    var mode = fiatOn() && fx ? state.fiat.show : 'btc';
    dl.appendChild(el('dt', { text: k }));
    if (mode === 'fiat') {
      var sp = fiatSpan(fx); sp.className += ' primary'; sp.title = fx.title + ' · ' + btcText;
      dl.appendChild(el('dd', {}, [sp]));
    } else dl.appendChild(el('dd', { text: btcText }, mode === 'both' ? [fiatSpan(fx)] : []));
  }
  /** One line of text for an amount, following the chosen display (Bitcoin / both / fiat). */
  function mixText(btcText, fx) {
    var mode = fiatOn() && fx ? state.fiat.show : 'btc';
    return mode === 'fiat' ? fx.text : mode === 'both' ? btcText + ' · ' + fx.text : btcText;
  }
  function amountText(sats, time) { return mixText(S.fmtBtc(sats) + ' BTC', fiatOn() ? fiatOf(sats, time) : null); }

  var edgeLabelCache = new Map();
  /** The short text drawn along an edge. Cached until the data or the display choice changes. */
  function edgeLabelFor(e) {
    var hit = edgeLabelCache.get(e.id); if (hit !== undefined) return hit;
    var fx = fiatOn() ? fiatOfEdge(e) : null, mode = fx ? state.fiat.show : 'btc', btc = S.fmtBtcShort(e.amount);
    var t = mode === 'fiat' ? fx.text : mode === 'both' ? btc + ' · ' + fx.text : btc;
    edgeLabelCache.set(e.id, t);
    return t;
  }
  function fiatSpan(fx) { return el('span', { 'class': 'fiat' + (fx.approx ? ' approx' : ''), title: fx.title, text: fx.text }); }

  // ---- fiat conversion ------------------------------------------------------------------------
  function fiatOn() { return state.fiat.currency !== 'off'; }

  /** Today's price, or null when not loaded. */
  function todayRate() { return state.today ? PR.parseToday(state.today, state.fiat.currency) : null; }

  /**
   * The price to use for something that happened at `time` (unix seconds; null = not confirmed yet), following the
   * chosen basis. Returns {price, label, approx, note} or null when the prices are not loaded (yet).
   */
  function fiatRate(time) {
    var f = state.fiat;
    if (f.currency === 'off') return null;
    var basis = f.basis, t = time;
    if (basis === 'ref') { if (f.ref) t = f.ref.time; else basis = 'today'; }
    if (basis === 'today' || t == null) {
      var td = todayRate(); if (!td) return null;
      var when = td.time ? S.fmtTime(td.time, false) : 'today';
      return { price: td.price, label: 'today ' + when, approx: false, note: basis === 'today' ? "today's price" : 'not confirmed yet, so today\'s price' };
    }
    var book = state.books[f.currency]; if (!book) return null;
    var r = book.rateAt(t); if (!r) return null;
    var note = r.derived ? 'USD price converted at today\'s exchange rate (no ' + f.currency + ' data that early)' : r.outside ? 'outside the price history, nearest point used'
             : r.approx ? 'interpolated between price points ' + r.spanDays.toFixed(1) + ' days apart' : 'hourly/daily data';
    return { price: r.price, label: S.fmtTime(t, false), approx: r.approx, note: note };
  }

  /** {value, text, title, approx, rate} for `sats` at `time`, or null. */
  function fiatOf(sats, time) {
    if (sats == null) return null;
    var r = fiatRate(time); if (!r) return null;
    var v = PR.convert(sats, r.price), cur = state.fiat.currency;
    return { value: v, text: (r.approx ? '≈ ' : '') + PR.format(v, cur), approx: r.approx, rate: r,
             title: PR.format(r.price, cur) + ' per BTC at ' + r.label + ' (' + r.note + ')' };
  }
  /** The moment an edge's amount is worth: its transaction's time; for a transaction not loaded yet, when its output was spent. */
  function edgeMoment(e) {
    var t = F.edgeTime(state.graph, e);
    if (t != null) return t;
    var tx = state.graph.nodes.get(e.kind === 'out' ? e.source : e.target);
    if (tx && tx.confirmed === false) return null;                                       // genuinely unconfirmed: today's price
    return e.spentBy && e.spentBy.time != null ? e.spentBy.time : null;
  }
  function fiatOfEdge(e) { return fiatOf(e.amount, edgeMoment(e)); }

  /** Sum over an address's edges, each at its own transaction's time: what it received or sent. */
  function fiatSum(n, received) {
    var sum = 0, any = false, approx = false, cur = state.fiat.currency;
    state.graph.edgesOf(n.id).forEach(function (e) {
      var hit = received ? (e.kind === 'out' && e.target === n.id) : (e.kind === 'in' && e.source === n.id);
      if (!hit) return;
      var x = fiatOfEdge(e); if (!x) return;
      sum += x.value; any = true; approx = approx || x.approx;
    });
    if (!any) return null;
    return { value: sum, approx: approx, text: (approx ? '≈ ' : '') + PR.format(sum, cur),
             title: 'Sum of each transfer converted at its own ' + (state.fiat.basis === 'today' ? "(today's)" : state.fiat.basis === 'ref' ? '(reference)' : 'transaction') + ' price' };
  }

  function fiatLoaded() {
    var f = state.fiat;
    if (f.currency === 'off') return false;
    return !!state.today && (f.basis === 'today' || !!state.books[f.currency]);
  }

  /** For exports: edge -> {value, currency, price, basis} as strings, or null. */
  function exportFiat() {
    if (!fiatOn()) return null;
    var cur = state.fiat.currency;
    return function (e) {
      var x = fiatOfEdge(e); if (!x) return null;
      return { value: PR.plain(x.value, cur), currency: cur, price: String(Math.round(x.rate.price * 100) / 100), basis: x.rate.label + (x.approx ? ' ~' : '') };
    };
  }

  function setFiatStatus(text, bad) { var s = $('fiatStatus'); s.textContent = text; s.style.color = bad ? 'var(--danger)' : ''; }

  function updateFiatStatus() {
    var f = state.fiat;
    if (f.currency === 'off') { setFiatStatus(''); return; }
    if (state.fiatError) { setFiatStatus(state.fiatError, true); return; }
    var parts = [], book = state.books[f.currency], td = todayRate();
    if (!priceBase()) { setFiatStatus('Prices need a mempool-compatible server: enter your URL under Data source or pick another source.', true); return; }
    if (td) parts.push('1 BTC = ' + PR.format(td.price, f.currency) + ' today');
    if (book && f.basis !== 'today') parts.push('history to ' + S.fmtTime(book.lastTime(), false) + ' (' + fmtInt(book.size()) + ' points)');
    if (f.basis === 'ref' && !f.ref) parts.push('no reference transaction chosen: using today\'s price');
    if (!parts.length) parts.push('Prices not loaded yet.');
    var base = priceBase();
    setFiatStatus('Prices from ' + (base === A.ONION ? 'mempool.space over Tor' : base.replace(/^https?:\/\//, '').replace(/\/api\/?$/, '')) + '. ' + parts.join(' · '));
  }

  function syncFiatUi() {
    var f = state.fiat, on = fiatOn();
    $('fiatCur').value = f.currency;
    Array.prototype.forEach.call(document.querySelectorAll('input[name=fiatBasis]'), function (r) { r.disabled = !on; r.checked = r.value === f.basis; });
    $('fiatPick').disabled = !on;
    Array.prototype.forEach.call($('showSeg').querySelectorAll('button'), function (b) { b.disabled = !on; b.setAttribute('aria-checked', String(b.getAttribute('data-show') === f.show)); });
    var ab = $('btnAmounts'); ab.hidden = !on;
    ab.textContent = f.show === 'btc' ? '₿ only' : f.show === 'fiat' ? f.currency + ' only' : '₿ + ' + f.currency;
    $('fiatRefRow').hidden = f.basis !== 'ref';
    $('fiatRef').textContent = f.ref ? 'tx ' + S.shortId(f.ref.txid, 5) + ' · ' + S.fmtTime(f.ref.time) : 'none chosen';
    updateFiatStatus();
  }

  /** Fetch whatever prices the current choice needs, then redraw what shows amounts. */
  function ensurePrices() {
    var f = state.fiat; state.fiatError = '';
    if (f.currency === 'off') { syncFiatUi(); refreshFiatViews(); return Promise.resolve(); }
    var pc = state.priceClient, cur = f.currency, jobs = [];
    if (!pc) { state.fiatError = 'Prices need a mempool-compatible server: enter your URL under Data source or pick another source.'; syncFiatUi(); return Promise.resolve(); }
    pc.resume();
    if (!state.today || Date.now() - state.todayAt > 600000) jobs.push(pc.prices().then(function (j) { state.today = j; state.todayAt = Date.now(); }));
    if (f.basis !== 'today' && !state.books[cur]) {
      jobs.push(pc.historicalPrices(cur).then(function (j) {
        var b = new PR.PriceBook(j, cur);
        if (!b.size() && !b.usd.length) throw new Error('the server returned no price history');
        state.books[cur] = b;
      }));
    }
    if (!jobs.length) { syncFiatUi(); refreshFiatViews(); return Promise.resolve(); }
    setFiatStatus('Loading prices…');
    return Promise.all(jobs).catch(function (e) {
      state.fiatError = 'Could not load prices: ' + (e && e.message ? e.message : e) + (state.source === 'tor' ? ' (the onion service may not offer prices; try another source)' : '');
    }).then(function () { syncFiatUi(); refreshFiatViews(); updateReqStats(); });
  }

  function refreshFiatViews() { $('tooltip').hidden = true; showInspector(); refresh(); renderStepBar(); }

  function setShow(mode) {
    if (mode !== 'btc' && mode !== 'both' && mode !== 'fiat') return;
    state.fiat.show = mode; savePrefs(); scheduleSave(); syncFiatUi(); refreshFiatViews();
  }

  /** Make `n` (a confirmed transaction) the one moment every amount is converted at. */
  function setRef(n) {
    if (!n || n.type !== 'tx' || n.time == null) { toast('Choose a confirmed transaction: it needs a timestamp.', true); return; }
    if (!fiatOn()) state.fiat.currency = 'USD';
    state.fiat.ref = { txid: n.txid, time: n.time }; state.fiat.basis = 'ref';
    savePrefs(); scheduleSave(); syncFiatUi(); ensurePrices();
  }
  /** The transaction to use as the price moment: the selected confirmed one, else the focused one. */
  function refCandidate() {
    var g = state.graph, ok = function (n) { return n && n.type === 'tx' && n.time != null; };
    var sel = Array.from(state.selected).map(function (id) { return g.nodes.get(id); }).filter(ok)[0];
    if (sel) return sel;
    var foc = state.focus && g.nodes.get(state.focus);
    return ok(foc) ? foc : null;
  }
  function pickRef() {
    var n = refCandidate();
    if (!n) { toast('Select (or focus) a confirmed transaction first.', true); return; }
    setRef(n);
  }
  function refBtn(n) {
    if (!fiatOn() || n.time == null) return null;
    var isRef = state.fiat.basis === 'ref' && state.fiat.ref && state.fiat.ref.txid === n.txid;
    return el('button', { type: 'button', text: isRef ? 'Converting at this time' : 'Convert all at this time', disabled: isRef ? 'disabled' : null,
                          title: 'Use this transaction\'s timestamp as the price moment for every amount', onclick: function () { setRef(n); } });
  }

  /** A vertex id with the address part in its proper case (bech32 lower-cased). */
  function canonicalId(id) { return typeof id === 'string' && id.indexOf('addr:') === 0 ? 'addr:' + AD.normalise(id.slice(5)) : id; }
  function extLink(path, text) { return el('a', { href: explorerOrigin() + path, target: '_blank', rel: 'noopener noreferrer', text: text }); }

  function annotateBox(n) {
    var lab = el('input', { type: 'text', id: 'fLabel', maxlength: '120', placeholder: 'Your label (shown on the graph)' });
    var note = el('textarea', { id: 'fNote', maxlength: '4000', placeholder: 'Notes' });
    lab.value = n.label || ''; note.value = n.note || '';
    var apply = function () { state.graph.annotate(n.id, lab.value, note.value); refresh(); scheduleSave(); };
    lab.addEventListener('input', apply); note.addEventListener('input', apply);
    return el('div', { 'class': 'insp-section' }, [el('label', { 'for': 'fLabel', 'class': 'lbl', text: 'Label' }), lab, tagControls([n.id]),
                                                  el('label', { 'for': 'fNote', 'class': 'lbl', text: 'Notes' }), note]);
  }

  var SHAPE_GLYPH = { circle: '●', square: '■', diamond: '◆', hexagon: '⬢', triangle: '▲', star: '★', cross: '✚' };
  var SHAPE_NAME = { circle: 'Circle', square: 'Square', diamond: 'Diamond', hexagon: 'Hexagon', triangle: 'Triangle', star: 'Star', cross: 'Cross' };
  var DEFAULT_SHAPE_OF = { tx: 'square', coinbase: 'diamond', data: 'hexagon' };

  /** Tag, colour and shape for one vertex, or for every selected vertex at once. */
  function tagControls(ids) {
    var g = state.graph, nodes = ids.map(function (id) { return g.nodes.get(id); }).filter(Boolean), first = nodes[0] || {};
    var sel = el('select', { id: 'fTag', 'aria-label': 'Tag' });
    sel.appendChild(el('option', { value: '', text: 'No tag' }));
    TG.PRESETS.forEach(function (p) { sel.appendChild(el('option', { value: p.id, text: p.id + ' — ' + p.name })); });
    sel.appendChild(el('option', { value: '__custom', text: 'Custom…' }));
    var preset = first.tag && TG.preset(first.tag);
    sel.value = !first.tag ? '' : preset ? first.tag : '__custom';
    var custom = el('input', { type: 'text', id: 'fTagCustom', maxlength: '20', placeholder: 'Tag name', 'aria-label': 'Custom tag name' });
    custom.value = first.tag && !preset ? first.tag : ''; custom.hidden = sel.value !== '__custom';
    var color = el('input', { type: 'color', id: 'fColor', 'aria-label': 'Colour', title: 'Colour' });
    var shapeSel = el('select', { id: 'fShape', 'aria-label': 'Shape', title: 'Shape' });
    shapeSel.appendChild(el('option', { value: '', text: 'Usual shape' }));
    TG.SHAPES.forEach(function (s) { shapeSel.appendChild(el('option', { value: s, text: SHAPE_GLYPH[s] + ' ' + SHAPE_NAME[s] })); });
    var preview = el('span', { 'class': 'tagpreview', 'aria-hidden': 'true' });
    var swatches = el('div', { 'class': 'swatches', role: 'group', 'aria-label': 'Quick colours' });

    function sync() {
      var n = g.nodes.get(ids[0]) || {};
      var c = n.color || (TG.preset(n.tag) || {}).color;
      color.value = c || '#8d7f8d'; shapeSel.value = n.shape || '';
      preview.textContent = SHAPE_GLYPH[n.shape || DEFAULT_SHAPE_OF[n.type] || 'circle'];
      preview.style.color = c || '';
      Array.prototype.forEach.call(swatches.children, function (b) { b.setAttribute('aria-pressed', String(!!c && b.getAttribute('data-color') === c)); });
    }
    function apply(fields, keepStyle) {
      ids.forEach(function (id) { var nd = g.nodes.get(id); if (nd) TG.apply(nd, fields, keepStyle); });
      sync(); refresh(); scheduleSave();
    }
    TG.COLORS.forEach(function (c) {
      var b = el('button', { type: 'button', 'class': 'swatch', 'aria-label': 'Colour ' + c, title: c, 'data-color': c, onclick: function () { apply({ color: c }); } });
      b.style.background = c; swatches.appendChild(b);
    });
    sel.addEventListener('change', function () {
      custom.hidden = sel.value !== '__custom';
      if (sel.value === '__custom') { custom.focus(); if (custom.value) apply({ tag: custom.value }, true); return; }
      apply({ tag: sel.value });
    });
    custom.addEventListener('input', function () { apply({ tag: custom.value }, true); });
    color.addEventListener('input', function () { apply({ color: color.value }); });
    shapeSel.addEventListener('change', function () { apply({ shape: shapeSel.value }); });
    var reset = el('button', { type: 'button', text: 'Reset look', title: 'Back to the usual colour and shape (the tag stays)', onclick: function () { apply({ color: '', shape: '' }); } });
    sync();
    return el('div', { 'class': 'tagbox' }, [el('label', { 'for': 'fTag', 'class': 'lbl', text: 'Tag' }),
      el('div', { 'class': 'tagrow' }, [sel, custom]),
      el('div', { 'class': 'tagrow' }, [preview, color, shapeSel, reset]), swatches]);
  }

  // ---- external lookups (on request, one wallet) ----------------------------------------------
  function proxyUrlOk(u) { return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/.*)?$/i.test(u) || /^https:\/\/[^\s/]+(\/.*)?$/i.test(u); }

  function externalCard(n) {
    var ark = n.ext && n.ext.arkham, box = el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'External sources' })]);
    box.appendChild(el('div', { 'class': 'insp-actions' }, [
      el('button', { type: 'button', id: 'btnArkham', text: ark ? 'Look up again in Arkham' : 'Look up in Arkham', title: 'Sends this wallet\'s address to Arkham Intelligence, through your local proxy', onclick: function () { lookupArkham(n.id); } })]));
    if (ark) box.appendChild(arkhamCard(n, ark));
    return box;
  }

  function arkhamCard(n, a) {
    var card = el('div', { 'class': 'extcard' }), dl = el('dl', { 'class': 'kv' });
    card.appendChild(el('h4', {}, [el('span', { text: 'Arkham Intelligence' }), el('small', { text: a.at ? S.fmtTime(a.at, false) : '' })]));
    if (!a.found) card.appendChild(el('p', { 'class': 'hint', text: 'Arkham has no entry for this wallet.' }));
    else {
      kv(dl, 'Entity', a.name); kv(dl, 'Type', a.type); kv(dl, 'Label', a.label); kv(dl, 'Tags', (a.tags || []).join(', ')); kv(dl, 'Predicted', a.predicted); kv(dl, 'Website', a.website); kv(dl, 'Note', a.note);
      card.appendChild(dl);
    }
    var acts = [];
    var text = [a.name, a.label].filter(Boolean).join(' · ').slice(0, 120);
    if (a.found && text) acts.push(el('button', { type: 'button', text: 'Use as label', title: 'Set your label to “' + text + '”', onclick: function () { state.graph.annotate(n.id, text, n.note); showInspector(); refresh(); scheduleSave(); } }));
    if (a.suggest && TG.preset(a.suggest)) acts.push(el('button', { type: 'button', text: 'Tag as ' + a.suggest, title: 'Suggested from Arkham\'s entity type: ' + TG.preset(a.suggest).name, onclick: function () { TG.apply(n, { tag: a.suggest }); showInspector(); refresh(); scheduleSave(); } }));
    acts.push(el('button', { type: 'button', text: 'Remove result', onclick: function () { delete n.ext.arkham; if (!Object.keys(n.ext).length) delete n.ext; showInspector(); refresh(); scheduleSave(); } }));
    card.appendChild(el('div', { 'class': 'insp-actions' }, acts));
    if (a.raw) card.appendChild(el('details', {}, [el('summary', { text: 'Raw reply' }), el('pre', { text: a.raw })]));
    return card;
  }

  function lookupArkham(id) {
    var n = state.graph.nodes.get(id), x = state.ext;
    if (!n || n.type !== 'addr') { toast('Look-ups are for wallets: choose a wallet.', true); return; }
    if (state.source === 'tor') { toast('Look-ups are switched off while the data source is Tor: they would go outside Tor and tell Arkham which wallet you are looking at.', true); return; }
    if (!x.token) {
      toast('Set up the lookup proxy first (Controls › External sources): run tools/arkham_proxy.py and enter its URL and token.', true);
      setSideCollapsed(false); $('extSection').open = true; $('arkToken').focus(); return;
    }
    if (x.busy) { toast('A look-up is already running.', true); return; }
    if (!x.consented) {
      if (!window.confirm('This sends the wallet address\n\n' + n.address + '\n\nto Arkham Intelligence (through your local proxy). Continue?')) return;
      x.consented = true;
    }
    x.busy = true; toast('Asking Arkham about ' + S.shortId(n.address, 8) + '…');
    XT.lookupArkham({ fetch: window.fetch.bind(window), base: x.proxy, token: x.token, address: n.address }).then(function (r) {
      var node = state.graph.nodes.get(id);
      if (node) { node.ext = node.ext || {}; node.ext.arkham = r.ext; }
      toast(r.found ? 'Arkham: ' + (r.ext.name || r.ext.label || 'tagged wallet') + (r.ext.type ? ' (' + r.ext.type + ')' : '') + '. Use the buttons in the details to apply it.' : 'Arkham has no entry for this wallet.');
      showInspector(); refresh(); scheduleSave();
    }, function (e) { toast((e && e.message) || 'The look-up failed.', true); }).then(function () { x.busy = false; });
  }

  // ---- right-click menu -----------------------------------------------------------------------
  function closeCtx() { var m = $('ctxMenu'); if (!m.hidden) { m.hidden = true; m.textContent = ''; } }

  function placeCtx(at) {
    var m = $('ctxMenu'); m.hidden = false;
    var w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(at.x, window.innerWidth - w - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(at.y, window.innerHeight - h - 8)) + 'px';
    var first = m.querySelector('button:not(:disabled), a'); if (first) first.focus();
  }

  function ctxItem(m, text, fn, o) {
    o = o || {};
    var b = el('button', { type: 'button', role: 'menuitem', disabled: o.disabled ? 'disabled' : null, title: o.title, 'class': o.danger ? 'danger' : null,
                           onclick: function () { if (o.keep) { fn(); } else { closeCtx(); fn(); } } },
               [el('span', {}, [o.glyph ? el('span', { 'class': 'sw', text: o.glyph, style: o.glyphColor ? 'color:' + o.glyphColor : null }) : null, text]), o.right ? el('span', { 'class': 'hint', text: o.right }) : null]);
    m.appendChild(b); return b;
  }

  function openCtx(nodeId, edgeId, at) {
    closeStepMenu(); $('tooltip').hidden = true;
    if (nodeId && !state.selected.has(nodeId)) { state.selected = new Set([nodeId]); state.selectedEdge = null; syncSelection(); }
    buildCtx(nodeId ? Array.from(state.selected) : null, at);
  }

  function buildCtx(ids, at) {
    var m = $('ctxMenu'), g = state.graph; m.textContent = '';
    if (!ids) {
      m.appendChild(el('div', { 'class': 'ctxhead', text: 'Graph' }));
      ctxItem(m, 'Fit view', function () { renderer.fit(); });
      ctxItem(m, 'Re-layout', function () { state.pinned.clear(); refresh({ relayout: true, fit: true }); });
      placeCtx(at); return;
    }
    if (ids.length > 1) {
      m.appendChild(el('div', { 'class': 'ctxhead', text: ids.length + ' selected' }));
      ctxItem(m, 'Tag as…', function () { buildTagMenu(ids, at); }, { keep: true, right: '▸' });
      ctxItem(m, 'Remove ' + ids.length + ' from view', function () { removeIds(ids); }, { danger: true });
      placeCtx(at); return;
    }
    var n = g.nodes.get(ids[0]); if (!n) return;
    m.appendChild(el('div', { 'class': 'ctxhead', text: (KIND_NAME[n.type] || 'Vertex') + ' · ' + focusLabel(n.id).replace(/^tx /, '') }));
    if (n.type === 'tx' || n.type === 'addr') ctxItem(m, 'Focus here', function () { navigate(n.id); });
    if (n.type === 'tx') {
      ctxItem(m, 'Spenders →', function () { expandNode(n.id, 'forward'); });
      ctxItem(m, '← Funding', function () { expandNode(n.id, 'backward'); });
    }
    if (n.type === 'addr') {
      ctxItem(m, n.histNext ? 'Load more history' : 'Load history', function () { expandNode(n.id); }, { disabled: !!n.histDone });
      ctxItem(m, n.ext && n.ext.arkham ? 'Look up again in Arkham…' : 'Look up in Arkham…', function () { lookupArkham(n.id); },
              { right: 'external', title: 'Sends this wallet\'s address to Arkham Intelligence, through your local proxy' });
    }
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, n.tag ? 'Tag: ' + n.tag + ' — change…' : 'Tag as…', function () { buildTagMenu(ids, at); }, { keep: true, right: '▸' });
    var idText = n.type === 'tx' ? n.txid : n.type === 'addr' ? n.address : n.id;
    ctxItem(m, n.type === 'tx' ? 'Copy txid' : n.type === 'addr' ? 'Copy address' : 'Copy id', function () { copy(idText); });
    if (n.type === 'tx' || n.type === 'addr') {
      var link = el('a', { href: explorerOrigin() + (n.type === 'tx' ? '/tx/' + n.txid : '/address/' + n.address), target: '_blank', rel: 'noopener noreferrer', role: 'menuitem', onclick: function () { closeCtx(); } }, [el('span', { text: 'Open in explorer' }), el('span', { 'class': 'hint', text: '↗' })]);
      m.appendChild(link);
    }
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, 'Remove from view', function () { removeIds(ids); }, { danger: true });
    placeCtx(at);
  }

  function buildTagMenu(ids, at) {
    var m = $('ctxMenu'); m.textContent = '';
    m.appendChild(el('div', { 'class': 'ctxhead', text: ids.length > 1 ? 'Tag ' + ids.length + ' vertices as' : 'Tag as' }));
    TG.PRESETS.forEach(function (p) {
      ctxItem(m, p.id + ' — ' + p.name, function () { applyTagTo(ids, { tag: p.id }); }, { glyph: SHAPE_GLYPH[p.shape], glyphColor: p.color });
    });
    m.appendChild(el('div', { 'class': 'sep' }));
    ctxItem(m, 'Custom tag, colour or shape…', function () { openTagEditor(ids); });
    ctxItem(m, 'No tag', function () { applyTagTo(ids, { tag: '' }); });
    ctxItem(m, '← Back', function () { buildCtx(ids, at); }, { keep: true });
    placeCtx(at);
  }

  function applyTagTo(ids, fields) {
    ids.forEach(function (id) { var nd = state.graph.nodes.get(id); if (nd) TG.apply(nd, fields); });
    showInspector(); refresh(); scheduleSave();
  }

  /** Bring the details (with the tag controls) up for these vertices. */
  function openTagEditor(ids) {
    state.selected = new Set(ids); state.selectedEdge = null; syncSelection();
    setInspCollapsed(false);
    var s = $('fTag'); if (s) s.focus();
  }

  function ctxKeys(e) {
    var m = $('ctxMenu'); if (m.hidden) return false;
    var items = Array.prototype.slice.call(m.querySelectorAll('button:not(:disabled), a')), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { items[0].focus(); }
    else if (e.key === 'End') { items[items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { closeCtx(); if (e.key === 'Escape') $('cv').focus(); }
    else return false;
    e.preventDefault(); return true;
  }

  /** Where a vertex is on the screen, for opening the menu from the keyboard. */
  function clientPosOf(id) {
    var p = renderer.positionOf(id), b = $('cv').getBoundingClientRect(), v = renderer.view;
    return p ? { x: b.left + p.x * v.k + v.x + 12, y: b.top + p.y * v.k + v.y + 12 } : { x: b.left + 40, y: b.top + 40 };
  }

  function focusBtn(n) {
    var here = state.focusOn && state.focus === n.id;
    return el('button', { type: 'button', 'class': 'primary', text: here ? 'Focused here' : 'Focus here', disabled: here ? 'disabled' : null,
                          title: 'Show this vertex and what is around it', onclick: function () { if (!state.focusOn) { state.focusOn = true; $('focusOn').checked = true; savePrefs(); } navigate(n.id); } });
  }

  /** One row per neighbouring transaction; clicking moves the focus there. `row` = {id, label, amount, time, dir}. */
  function linkRows(title, rows) {
    var LIMIT = 40, list = el('div', { 'class': 'linkrows' });
    rows.slice(0, LIMIT).forEach(function (r) {
      var kids = [el('span', { text: r.label })];
      if (r.time != null) kids.push(el('span', { 'class': 'when', text: S.fmtTime(r.time, false) }));
      if (r.amount != null) kids.push(el('span', { 'class': 'amt', text: (r.sign || '') + mixText(S.fmtBtc(r.amount) + ' BTC', r.amount != null ? fiatOf(r.amount, r.time) : null) }));
      var fx = r.amount != null ? fiatOf(r.amount, r.time) : null;
      if (r.id && state.graph.nodes.has(r.id)) list.appendChild(el('button', { type: 'button', 'class': 'linkrow', title: r.id + (fx ? ' · ' + fx.text : ''), onclick: function () { navigate(r.id); } }, kids));
      else list.appendChild(el('div', { 'class': 'linkrow plain' }, kids));
    });
    if (rows.length > LIMIT) list.appendChild(el('div', { 'class': 'hint', text: '… and ' + (rows.length - LIMIT) + ' more' }));
    return el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: title + ' (' + rows.length + ')' }), list]);
  }

  function connectedTxSections(n) {
    var g = state.graph, out = [];
    function txTime(txid) { var t = g.nodes.get(ID.tx(txid)); return t ? t.time : null; }
    if (n.type === 'tx') {
      var funded = [], spent = [];
      g.edgesOf(n.id).forEach(function (e) {
        if (e.kind === 'in' && e.target === n.id && e.prev) funded.push({ id: ID.tx(e.prev.txid), label: '← ' + S.shortId(e.prev.txid, 6), amount: e.amount, time: txTime(e.prev.txid) });
        else if (e.kind === 'out' && e.source === n.id) {
          if (e.spentBy) spent.push({ id: ID.tx(e.spentBy.txid), label: '→ ' + S.shortId(e.spentBy.txid, 6), amount: e.amount, time: e.spentBy.time != null ? e.spentBy.time : txTime(e.spentBy.txid) });
          else spent.push({ id: null, label: e.spent === false ? '→ unspent' : '→ spender unknown', amount: e.amount, time: null });
        }
      });
      if (funded.length) out.push(linkRows('Funded by', funded));
      if (spent.length) out.push(linkRows('Spent by', spent));
      if (!funded.length && !spent.length && n.loaded && !n.outspendsLoaded) out.push(el('p', { 'class': 'hint', text: 'Focus here to load what spent its outputs.' }));
    } else if (n.type === 'addr') {
      var byTx = new Map(), rows = [];                                   // one row per transaction: its net effect on this address
      g.edgesOf(n.id).forEach(function (e) {
        var received = e.kind === 'out' && e.target === n.id, spent = e.kind === 'in' && e.source === n.id;
        if (!received && !spent) return;
        var r = byTx.get(e.txid) || { recv: 0, sent: 0 };
        if (received) r.recv += e.amount; else r.sent += e.amount;
        byTx.set(e.txid, r);
      });
      byTx.forEach(function (r, txid) {
        var net = r.recv - r.sent;
        rows.push({ id: ID.tx(txid), label: S.shortId(txid, 6), amount: Math.abs(net), sign: net >= 0 ? '+' : '−', time: txTime(txid) });
      });
      rows.sort(function (a, b) { return (b.time == null ? Infinity : b.time) - (a.time == null ? Infinity : a.time); });
      if (rows.length) out.push(linkRows('Transactions', rows));
    }
    return out;
  }

  function removeBtn(ids) {
    return el('button', { type: 'button', 'class': 'danger', text: ids.length > 1 ? 'Remove ' + ids.length + ' from view' : 'Remove from view', onclick: function () { removeIds(ids); } });
  }

  function renderInspector(soft) {
    var box = $('inspBody'), insp = $('inspector'), g = state.graph;
    if (soft && box.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && state.selected.size === 1) return;   // user is typing
    box.textContent = '';
    var ids = Array.from(state.selected).filter(function (id) { return g.nodes.has(id); });
    if (!ids.length && state.selectedEdge && g.edges.has(state.selectedEdge)) { insp.hidden = false; return showEdge(g.edges.get(state.selectedEdge)); }
    if (!ids.length) { insp.hidden = true; return; }
    insp.hidden = false;
    if (ids.length > 1) {
      box.appendChild(el('h3', { text: ids.length + ' selected' }));
      var tot = 0; ids.forEach(function (id) { var n = g.nodes.get(id); tot += (n.type === 'tx' ? n.valueOut : n.received) || 0; });
      var dl0 = el('dl', { 'class': 'kv' }); kv(dl0, 'Total value', S.fmtBtc(tot) + ' BTC'); box.appendChild(dl0);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [removeBtn(ids)]));
      box.appendChild(el('div', { 'class': 'insp-section' }, [el('span', { 'class': 'lbl', text: 'Tag all ' + ids.length }), tagControls(ids)]));
      return;
    }
    var n = g.nodes.get(ids[0]), dl = el('dl', { 'class': 'kv' });
    var kind = { tx: 'Transaction', addr: 'Address', coinbase: 'Coinbase', data: 'OP_RETURN', nonstd: 'Non-standard' }[n.type];
    box.appendChild(el('h3', {}, [el('span', { 'class': 'kind', text: kind }), n.label ? el('span', { text: n.label }) : null]));

    if (n.type === 'tx') {
      box.appendChild(el('div', { 'class': 'mono', text: n.txid }));
      kv(dl, 'Status', n.loaded === false ? 'not loaded yet' : n.confirmed ? 'confirmed' : n.confirmed === false ? 'unconfirmed' : 'unknown');
      kv(dl, 'Time', n.time != null ? S.fmtTime(n.time) : null);
      kv(dl, 'Block', n.height);
      if (n.loaded) {
        kv(dl, 'Inputs', n.nIn); kv(dl, 'Outputs', n.nOut);
        kvf(dl, 'Value out', S.fmtBtc(n.valueOut) + ' BTC', fiatOf(n.valueOut, n.time));
        if (!n.coinbase) kvf(dl, 'Value in', S.fmtBtc(n.valueIn) + ' BTC', fiatOf(n.valueIn, n.time));
        if (n.fee != null) kvf(dl, 'Fee', fmtInt(n.fee) + ' sat' + (n.vsize ? ' (' + (n.fee / n.vsize).toFixed(1) + ' sat/vB)' : ''), fiatOf(n.fee, n.time));
        if (n.coinbase) kv(dl, 'Note', 'Coinbase: creates new coins');
      }
      box.appendChild(dl);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [focusBtn(n), refBtn(n)]));
      box.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Spenders →', title: 'Load the transactions that spent its outputs', onclick: function () { expandNode(n.id, 'forward'); } }),
        el('button', { type: 'button', text: '← Funding', title: 'Load the transactions it spends from', onclick: function () { expandNode(n.id, 'backward'); } }),
        el('button', { type: 'button', text: '↔ Both', onclick: function () { expandNode(n.id, 'both'); } })
      ]));
      box.appendChild(el('div', { 'class': 'insp-actions' }, [
        el('button', { type: 'button', text: 'Copy txid', onclick: function () { copy(n.txid); } }), extLink('/tx/' + n.txid, 'Open in explorer ↗'), removeBtn([n.id])
      ]));
      connectedTxSections(n).forEach(function (s) { box.appendChild(s); });
    } else if (n.type === 'addr') {
      box.appendChild(el('div', { 'class': 'mono', text: n.address }));
      var known = KNOWN[n.address];
      if (known) {
        var tags = el('div', {}, [el('span', { 'class': 'tag known', text: 'known: ' + known.label })]);
        (known.alt || []).forEach(function (a) { tags.appendChild(el('span', { 'class': 'tag', text: 'also listed as: ' + a })); });
        box.appendChild(tags);
      }
      kv(dl, 'Script type', n.scriptType);
      kvf(dl, 'Received here', S.fmtBtc(n.received) + ' BTC (in this graph)', fiatSum(n, true));
      kvf(dl, 'Sent from here', S.fmtBtc(n.sent) + ' BTC (in this graph)', fiatSum(n, false));
      kv(dl, 'First seen', n.firstSeen != null ? S.fmtTime(n.firstSeen) : null);
      kv(dl, 'Last seen', n.lastSeen != null ? S.fmtTime(n.lastSeen) : null);
      if (n.txCount != null) kv(dl, 'Transactions', fmtInt(n.txCount) + ' on chain' + (n.histNext || !n.histDone ? '' : ' (all loaded)'));
      box.appendChild(dl);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [focusBtn(n)]));
      var acts = [el('button', { type: 'button', text: n.histNext ? 'Load more history' : 'Load history', disabled: n.histDone ? 'disabled' : null, onclick: function () { expandNode(n.id); } }),
                  el('button', { type: 'button', text: 'Copy address', onclick: function () { copy(n.address); } }), extLink('/address/' + n.address, 'Open in explorer ↗'), removeBtn([n.id])];
      box.appendChild(el('div', { 'class': 'insp-actions' }, acts));
      connectedTxSections(n).forEach(function (s) { box.appendChild(s); });
      box.appendChild(externalCard(n));
    } else {
      if (n.type === 'data') {
        kv(dl, 'Output', S.shortId(n.txid, 8) + ':' + n.vout);
        kv(dl, 'Text', n.dataText); kv(dl, 'Hex', n.dataHex ? (n.dataHex.length > 160 ? n.dataHex.slice(0, 160) + '…' : n.dataHex) : '(empty)');
      } else if (n.type === 'nonstd') {
        kv(dl, 'Output', S.shortId(n.txid, 8) + ':' + n.vout); kv(dl, 'Script type', n.scriptType);
      } else kv(dl, 'Note', 'Newly created coins paid to the miner of the block');
      box.appendChild(dl);
      box.appendChild(el('div', { 'class': 'insp-actions' }, [removeBtn([n.id])]));
    }
    box.appendChild(annotateBox(n));
  }

  function showInspector(soft) { renderInspector(soft); updateInspTab(); }

  // ---- collapsible panels ---------------------------------------------------------------------
  function setSideCollapsed(c) {
    state.sideCollapsed = !!c;
    document.body.classList.toggle('side-collapsed', state.sideCollapsed);
    $('sideTab').hidden = !state.sideCollapsed; $('sideCollapse').setAttribute('aria-expanded', String(!state.sideCollapsed));
    savePrefs();
  }
  function setInspCollapsed(c) {
    state.inspCollapsed = !!c;
    document.body.classList.toggle('insp-collapsed', state.inspCollapsed);
    $('inspCollapse').setAttribute('aria-expanded', String(!state.inspCollapsed));
    updateInspTab(); savePrefs();
  }
  /** The tab that brings the details back: only while they are collapsed and something is selected. */
  function updateInspTab() {
    var has = !$('inspector').hidden, tab = $('inspTab');
    tab.hidden = !(state.inspCollapsed && has);
    if (!tab.hidden) {
      var id = Array.from(state.selected)[0], n = id && state.graph.nodes.get(id);
      $('inspTabText').textContent = state.selected.size > 1 ? state.selected.size + ' selected' : n ? focusLabel(id) : 'Details';
    }
  }

  function showEdge(e) {
    var box = $('inspBody'), g = state.graph, dl = el('dl', { 'class': 'kv' });
    var txn = g.nodes.get(e.kind === 'out' ? e.source : e.target);
    box.appendChild(el('h3', {}, [el('span', { 'class': 'kind', text: e.kind === 'out' ? 'Output' : 'Input' })]));
    kvf(dl, 'Amount', S.fmtBtc(e.amount) + ' BTC (' + fmtInt(e.amount) + ' sat)', fiatOfEdge(e));
    kv(dl, 'Time', F.edgeTime(g, e) != null ? S.fmtTime(F.edgeTime(g, e)) : null);
    kv(dl, 'Transaction', S.shortId(e.txid, 8));
    if (e.kind === 'out') {
      kv(dl, 'Spent', e.spent === true ? 'yes' : e.spent === false ? 'no (unspent so far)' : 'unknown');
      if (e.spentBy) kv(dl, 'Spent by', S.shortId(e.spentBy.txid, 8));
    }
    box.appendChild(dl);
    var acts = [];
    if (txn) acts.push(el('button', { type: 'button', text: 'Select transaction', onclick: function () { selectOnly(txn.id); } }));
    if (e.spentBy && g.nodes.has(ID.tx(e.spentBy.txid))) acts.push(el('button', { type: 'button', text: 'Select spender', onclick: function () { selectOnly(ID.tx(e.spentBy.txid)); } }));
    box.appendChild(el('div', { 'class': 'insp-actions' }, acts));
  }

  function removeIds(ids) {
    ids.forEach(function (id) { state.graph.removeNode(id); state.keep.delete(id); state.pinned.delete(id); if (state.focus === id) state.focus = null; });
    state.selected = new Set(); state.selectedEdge = null;
    state.graph.refreshDerived(); afterGraphChange(); syncSelection(); scheduleSave();
  }

  // ---- tooltip --------------------------------------------------------------------------------
  function onHover(nodeId, edgeId, at) {
    var tip = $('tooltip');
    if (!at || (!nodeId && !edgeId)) { tip.hidden = true; return; }
    var g = state.graph; tip.textContent = '';
    function line(k, v) { if (v === null || v === undefined || v === '') return; tip.appendChild(el('div', {}, [el('b', { text: k + ' ' }), String(v)])); }
    function fline() { /* amounts follow the display choice through mixText now */ }
    if (nodeId) {
      var n = g.nodes.get(nodeId); if (!n) { tip.hidden = true; return; }
      if (n.type === 'tx') {
        line('Transaction', S.shortId(n.txid, 10)); line('Time', n.time != null ? S.fmtTime(n.time) : (n.confirmed === false ? 'unconfirmed' : 'unknown'));
        if (n.loaded) { line('Value', mixText(S.fmtBtc(n.valueOut) + ' BTC', fiatOf(n.valueOut, n.time)) + ' · ' + n.nIn + ' in / ' + n.nOut + ' out'); } else line('', 'Not loaded: double-click to load');
      } else if (n.type === 'addr') {
        line('Address', S.shortId(n.address, 12)); if (KNOWN[n.address]) line('Known', KNOWN[n.address].label);
        line('Type', n.scriptType); line('Received', mixText(S.fmtBtc(n.received) + ' BTC', fiatSum(n, true))); line('First seen', n.firstSeen != null ? S.fmtTime(n.firstSeen) : null);
      } else if (n.type === 'data') { line('OP_RETURN', n.dataText || (n.dataHex ? n.dataHex.slice(0, 48) + (n.dataHex.length > 48 ? '…' : '') : 'empty')); }
      else if (n.type === 'coinbase') line('Coinbase', 'newly created coins');
      else line('Non-standard output', n.scriptType);
      if (n.label) line('Label', n.label);
      if (n.note) line('Note', n.note.length > 140 ? n.note.slice(0, 140) + '…' : n.note);
    } else {
      var e = g.edges.get(edgeId); if (!e) { tip.hidden = true; return; }
      line(e.kind === 'out' ? 'Output' : 'Input', mixText(S.fmtBtc(e.amount) + ' BTC', fiatOfEdge(e))); line('Time', F.edgeTime(g, e) != null ? S.fmtTime(F.edgeTime(g, e)) : null);
      if (e.kind === 'out') line('Spent', e.spent === true ? 'yes' : e.spent === false ? 'no' : 'unknown');
    }
    tip.hidden = false;
    var w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(at.x + 14, window.innerWidth - w - 8) + 'px';
    tip.style.top = Math.min(at.y + 14, window.innerHeight - h - 8) + 'px';
  }

  // ---- refresh --------------------------------------------------------------------------------
  function seedPositions(structural) {
    var start = new Map(), rnd = L.rng(5);
    structural.nodes.forEach(function (id) { var p = renderer.positionOf(id); if (p) start.set(id, { x: p.x, y: p.y }); });
    structural.nodes.forEach(function (id) {
      if (start.has(id)) return;
      var near = state.graph.edgesOf(id).map(function (e) { return start.get(e.source === id ? e.target : e.source); }).filter(Boolean)[0];
      if (near) start.set(id, { x: near.x + (rnd() - 0.5) * 80, y: near.y + (rnd() - 0.5) * 80 });
    });
    return start;
  }

  /** o: { relayout, fit, instant } */
  function refresh(o) {
    o = o || {};
    var g = state.graph, f = state.filter;
    edgeLabelCache.clear();
    renderer.insets.bottom = state.focus && g.nodes.has(state.focus) ? Math.max(84, $('stepbar').offsetHeight + 22) : 0;       // keep the graph clear of the step bar
    var structural = scope();
    if (o.relayout || !state.layoutRes) {
      var opts = state.layout === 'force' ? { start: seedPositions(structural), seed: 1 } : state.layout === 'timeline' ? { width: 1600, scale: state.timeScale } : {};
      state.layoutRes = L.layout(state.layout, g, structural, opts);
      state.pinned.forEach(function (p, id) { if (state.layoutRes.pos.has(id)) state.layoutRes.pos.set(id, { x: p.x, y: p.y }); });
      renderer.setPositions(state.layoutRes.pos, !!o.instant || !renderer.cur.size);
    }
    var visible = F.computeVisible(g, f, state.keep, focusOpt());
    var style = S.makeStyle(g, structural, { colorBy: state.colorBy });
    renderer.setData({ graph: g, visible: visible, style: style, known: KNOWN, axis: state.layout === 'timeline' ? state.layoutRes.axis : null,
                       range: { from: f.timeFrom, to: f.timeTo }, showLabels: state.showLabels, focusId: focusOpt() ? state.focus : null,
                       edgeLabel: state.edgeLabels ? edgeLabelFor : null });
    if (o.fit) renderer.fit();
    var fo = focusOpt();
    $('counts').textContent = g.nodes.size ? (fo ? 'Focus: ' + focusLabel(fo.id) + ' · depth ' + fo.hops + ' · ' : '') + visible.nodes.size + ' of ' + g.nodes.size + ' vertices · ' + visible.edges.size + ' of ' + g.edges.size + ' edges' : '';
    $('empty').hidden = g.nodes.size > 0;
    updateLegend();
  }

  function afterGraphChange(o) {
    o = o || {};
    state.graph.refreshDerived();
    updateTimebar(); updateAmount(); updateScriptChips();
    refresh({ relayout: true, fit: !!o.fit });
    showInspector(true);
    renderStepBar();
  }

  // ---- legend / filters -----------------------------------------------------------------------
  function updateLegend() {
    var box = $('legend'); box.textContent = '';
    var types = Object.keys(F.scriptTypeCounts(state.graph));
    var lg = S.legend(state.colorBy, types);
    if (lg.gradient) {
      var grad = el('div', { 'class': 'grad' });
      grad.style.background = 'linear-gradient(to right,' + lg.gradient.map(function (s) { return s[1] + ' ' + Math.round(s[0] * 100) + '%'; }).join(',') + ')';
      box.appendChild(grad);
      box.appendChild(el('div', { 'class': 'grad-labels' }, [el('span', { text: 'older' }), el('span', { text: 'newer' })]));
      box.appendChild(legendItem(lg.unknown, 'time unknown'));
    } else lg.items.forEach(function (i) { box.appendChild(legendItem(i.color, i.label)); });
    box.appendChild(el('div', { 'class': 'item', text: 'Edge width = amount · dashed = unspent output' }));
    var tags = TG.summarise(Array.from(state.graph.nodes.values()));
    if (tags.length) {
      box.appendChild(el('div', { 'class': 'item', style: 'margin-top:6px;color:var(--text)', text: 'Tags (click to select them)' }));
      tags.forEach(function (t) {
        var glyph = el('span', { 'class': 'tagsw', text: SHAPE_GLYPH[t.shape] || '●' }); if (t.color) glyph.style.color = t.color;
        box.appendChild(el('div', { 'class': 'item tagitem', role: 'button', tabindex: '0', title: t.name,
                                    onclick: function () { selectTag(t.tag); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectTag(t.tag); } } },
                           [glyph, el('span', { text: t.tag + ' ' + t.count })]));
      });
    }
  }
  function selectTag(tag) {
    var ids = Array.from(state.graph.nodes.values()).filter(function (n) { return n.tag === tag; }).map(function (n) { return n.id; });
    state.selected = new Set(ids); state.selectedEdge = null; syncSelection();
    toast(ids.length + ' vertices tagged ' + tag + ' selected.');
  }
  function legendItem(color, text) {
    var sw = el('span', { 'class': 'sw' }); sw.style.background = color;
    return el('div', { 'class': 'item' }, [sw, el('span', { text: text })]);
  }

  function updateScriptChips() {
    var box = $('scriptTypes'); box.textContent = '';
    var counts = F.scriptTypeCounts(state.graph), hidden = new Set(state.filter.hiddenScriptTypes);
    var names = Object.keys(counts).sort();
    if (!names.length) { box.appendChild(el('span', { 'class': 'hint', text: 'none yet' })); return; }
    names.forEach(function (t) {
      var cb = el('input', { type: 'checkbox', 'aria-label': t }); cb.checked = !hidden.has(t);
      cb.addEventListener('change', function () {
        var set = new Set(state.filter.hiddenScriptTypes); if (cb.checked) set.delete(t); else set.add(t);
        state.filter.hiddenScriptTypes = Array.from(set); refresh({ relayout: true }); scheduleSave();
      });
      var sw = el('span', { 'class': 'sw' }); sw.style.background = S.SCRIPT_COLORS[t] || S.SCRIPT_COLORS.unknown;
      box.appendChild(el('label', { 'class': 'chip' }, [cb, sw, el('span', { text: t + ' ' + counts[t] })]));
    });
  }

  // amount slider: log scale between 0 and the largest edge
  function amountFromSlider(p) { p = Number(p); if (p <= 0 || state.amountMax < 1) return 0; return Math.max(1, Math.round(Math.pow(10, p / 1000 * Math.log10(state.amountMax + 1)) - 1)); }
  function sliderFromAmount(a) { if (!a || state.amountMax < 1) return 0; return Math.min(1000, Math.round(Math.log10(a + 1) / Math.log10(state.amountMax + 1) * 1000)); }
  function updateAmount() {
    state.amountMax = F.amountRange(state.graph, scope({ minAmount: 0, maxAmount: null }).edges).max;
    $('minAmount').disabled = state.amountMax < 1;
    $('minAmount').value = sliderFromAmount(state.filter.minAmount);
    var a = state.filter.minAmount;
    $('minAmountOut').textContent = a ? '≥ ' + fmtInt(a) + ' sat (' + S.fmtBtc(a) + ' BTC)' : 'off';
  }
  function setMinAmount(a, fromSlider) {
    state.filter.minAmount = a;
    if (!fromSlider) $('minAmount').value = sliderFromAmount(a);
    $('minAmountOut').textContent = a ? '≥ ' + fmtInt(a) + ' sat (' + S.fmtBtc(a) + ' BTC)' : 'off';
    refresh({ relayout: true }); scheduleSave();
  }

  // ---- time bar -------------------------------------------------------------------------------
  function timeOfSlider(v) { var b = state.tb; return Math.round(b.min + (Number(v) / 1000) * (b.max - b.min)); }
  function sliderOfTime(t) { var b = state.tb; return Math.round((t - b.min) / (b.max - b.min) * 1000); }
  function timebarEnabled() { return state.tb.min != null && state.tb.max > state.tb.min; }

  function updateTimebar() {
    var sc = scope(); state.scopeNodes = sc.nodes;
    var b = state.graph.timeBounds(sc.nodes); state.tb = b;
    var on = timebarEnabled(), f = state.filter;
    $('tFrom').disabled = $('tTo').disabled = !on; $('tbPlay').disabled = $('tbReset').disabled = !on;
    if (on) {
      $('tFrom').value = f.timeFrom == null ? 0 : sliderOfTime(f.timeFrom);
      $('tTo').value = f.timeTo == null ? 1000 : sliderOfTime(f.timeTo);
    }
    syncTimeLabels(); drawHistogram();
    var txs = 0, stubs = 0;
    state.graph.nodes.forEach(function (n) { if (n.type === 'tx' && sc.nodes.has(n.id)) { if (n.loaded) txs++; else stubs++; } });
    var info = txs + ' transaction' + (txs === 1 ? '' : 's') + ' loaded';
    if (stubs) info += ' · ' + stubs + ' more known, not loaded';
    if (b.pending) info += ' · ' + b.pending + ' unconfirmed';
    if (b.min != null && b.min === b.max) info += ' · all in one moment, nothing to slide';
    $('tbInfo').textContent = info;
  }
  function syncTimeLabels() {
    var b = state.tb, f = state.filter, on = timebarEnabled();
    $('tbFrom').textContent = b.min == null ? '—' : S.fmtTime(f.timeFrom != null ? f.timeFrom : b.min);
    $('tbTo').textContent = b.max == null ? '—' : S.fmtTime(f.timeTo != null ? f.timeTo : b.max);
    var a = on ? Number($('tFrom').value) / 10 : 0, z = on ? Number($('tTo').value) / 10 : 100;
    var fill = $('dualFill'); fill.style.left = a + '%'; fill.style.width = Math.max(0, z - a) + '%';
  }
  function onTimeSlider(which) {
    if (!timebarEnabled()) return;
    var a = Number($('tFrom').value), z = Number($('tTo').value);
    if (a > z) { if (which === 'from') { a = z; $('tFrom').value = a; } else { z = a; $('tTo').value = z; } }
    state.filter.timeFrom = a <= 0 ? null : timeOfSlider(a);
    state.filter.timeTo = z >= 1000 ? null : timeOfSlider(z);
    syncTimeLabels(); drawHistogram(); refresh(); scheduleSave();
  }
  function drawHistogram() {
    var cv = $('hist'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var b = state.tb; if (!timebarEnabled()) return;
    var bins = Math.max(10, Math.floor((w - 16) / 6)), counts = new Array(bins).fill(0), max = 1;
    state.graph.nodes.forEach(function (n) {
      if (n.type !== 'tx' || n.time == null || (state.scopeNodes && !state.scopeNodes.has(n.id))) return;
      var i = Math.min(bins - 1, Math.floor((n.time - b.min) / (b.max - b.min) * bins)); counts[i]++; if (counts[i] > max) max = counts[i];
    });
    var f = state.filter, from = f.timeFrom == null ? b.min : f.timeFrom, to = f.timeTo == null ? b.max : f.timeTo, bw = (w - 16) / bins;
    counts.forEach(function (c, i) {
      if (!c) return;
      var t0 = b.min + i / bins * (b.max - b.min), t1 = b.min + (i + 1) / bins * (b.max - b.min), inside = t1 >= from && t0 <= to;
      ctx.fillStyle = inside ? '#aee7f8' : '#5a4a5a';
      var bh = Math.max(2, (c / max) * (h - 2)); ctx.fillRect(8 + i * bw, h - bh, Math.max(1, bw - 1), bh);
    });
  }
  function resetTime() {
    stopPlay(); state.filter.timeFrom = null; state.filter.timeTo = null;
    $('tFrom').value = 0; $('tTo').value = 1000; syncTimeLabels(); drawHistogram(); refresh(); scheduleSave();
  }
  function stopPlay() { if (state.playTimer) { clearInterval(state.playTimer); state.playTimer = null; } $('tbPlay').textContent = '▶ Replay'; }
  function togglePlay() {
    if (state.playTimer) { stopPlay(); return; }
    if (!timebarEnabled()) return;
    var steps = 120, i = 0;
    state.filter.timeFrom = null; $('tFrom').value = 0; $('tbPlay').textContent = '⏸ Pause';
    state.playTimer = setInterval(function () {
      i++;
      var done = i >= steps;
      state.filter.timeTo = done ? null : Math.round(state.tb.min + (state.tb.max - state.tb.min) * i / steps);
      $('tTo').value = done ? 1000 : Math.round(i / steps * 1000);
      syncTimeLabels(); drawHistogram(); refresh();
      if (done) stopPlay();
    }, state.playMs);
  }

  // ---- layout / colour controls ---------------------------------------------------------------
  function setSeg(groupId, attr, value) {
    Array.prototype.forEach.call($(groupId).querySelectorAll('button'), function (b) { b.setAttribute('aria-checked', b.getAttribute(attr) === value ? 'true' : 'false'); });
  }
  function setLayout(name, o) {
    if (!LAYOUTS[name]) return;
    state.layout = name; setSeg('layoutSeg', 'data-layout', name); $('scaleRow').hidden = name !== 'timeline';
    state.pinned.clear(); refresh({ relayout: true, fit: !o || o.fit !== false }); scheduleSave();
  }
  function setScale(name) {
    if (!SCALES[name]) return;
    state.timeScale = name; setSeg('scaleSeg', 'data-scale', name);
    state.pinned.clear(); refresh({ relayout: true, fit: true }); scheduleSave();
  }
  function setColor(name) {
    if (!COLORS[name]) return;
    state.colorBy = name; setSeg('colorSeg', 'data-color', name); refresh(); scheduleSave();
  }

  // ---- export / import ------------------------------------------------------------------------
  function viewState() { return { layout: state.layout, timeScale: state.timeScale, colorBy: state.colorBy, focus: state.focus, focusOn: state.focusOn, hops: state.hops, fiat: state.fiat, filter: state.filter, source: state.source === 'custom' ? 'clearnet' : state.source }; }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime }), a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function stamp() { var d = new Date(); return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + '-' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function doExport(kind) {
    var g = state.graph;
    if (!g.nodes.size) { toast('Nothing to export yet.', true); return; }
    g.refreshDerived();
    var only = $('exportVisible').checked ? F.computeVisible(g, state.filter, state.keep, focusOpt()) : null;
    var name = 'orion-' + stamp();
    if (fiatOn() && !fiatLoaded() && (kind === 'csv-edges' || kind === 'graphml')) toast('Prices are not loaded, so the fiat columns are empty.', true);
    if (kind === 'json') download(name + '.json', IO.toJson(g, { only: only, view: viewState(), source: sourceBase() }), 'application/json');
    else if (kind === 'csv-nodes') download(name + '-nodes.csv', '﻿' + IO.toCsv(g, 'nodes', { only: only }), 'text/csv;charset=utf-8');
    else if (kind === 'csv-edges') download(name + '-edges.csv', '﻿' + IO.toCsv(g, 'edges', { only: only, fiat: exportFiat() }), 'text/csv;charset=utf-8');
    else if (kind === 'graphml') download(name + '.graphml', IO.toGraphMl(g, { only: only, fiat: exportFiat() }), 'application/xml');
    else if (kind === 'png') { var a = el('a', { href: renderer.toDataUrl(), download: name + '.png' }); document.body.appendChild(a); a.click(); a.remove(); }
    $('exportMenu').open = false;
    log('Exported ' + kind + (only ? ' (visible part)' : ''));
  }

  function applyView(v) {
    if (!v || typeof v !== 'object') return;
    if (LAYOUTS[v.layout]) { state.layout = v.layout; setSeg('layoutSeg', 'data-layout', v.layout); $('scaleRow').hidden = v.layout !== 'timeline'; }
    if (SCALES[v.timeScale]) { state.timeScale = v.timeScale; setSeg('scaleSeg', 'data-scale', v.timeScale); }
    if (COLORS[v.colorBy]) { state.colorBy = v.colorBy; setSeg('colorSeg', 'data-color', v.colorBy); }
    if (typeof v.focusOn === 'boolean') { state.focusOn = v.focusOn; $('focusOn').checked = v.focusOn; }
    if (typeof v.hops === 'number') { state.hops = num(v.hops, 1, 3, 2); $('depth').value = String(state.hops); }
    state.focus = typeof v.focus === 'string' && NV.isId(v.focus) ? canonicalId(v.focus) : null;
    if (v.fiat) { state.fiat = cleanFiat(v.fiat); syncFiatUi(); }
    if (v.filter && typeof v.filter === 'object') {
      var d = F.defaults(), f = v.filter;
      ['timeFrom', 'timeTo', 'maxAmount'].forEach(function (k) { d[k] = typeof f[k] === 'number' && isFinite(f[k]) ? f[k] : null; });
      d.minAmount = typeof f.minAmount === 'number' && f.minAmount > 0 ? Math.floor(f.minAmount) : 0;
      ['includePending', 'includeUnknownTime', 'showData', 'showNonstd'].forEach(function (k) { if (typeof f[k] === 'boolean') d[k] = f[k]; });
      d.hiddenScriptTypes = Array.isArray(f.hiddenScriptTypes) ? f.hiddenScriptTypes.filter(function (s) { return typeof s === 'string'; }).slice(0, 30) : [];
      state.filter = d; syncFilterControls();
    }
  }
  function syncFilterControls() {
    var f = state.filter;
    $('showData').checked = f.showData; $('showNonstd').checked = f.showNonstd; $('incPending').checked = f.includePending; $('incUnknown').checked = f.includeUnknownTime;
  }

  function doImport(text) {
    var r;
    try { r = IO.fromJson(text); } catch (e) { toast('Import failed: ' + e.message, true); return; }
    var wasEmpty = state.graph.nodes.size === 0, g = state.graph;
    r.graph.nodes.forEach(function (n) { g.upsertNode(n); });
    r.graph.edges.forEach(function (e) { g.upsertEdge(e); });
    r.graph.nodes.forEach(function (n) { if (n.label !== undefined || n.note !== undefined) { var cur = g.nodes.get(n.id); if (n.label) cur.label = n.label; if (n.note) cur.note = n.note; } });
    if (wasEmpty) applyView(r.view);
    if (wasEmpty && fiatOn()) ensurePrices();
    if (state.focus && !g.nodes.has(state.focus)) state.focus = null;
    if (wasEmpty && state.focus) { state.keep.add(state.focus); state.nav.reset(); visitNav(state.focus); }
    state.layoutRes = null; state.graph.refreshDerived();
    afterGraphChange({ fit: true }); updateNavUi(); scheduleSave();
    toast('Imported ' + r.graph.nodes.size + ' vertices and ' + r.graph.edges.size + ' edges' + (wasEmpty ? '' : ' (merged into the current workspace)') + '.' + (r.warnings.length ? ' ' + r.warnings.join('; ') + '.' : ''), !!r.warnings.length);
  }

  function clearAll() {
    stopPlay(); state.client.abort(); state.client.resume();
    setGraph(new M.Graph()); state.keep = new Set(); state.pinned = new Map(); state.selected = new Set(); state.selectedEdge = null;
    state.filter.timeFrom = null; state.filter.timeTo = null;
    state.focus = null; state.nav.reset();
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* not allowed here: the old hash stays, harmless */ }
    renderer.cur = new Map(); renderer.target = new Map(); renderer.anim = null;
    afterGraphChange({ fit: true }); syncSelection(); updateNavUi(); store.del(SAVE_KEY); log('Workspace cleared');
  }

  // ---- autosave -------------------------------------------------------------------------------
  function scheduleSave() {
    clearTimeout(saveTimer);
    if (!state.persist) return;
    saveTimer = setTimeout(function () {
      if (!$('restore').hidden) return;                                  // the saved session is still waiting for a decision
      if (!state.graph.nodes.size) { store.del(SAVE_KEY); return; }
      var text = IO.toJson(state.graph, { view: viewState() });
      if (text.length > 3500000 || !store.set(SAVE_KEY, text)) log('Workspace is too large for browser storage; export it to keep it.', true);
    }, 800);
  }
  /**
   * Offers the saved session. Returns true when the banner is shown. Until the user decides, nothing is autosaved, so a
   * reload (whose URL now names the vertex you were on) cannot overwrite the saved labels and notes with a bare graph.
   * `afterDiscard` runs when the saved session is thrown away (e.g. to open the vertex named in the URL instead).
   */
  function offerRestore(afterDiscard) {
    if (!state.persist) return false;
    var raw = store.get(SAVE_KEY); if (!raw) return false;
    var meta; try { meta = JSON.parse(raw); } catch (e) { store.del(SAVE_KEY); return false; }
    if (!meta || meta.format !== IO.FORMAT || !Array.isArray(meta.nodes) || !meta.nodes.length) return false;
    $('restoreText').textContent = 'A saved session with ' + meta.nodes.length + ' vertices from ' + S.fmtTime(Date.parse(meta.exported) / 1000) + ' is stored in this browser.';
    $('restore').hidden = false;
    $('restoreYes').onclick = function () { $('restore').hidden = true; doImport(raw); };
    $('restoreNo').onclick = function () { $('restore').hidden = true; store.del(SAVE_KEY); if (afterDiscard) afterDiscard(); };
    renderer.resize();
    return true;
  }

  // ---- wiring ---------------------------------------------------------------------------------
  function init() {
    renderer = new R.Renderer($('cv'), {
      onSelect: function (id, additive) {
        if (!id) { state.selected = new Set(); state.selectedEdge = null; }
        else if (additive) { if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); state.selectedEdge = null; }
        else { state.selected = new Set([id]); state.selectedEdge = null; }
        syncSelection();
      },
      onSelectEdge: function (id) { state.selected = new Set(); state.selectedEdge = id; syncSelection(); },
      onHover: onHover,
      onMove: function (id, p) { state.pinned.set(id, { x: p.x, y: p.y }); },
      onContext: openCtx,
      onExpand: function (id) { if (state.focusOn) navigate(id); else expandNode(id, 'both'); }
    });
    loadPrefs();
    makeClient();
    $('capTx').value = state.capTx; $('capReq').value = state.capReq; $('capPages').value = state.capPages; $('showLabels').checked = state.showLabels; $('persist').checked = state.persist; $('focusOn').checked = state.focusOn; $('depth').value = String(state.hops);
    applySourceUi(); syncFiatUi(); updateReqStats();
    $('edgeLabels').checked = state.edgeLabels; $('viaWallets').checked = state.viaWallets;
    setSideCollapsed(state.sideCollapsed); setInspCollapsed(state.inspCollapsed);

    $('searchForm').addEventListener('submit', function (e) { e.preventDefault(); openQuery($('q').value); });
    // the box shows the proper form of whatever was pasted
    function tidyQuery() { var r = A.checkQuery($('q').value); if (r.ok) $('q').value = r.value; }
    $('q').addEventListener('change', tidyQuery);
    $('q').addEventListener('paste', function () { setTimeout(tidyQuery, 0); });
    $('fiatCur').addEventListener('change', function () {
      state.fiat.currency = this.value; savePrefs(); scheduleSave(); syncFiatUi(); ensurePrices();
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name=fiatBasis]'), function (r) {
      r.addEventListener('change', function () {
        if (!r.checked) return;
        state.fiat.basis = r.value; savePrefs(); scheduleSave(); syncFiatUi();
        if (r.value === 'ref' && !state.fiat.ref) pickRefQuietly();
        else ensurePrices();
      });
    });
    $('fiatPick').addEventListener('click', pickRef);
    function pickRefQuietly() {
      var n = refCandidate();
      if (n) setRef(n); else ensurePrices();                                                                           // nothing suitable yet: today's price is used until one is chosen
    }
    // external sources
    $('arkUrl').value = state.ext.proxy; $('arkToken').value = state.ext.token; $('arkRemember').checked = state.ext.remember;
    $('arkUrl').addEventListener('change', function () {
      var u = this.value.trim().replace(/\/+$/, '');
      if (!proxyUrlOk(u)) { toast('The lookup proxy must run on this machine (http://127.0.0.1:…) or use https: the token would otherwise travel in the clear.', true); this.value = state.ext.proxy; return; }
      state.ext.proxy = u; this.value = u; savePrefs();
    });
    $('arkToken').addEventListener('input', function () { state.ext.token = this.value.trim(); if (state.ext.remember) store.set(TOKEN_KEY, state.ext.token); });
    $('arkRemember').addEventListener('change', function () {
      state.ext.remember = this.checked; savePrefs();
      if (this.checked) store.set(TOKEN_KEY, state.ext.token); else store.del(TOKEN_KEY);
    });
    $('arkTest').addEventListener('click', function () {
      var out = $('arkResult'); out.className = ''; out.textContent = 'Testing…';
      XT.proxyHealth({ fetch: window.fetch.bind(window), base: state.ext.proxy, token: state.ext.token }).then(function (h) {
        out.className = h.keyConfigured ? 'ok' : 'bad';
        out.textContent = h.keyConfigured ? 'Proxy reachable, API key configured (' + String(h.upstream || '').replace(/^https?:\/\//, '') + ').' : 'Proxy reachable, but it has no API key.';
      }, function (e) { out.className = 'bad'; out.textContent = e.message; });
    });
    document.addEventListener('mousedown', function (e) { if (!$('ctxMenu').hidden && !$('ctxMenu').contains(e.target)) closeCtx(); });
    $('ctxMenu').addEventListener('keydown', function (e) { ctxKeys(e); });
    window.addEventListener('blur', closeCtx);
    $('stepPrev').addEventListener('click', function () { stepClick('prev'); });
    $('stepNext').addEventListener('click', function () { stepClick('next'); });
    $('stepLoad').addEventListener('click', function () { if (state.focus) expandNode(state.focus); });
    $('viaWallets').addEventListener('change', function () { state.viaWallets = this.checked; savePrefs(); renderStepBar(); });
    document.addEventListener('click', function (e) { if (!$('stepMenu').hidden && !$('stepbar').contains(e.target)) closeStepMenu(); });
    $('sideCollapse').addEventListener('click', function () { setSideCollapsed(true); });
    $('sideTab').addEventListener('click', function () { setSideCollapsed(false); });
    $('inspCollapse').addEventListener('click', function () { setInspCollapsed(true); });
    $('inspTab').addEventListener('click', function () { setInspCollapsed(false); });
    $('edgeLabels').addEventListener('change', function () { state.edgeLabels = this.checked; savePrefs(); refresh(); });
    Array.prototype.forEach.call($('showSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setShow(b.getAttribute('data-show')); }); });
    $('btnAmounts').addEventListener('click', function () { setShow({ both: 'fiat', fiat: 'btc', btc: 'both' }[state.fiat.show] || 'both'); });
    $('navBack').addEventListener('click', function () { stepNav(-1); });
    $('navFwd').addEventListener('click', function () { stepNav(1); });
    window.addEventListener('popstate', onPopState);
    $('focusOn').addEventListener('change', function () {
      state.focusOn = this.checked; savePrefs();
      if (state.focusOn && !state.focus) state.focus = state.nav.current() || Array.from(state.selected)[0] || null;
      if (state.focus) state.keep.add(state.focus);
      afterGraphChange({ fit: true }); scheduleSave();
    });
    $('depth').addEventListener('change', function () { state.hops = num(this.value, 1, 3, 2); savePrefs(); afterGraphChange({ fit: true }); scheduleSave(); });
    $('btnFit').addEventListener('click', function () { renderer.fit(); });
    $('btnRelayout').addEventListener('click', function () { state.pinned.clear(); refresh({ relayout: true, fit: true }); });
    $('zoomIn').addEventListener('click', function () { renderer.zoomBy(1.3); });
    $('zoomOut').addEventListener('click', function () { renderer.zoomBy(1 / 1.3); });
    $('cancel').addEventListener('click', function () { state.client.abort(); });
    $('sample').addEventListener('click', function () { $('q').value = SAMPLE; openQuery(SAMPLE); });
    $('emptyImport').addEventListener('click', function () { $('fileImport').click(); });
    $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
    $('fileImport').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      if (f.size > 60 * 1024 * 1024) { toast('That file is too large (limit 60 MB).', true); return; }
      var rd = new FileReader(); rd.onload = function () { doImport(String(rd.result)); }; rd.onerror = function () { toast('Could not read the file.', true); }; rd.readAsText(f);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-export]'), function (b) { b.addEventListener('click', function () { doExport(b.getAttribute('data-export')); }); });
    $('btnClear').addEventListener('click', function () {
      var b = $('btnClear');
      if (!state.graph.nodes.size) return;
      if (b.dataset.armed) { clearTimeout(clearTimer); delete b.dataset.armed; b.textContent = 'Clear'; clearAll(); return; }
      b.dataset.armed = '1'; b.textContent = 'Click again to clear';
      clearTimer = setTimeout(function () { delete b.dataset.armed; b.textContent = 'Clear'; }, 3000);
    });
    $('btnSide').addEventListener('click', function () { document.body.classList.toggle('side-open'); });
    $('inspClose').addEventListener('click', function () { state.selected = new Set(); state.selectedEdge = null; syncSelection(); });

    // source
    $('source').addEventListener('change', function () { state.source = this.value; applySourceUi(); makeClient(); savePrefs(); });
    $('customBase').addEventListener('change', function () { state.customBase = this.value.trim(); makeClient(); savePrefs(); });
    $('testSource').addEventListener('click', function () {
      var out = $('testResult'), t0 = performance.now();
      if (state.source === 'custom' && !/^https?:\/\//i.test(state.customBase.trim())) { out.textContent = 'Enter a URL first.'; out.className = 'bad'; return; }
      out.textContent = 'Testing…'; out.className = '';
      var probe = new A.Client({ base: sourceBase(), timeoutMs: A.PRESETS[state.source].timeoutMs, retries: 0, delayMs: 0 });
      probe.tipHeight().then(function (h) { out.textContent = 'OK: chain height ' + fmtInt(h) + ' in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s'; out.className = 'ok'; },
        function (e) { out.textContent = 'Failed: ' + e.message + (state.source === 'tor' ? ' (open this page in Tor Browser)' : ''); out.className = 'bad'; });
    });

    // view
    Array.prototype.forEach.call($('layoutSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setLayout(b.getAttribute('data-layout')); }); });
    Array.prototype.forEach.call($('scaleSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setScale(b.getAttribute('data-scale')); }); });
    Array.prototype.forEach.call($('colorSeg').querySelectorAll('button'), function (b) { b.addEventListener('click', function () { setColor(b.getAttribute('data-color')); }); });
    $('showLabels').addEventListener('change', function () { state.showLabels = this.checked; refresh(); savePrefs(); });
    $('persist').addEventListener('change', function () {
      state.persist = this.checked; savePrefs();
      if (state.persist) scheduleSave(); else { clearTimeout(saveTimer); store.del(SAVE_KEY); toast('Saved session deleted from this browser.'); }
    });

    // filters
    $('minAmount').addEventListener('input', function () { setMinAmount(amountFromSlider(this.value), true); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-min]'), function (b) { b.addEventListener('click', function () { setMinAmount(Number(b.getAttribute('data-min')), false); }); });
    [['showData', 'showData'], ['showNonstd', 'showNonstd'], ['incPending', 'includePending'], ['incUnknown', 'includeUnknownTime']].forEach(function (p) {
      $(p[0]).addEventListener('change', function () { state.filter[p[1]] = this.checked; refresh({ relayout: p[1] === 'showData' || p[1] === 'showNonstd' }); scheduleSave(); });
    });
    ['capTx', 'capReq', 'capPages'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state.capTx = num($('capTx').value, 1, 500, 25); state.capReq = num($('capReq').value, 1, 1000, 80); state.capPages = num($('capPages').value, 1, 20, 2);
        $('capTx').value = state.capTx; $('capReq').value = state.capReq; $('capPages').value = state.capPages; savePrefs();
      });
    });

    // time
    $('tFrom').addEventListener('input', function () { stopPlay(); onTimeSlider('from'); });
    $('tTo').addEventListener('input', function () { stopPlay(); onTimeSlider('to'); });
    $('tbReset').addEventListener('click', resetTime);
    $('tbPlay').addEventListener('click', togglePlay);

    // keyboard
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!$('ctxMenu').hidden && e.key === 'Escape') { closeCtx(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { if (state.selected.size) { e.preventDefault(); removeIds(Array.from(state.selected)); } }
      else if (e.key === 'Escape') { if (!$('stepMenu').hidden) closeStepMenu(); else { state.selected = new Set(); state.selectedEdge = null; syncSelection(); } }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        var id = state.selected.size ? Array.from(state.selected)[0] : state.focus;
        if (id && state.graph.nodes.has(id)) { e.preventDefault(); openCtx(id, null, clientPosOf(id)); }
      }
      else if (e.key === '[') { e.preventDefault(); stepClick('prev'); }
      else if (e.key === ']') { e.preventDefault(); stepClick('next'); }
      else if (e.key === 'c' || e.key === 'C') { setSideCollapsed(!state.sideCollapsed); }
      else if (e.key === 'd' || e.key === 'D') { setInspCollapsed(!state.inspCollapsed); }
      else if (e.key === 'f' || e.key === 'F') { renderer.fit(); }
      else if (e.key === '/') { e.preventDefault(); $('q').focus(); }
    });
    window.addEventListener('resize', function () { renderer.resize(); drawHistogram(); });
    if (typeof ResizeObserver === 'function') new ResizeObserver(function () { renderer.resize(); if (renderer.autoFit) renderer.fit(); drawHistogram(); }).observe($('stage'));

    updateLegend(); updateTimebar(); updateAmount(); updateScriptChips();
    refresh({ relayout: true });
    var hp = NV.parseHash(location.hash);
    if (hp) hp.id = canonicalId(hp.id);
    var q = new URLSearchParams(location.search).get('q');
    var src = new URLSearchParams(location.search).get('source');
    if (src && A.PRESETS[src] && src !== 'custom') { state.source = src; applySourceUi(); makeClient(); }
    var openTarget = null;
    if (hp && (hp.id.indexOf('tx:') === 0 || hp.id.indexOf('addr:') === 0)) openTarget = function () { navigate(hp.id); };
    else if (q) openTarget = function () { $('q').value = q; openQuery(q); };
    if (!offerRestore(openTarget) && openTarget) openTarget();
    updateNavUi();
    if (fiatOn()) ensurePrices();
  }

  window.__orion = { state: state, refresh: refresh, afterGraphChange: afterGraphChange, navigate: navigate, fiatOf: fiatOf, openCtx: openCtx, lookupArkham: lookupArkham, renderStepBar: renderStepBar, stepClick: stepClick, get renderer() { return renderer; } };   // read by the end-to-end tests
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}());
