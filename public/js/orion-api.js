/*
 * Orion data source: an Esplora / mempool.space client with the behaviour a public API needs
 * (request queue, concurrency and spacing, timeout, retry with backoff, response cache, request cap),
 * plus the expansion operations that turn responses into graph vertices.
 *
 * `fetch` is injected so tests run without a network.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-model.js'), require('./orion-address.js'));
  else root.OrionApi = factory(root.OrionModel, root.OrionAddress);
}(typeof self !== 'undefined' ? self : this, function (Model, Addr) {
  'use strict';

  var ID = Model.ID;

  var ONION = 'http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion/api';
  // Tor is slow and its exit/circuit capacity is shared: fewer parallel requests, more spacing, longer timeout.
  // `prices`: where fiat prices come from when this source is chosen. Esplora servers other than mempool have no price API.
  var MEMPOOL = 'https://mempool.space/api';
  var PRESETS = {
    clearnet:   { label: 'mempool.space',                      base: MEMPOOL,                         concurrency: 4, delayMs: 150, timeoutMs: 20000, retries: 3, prices: MEMPOOL },
    tor:        { label: 'mempool.space over Tor (.onion)',    base: ONION,                           concurrency: 2, delayMs: 800, timeoutMs: 60000, retries: 3, prices: ONION },
    blockstream:{ label: 'Blockstream.info',                   base: 'https://blockstream.info/api',  concurrency: 3, delayMs: 250, timeoutMs: 25000, retries: 3, prices: MEMPOOL },
    custom:     { label: 'My own Esplora URL',                 base: '',                              concurrency: 4, delayMs: 150, timeoutMs: 30000, retries: 3, prices: null }
  };

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function ApiError(message, kind, status) {
    var e = new Error(message); e.kind = kind; e.status = status; return e;
  }

  /**
   * opts: { base, concurrency, delayMs, timeoutMs, retries, maxRequests, fetch, onRequest }
   * maxRequests: hard cap of network requests for this client (cache hits are free). 0/undefined = none.
   */
  function Client(opts) {
    opts = opts || {};
    this.base = String(opts.base || PRESETS.clearnet.base).replace(/\/+$/, '');
    this.concurrency = Math.max(1, opts.concurrency || 4);
    this.delayMs = opts.delayMs == null ? 150 : opts.delayMs;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.retries = opts.retries == null ? 3 : opts.retries;
    this.maxRequests = opts.maxRequests || 0;
    this.backoffMs = opts.backoffMs == null ? 1000 : opts.backoffMs;
    this.fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    this.onRequest = opts.onRequest || null;
    this.cache = new Map();                              // key -> { p: Promise, at: ms }
    this.ttlMs = opts.ttlMs == null ? 300000 : opts.ttlMs;
    this.now = opts.now || Date.now;
    this.queue = [];
    this.active = 0;
    this.lastStart = 0;
    this.aborted = false;
    this.controllers = new Set();
    this.count = { network: 0, cached: 0, failed: 0, retried: 0 };
    this.total = { network: 0, failed: 0, retried: 0 };          // since the client was made: resetCount() does not touch these
  }

  Client.prototype.abort = function () {
    this.aborted = true;
    this.controllers.forEach(function (c) { try { c.abort(); } catch (e) { /* ignore */ } });
    var q = this.queue; this.queue = [];
    q.forEach(function (j) { j.reject(ApiError('aborted', 'aborted')); });
  };
  /** Allow requests again after abort() (a new action starts). */
  Client.prototype.resume = function () { this.aborted = false; };
  Client.prototype.resetCount = function () { this.count = { network: 0, cached: 0, failed: 0, retried: 0 }; };

  Client.prototype._pump = function () {
    var self = this;
    while (this.active < this.concurrency && this.queue.length) {
      var job = this.queue.shift();
      this.active++;
      (function (j) {
        var wait = Math.max(0, self.lastStart + self.delayMs - Date.now());
        self.lastStart = Date.now() + wait;               // reserve the slot so parallel starts are spaced too
        sleep(wait).then(function () { return self._run(j); }).then(j.resolve, j.reject).then(function () {
          self.active--; self._pump();
        });
      })(job);
    }
  };

  Client.prototype._attempt = function (path, text) {
    var self = this;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = null, timedOut = false;
    if (ctl) { this.controllers.add(ctl); timer = setTimeout(function () { timedOut = true; ctl.abort(); }, this.timeoutMs); }
    var p = this.fetchImpl(this.base + path, ctl ? { signal: ctl.signal, headers: { 'Accept': 'application/json, text/plain' } } : {})
      .then(function (res) {
        if (!res.ok) {
          var err = ApiError('HTTP ' + res.status + ' for ' + path, res.status === 429 ? 'rate' : (res.status >= 500 ? 'server' : 'http'), res.status);
          err.retryAfter = Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0;
          if (res.status === 400 || res.status === 404) err.kind = 'notfound';
          throw err;
        }
        return res.text();
      })
      .then(function (body) {
        if (text) return body.trim();
        try { return JSON.parse(body); } catch (e) { throw ApiError('invalid JSON from ' + path, 'parse'); }
      });
    return p.then(function (v) { clean(); return v; }, function (e) {
      clean();
      if (timedOut) throw ApiError('timeout after ' + self.timeoutMs + ' ms for ' + path, 'timeout');
      if (self.aborted) throw ApiError('aborted', 'aborted');
      if (e && e.kind) throw e;
      throw ApiError('network error for ' + path + (e && e.message ? ' (' + e.message + ')' : ''), 'network');
    });
    function clean() { if (timer) clearTimeout(timer); if (ctl) self.controllers.delete(ctl); }
  };

  Client.prototype._run = function (job) {
    var self = this, tries = 0;
    function go() {
      if (self.aborted) return Promise.reject(ApiError('aborted', 'aborted'));
      if (self.maxRequests && self.count.network >= self.maxRequests) return Promise.reject(ApiError('request cap of ' + self.maxRequests + ' reached', 'cap'));
      self.count.network++; self.total.network++;
      if (self.onRequest) self.onRequest(job.path, self.count);
      return self._attempt(job.path, job.text).catch(function (e) {
        var retryable = e.kind === 'rate' || e.kind === 'server' || e.kind === 'timeout' || e.kind === 'network';
        if (!retryable || tries >= self.retries) { self.count.failed++; self.total.failed++; throw e; }
        tries++; self.count.retried++; self.total.retried++;
        var delay = Math.max(e.retryAfter ? e.retryAfter * 1000 : 0, self.backoffMs * Math.pow(2, tries - 1));
        return sleep(delay).then(go);
      });
    }
    return go();
  };

  /** GET path (relative to base). Cached per client; concurrent identical requests share one call. */
  Client.prototype.get = function (path, text) {
    var self = this, key = (text ? 'T ' : 'J ') + path;
    var hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) { this.count.cached++; return hit.p; }
    if (this.aborted) return Promise.reject(ApiError('aborted', 'aborted'));
    var p = new Promise(function (resolve, reject) {
      self.queue.push({ path: path, text: !!text, resolve: resolve, reject: reject });
      self._pump();
    });
    var entry = { p: p, at: this.now() };
    this.cache.set(key, entry);
    p.catch(function () { if (self.cache.get(key) === entry) self.cache.delete(key); });          // never cache a failure
    return p;
  };

  Client.prototype.tx = function (txid) { return this.get('/tx/' + encodeURIComponent(txid)); };
  Client.prototype.outspends = function (txid) { return this.get('/tx/' + encodeURIComponent(txid) + '/outspends'); };
  Client.prototype.address = function (a) { return this.get('/address/' + encodeURIComponent(a)); };
  Client.prototype.addressTxs = function (a, afterTxid) {
    return this.get('/address/' + encodeURIComponent(a) + '/txs' + (afterTxid ? '/chain/' + encodeURIComponent(afterTxid) : ''));
  };
  /** Today's prices in every supported currency (mempool.space API). */
  Client.prototype.prices = function () { return this.get('/v1/prices'); };
  /** The whole price history for a currency: one request, ~25,000 points (see orion-price.js). */
  Client.prototype.historicalPrices = function (currency) { return this.get('/v1/historical-price?currency=' + encodeURIComponent(currency)); };
  Client.prototype.tipHeight = function () { return this.get('/blocks/tip/height', true).then(Number); };

  // ---- expansion ------------------------------------------------------------------------------
  function isTxid(s) { return /^[0-9a-fA-F]{64}$/.test(s || ''); }

  /**
   * Turns what was typed or pasted into {kind:'tx'|'addr', value} or null. Tolerates surrounding spaces, a
   * `bitcoin:` URI, and capitalisation: bech32 addresses (bc1...) are case-insensitive but the API rejects mixed case
   * (autocorrect often capitalises the first letter), so they are lower-cased; base58 addresses are case-sensitive
   * and left alone.
   */
  function normaliseQuery(q) {
    q = String(q == null ? '' : q).trim().replace(/^bitcoin:/i, '').split(/[?#]/)[0].trim();
    var link = /\/(?:address|tx)\/([A-Za-z0-9]+)\/?$/.exec(q);          // https://mempool.space/address/BC1Q... , blockstream.info/tx/...
    if (link) q = link[1];
    if (isTxid(q)) return { kind: 'tx', value: q.toLowerCase() };
    if (/^(bc1|tb1|bcrt1)[0-9a-z]{6,}$/i.test(q)) return { kind: 'addr', value: Addr.normalise(q) };
    if (/^[A-Za-z0-9]{14,90}$/.test(q)) return { kind: 'addr', value: q };
    return null;
  }

  /** normaliseQuery plus a local check of the address checksum: {ok:true, kind, value} or {ok:false, message}. */
  function checkQuery(q) {
    var n = normaliseQuery(q);
    if (!n) return { ok: false, message: 'That does not look like a transaction id (64 hex characters) or a Bitcoin address.' };
    if (n.kind === 'addr') {
      var v = Addr.validate(n.value);
      if (!v.ok) return { ok: false, message: Addr.explain(v) };
    }
    return { ok: true, kind: n.kind, value: n.value };
  }

  /**
   * Explorer: turns API responses into graph content. Every operation resolves to
   * { added: <new vertices>, requests: <network calls>, truncated: bool, errors: [string] } and never rejects
   * for a single failed request: a partial result is better than none, and errors are reported.
   */
  function Explorer(client, graph) { this.client = client; this.graph = graph; }

  function summarise(ex, before, errors, truncated) {
    return { added: ex.graph.nodes.size - before.n, addedEdges: ex.graph.edges.size - before.e,
             requests: ex.client.count.network - before.r, truncated: !!truncated, errors: errors };
  }
  function snap(ex) { return { n: ex.graph.nodes.size, e: ex.graph.edges.size, r: ex.client.count.network }; }
  function note(errors, e) { if (e && e.kind !== 'aborted') errors.push(e.message); return e && e.kind === 'aborted'; }

  /** Load one transaction and which of its outputs are spent. */
  Explorer.prototype.loadTx = function (txid) {
    var ex = this, before = snap(this), errors = [];
    return this.client.tx(txid).then(function (t) {
      ex.graph.addTx(t);
      return ex.client.outspends(txid).then(function (o) { ex.graph.addOutspends(txid, o); }, function (e) { note(errors, e); });
    }).then(function () { return summarise(ex, before, errors, false); }, function (e) {
      note(errors, e); var r = summarise(ex, before, errors, false); r.failed = true; return r;
    });
  };

  // Fetch a list of full transactions (capped) into the graph. Resolves with how many were left out.
  Explorer.prototype._loadMany = function (txids, cap, errors, withOutspends) {
    var ex = this, todo = [], left = 0;
    txids.forEach(function (id) {
      var n = ex.graph.nodes.get(ID.tx(id));
      if (n && n.loaded) return;
      if (cap > 0 && todo.length >= cap) { left++; return; }
      todo.push(id);
    });
    return Promise.all(todo.map(function (id) {
      return ex.client.tx(id).then(function (t) {
        ex.graph.addTx(t);
        if (withOutspends) return ex.client.outspends(id).then(function (o) { ex.graph.addOutspends(id, o); });
      }).catch(function (e) { note(errors, e); });
    })).then(function () { return left; });
  };

  /**
   * Expand a transaction. direction: 'forward' (who spent its outputs), 'backward' (what funded it), 'both'.
   * cap = at most this many transactions are fetched per direction.
   */
  Explorer.prototype.expandTx = function (txid, direction, cap) {
    var ex = this, before = snap(this), errors = [], truncated = false;
    direction = direction || 'both'; cap = cap == null ? 25 : cap;
    var node = this.graph.nodes.get(ID.tx(txid));
    var ready = node && node.loaded ? Promise.resolve() : this.loadTx(txid).then(function () { node = ex.graph.nodes.get(ID.tx(txid)); });
    return ready.then(function () {
      var jobs = [];
      if ((direction === 'forward' || direction === 'both') && node) {
        var p = node.outspendsLoaded ? Promise.resolve() : ex.client.outspends(txid).then(function (o) { ex.graph.addOutspends(txid, o); }).catch(function (e) { note(errors, e); });
        jobs.push(p.then(function () {
          var spenders = [];
          ex.graph.edgesOf(ID.tx(txid)).forEach(function (e) { if (e.kind === 'out' && e.source === ID.tx(txid) && e.spentBy) spenders.push(e.spentBy.txid); });
          return ex._loadMany(spenders, cap, errors, false).then(function (left) { if (left) truncated = true; });
        }));
      }
      if ((direction === 'backward' || direction === 'both') && node && !node.coinbase) {
        var funders = [];
        ex.graph.edgesOf(ID.tx(txid)).forEach(function (e) { if (e.kind === 'in' && e.target === ID.tx(txid) && e.prev) funders.push(e.prev.txid); });
        jobs.push(ex._loadMany(funders, cap, errors, true).then(function (left) { if (left) truncated = true; }));
      }
      return Promise.all(jobs);
    }).then(function () { return summarise(ex, before, errors, truncated); });
  };

  /**
   * Expand an address: its transaction history, newest first, 25 per page.
   * opts: { pages (default 1), cap (max txs added, default 100), after (txid to continue from) }
   * Resolves with .last = txid to continue from (null when the history is exhausted) and .total = chain tx count.
   */
  Explorer.prototype.expandAddress = function (addr, opts) {
    opts = opts || {};
    var ex = this, before = snap(this), errors = [], truncated = false;
    var pages = opts.pages || 1, cap = opts.cap == null ? 100 : opts.cap, added = 0, total = null, last = opts.after || null;
    var node = ex.graph.nodes.get(ID.addr(addr));
    if (!node) ex.graph.upsertNode({ id: ID.addr(addr), type: 'addr', address: addr });

    function step(page) {
      if (page >= pages) return Promise.resolve();
      return ex.client.addressTxs(addr, last).then(function (txs) {
        for (var i = 0; i < txs.length; i++) {
          if (cap > 0 && added >= cap) { truncated = true; return; }
          ex.graph.addTx(txs[i]); added++;
          last = txs[i].txid;
        }
        if (txs.length < 25) { last = null; return; }
        if (cap > 0 && added >= cap) { truncated = true; return; }
        return step(page + 1);
      });
    }
    var stats = opts.after ? Promise.resolve(true) : ex.client.address(addr).then(function (a) {
      total = (a.chain_stats ? a.chain_stats.tx_count : 0) + (a.mempool_stats ? a.mempool_stats.tx_count : 0);
      ex.graph.upsertNode({ id: ID.addr(addr), type: 'addr', address: addr, txCount: total });
      return true;
    }, function (e) {
      if (e && (e.status === 400 || e.kind === 'notfound')) errors.push('"' + addr + '" is not a valid Bitcoin address (the server rejected it)');
      else note(errors, e);
      return false;                                          // without the summary the history request would only fail too
    });
    return stats.then(function (ok) { return ok ? step(0) : null; }).catch(function (e) { note(errors, e); }).then(function () {
      var me = ex.graph.nodes.get(ID.addr(addr));
      if (me && ex.graph.edgesOf(me.id).length === 0 && errors.length) ex.graph.removeNode(me.id);   // a failed lookup leaves nothing behind
      var r = summarise(ex, before, errors, truncated);
      r.last = last; r.total = total; r.addedTx = added;
      return r;
    });
  };

  /** Search box: a 64-hex string is a transaction, anything else is treated as an address. */
  Explorer.prototype.open = function (query, opts) {
    var q = normaliseQuery(query) || { kind: 'addr', value: String(query || '').trim() };
    if (q.kind === 'tx') return this.loadTx(q.value).then(function (r) { r.kind = 'tx'; r.id = ID.tx(q.value); return r; });
    return this.expandAddress(q.value, opts).then(function (r) { r.kind = 'addr'; r.id = ID.addr(q.value); return r; });
  };

  return { Client: Client, Explorer: Explorer, PRESETS: PRESETS, ONION: ONION, isTxid: isTxid, normaliseQuery: normaliseQuery, checkQuery: checkQuery, ApiError: ApiError };
}));
