/*
 * Orion external lookups: ask a third-party service about ONE wallet, on request. Never run over the whole graph.
 *
 * Arkham Intelligence has no CORS headers, so a web page cannot call it. The lookup goes to a small local proxy
 * (tools/arkham_proxy.py) that holds the API key in an environment variable and forwards only
 * GET /intelligence/address/<address>. This module builds that request and reads the reply.
 *
 * The reply is parsed from Arkham's documented field names (arkhamEntity, arkhamLabel, populatedTags, predictedEntity).
 * Their reference could not be read when this was written and no live key was available, so the parser is tolerant, the
 * raw reply is always kept, and nothing is applied to a wallet automatically.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./orion-tags.js'));
  else root.OrionExternal = factory(root.OrionTags);
}(typeof self !== 'undefined' ? self : this, function (Tags) {
  'use strict';

  var SOURCES = { arkham: { id: 'arkham', name: 'Arkham Intelligence' } };
  var RAW_LIMIT = 4000;

  function text(v, max) {
    if (typeof v !== 'string' && typeof v !== 'number') return '';
    return String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }
  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

  /** The object that carries the intelligence: the reply itself, or the first value inside it that does. */
  function pick(json) {
    if (!isObj(json)) return null;
    var keys = ['arkhamEntity', 'arkhamLabel', 'populatedTags', 'predictedEntity', 'entity', 'label'];
    if (keys.some(function (k) { return k in json; })) return json;
    var vals = Object.keys(json).map(function (k) { return json[k]; });
    for (var i = 0; i < vals.length; i++) if (isObj(vals[i]) && keys.some(function (k) { return k in vals[i]; })) return vals[i];
    return json;
  }

  /** Read an Arkham address reply into plain text fields. `found` is false when it names nobody. */
  function parseArkham(json) {
    var o = pick(json) || {};
    var ent = isObj(o.arkhamEntity) ? o.arkhamEntity : isObj(o.entity) ? o.entity : {};
    var lab = isObj(o.arkhamLabel) ? o.arkhamLabel : isObj(o.label) ? o.label : {};
    var pred = isObj(o.predictedEntity) ? o.predictedEntity : {};
    var tags = (Array.isArray(o.populatedTags) ? o.populatedTags : []).map(function (t) {
      return isObj(t) ? text(t.label || t.id || t.name, 40) : text(t, 40);
    }).filter(Boolean).slice(0, 12);
    var out = { name: text(ent.name), type: text(ent.type, 40), label: text(lab.name), tags: tags, website: text(ent.website, 200), note: text(ent.note, 300),
                predicted: text(pred.name || (isObj(pred.entity) ? pred.entity.name : '')) };
    out.found = !!(out.name || out.label || out.tags.length || out.predicted);
    return out;
  }

  /** A preset tag id that fits an Arkham entity type or name, or ''. A suggestion only: the user decides. */
  function tagFor(type, name) {
    var s = (text(type, 40) + ' ' + text(name, 80)).toLowerCase();
    if (/mixer|tumbl|coinjoin/.test(s)) return 'MIXER';
    if (/hack|exploit|scam|ransom|thief|stolen|threat|sanction|lazarus|darknet\s*market/.test(s)) return /market/.test(s) && !/hack|scam|ransom/.test(s) ? 'MARKET' : 'THREAT';
    if (/market/.test(s)) return 'MARKET';
    if (/gambl|casino|betting|\bbet\b/.test(s)) return 'GAMBLING';
    if (/\bcex\b|exchange|binance|coinbase|kraken|okx|bitfinex|huobi|kucoin|bybit|bitstamp|gemini/.test(s)) return 'EXCH';
    if (/payment|merchant|processor|\bpay\b/.test(s)) return 'SERVICE';
    return '';
  }

  /** The entry that is stored on a wallet: parsed fields, when, and (capped) the raw reply for the record. */
  function toExt(json, at) {
    var p = parseArkham(json), raw = '';
    try { raw = JSON.stringify(json); } catch (e) { raw = ''; }
    if (raw.length > RAW_LIMIT) raw = raw.slice(0, RAW_LIMIT) + '…';
    p.at = typeof at === 'number' ? at : Math.floor(Date.now() / 1000);
    p.raw = raw;
    p.suggest = tagFor(p.type, p.name || p.label);
    return p;
  }

  /** Validate an `ext` object read from a file. Unknown sources and unknown fields are dropped. */
  function cleanExt(ext) {
    if (!isObj(ext)) return null;
    var out = {};
    if (isObj(ext.arkham)) {
      var a = ext.arkham;
      var c = { found: a.found === true, name: text(a.name), type: text(a.type, 40), label: text(a.label), website: text(a.website, 200), note: text(a.note, 300),
                predicted: text(a.predicted), at: typeof a.at === 'number' && isFinite(a.at) ? Math.floor(a.at) : 0, raw: typeof a.raw === 'string' ? a.raw.slice(0, RAW_LIMIT + 1) : '',
                tags: (Array.isArray(a.tags) ? a.tags : []).map(function (t) { return text(t, 40); }).filter(Boolean).slice(0, 12) };
      c.suggest = Tags.preset(a.suggest) ? a.suggest : '';
      out.arkham = c;
    }
    return Object.keys(out).length ? out : null;
  }

  function fail(kind, message, status) { var e = new Error(message); e.kind = kind; e.status = status; return e; }

  /**
   * Ask the proxy about one address. Resolves { found, ext } (found false when Arkham knows nothing); rejects with
   * an Error whose .kind is 'proxy' | 'token' | 'rate' | 'key' | 'upstream' | 'timeout' | 'bad'.
   * opts: { fetch, base, token, address, timeoutMs }
   */
  function lookupArkham(opts) {
    var base = String(opts.base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return Promise.reject(fail('proxy', 'Enter the address of the lookup proxy first.'));
    if (!opts.token) return Promise.reject(fail('token', 'Enter the proxy token first (it is printed when the proxy starts).'));
    var ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = null, timedOut = false;
    if (ctl) timer = setTimeout(function () { timedOut = true; ctl.abort(); }, opts.timeoutMs || 25000);
    return opts.fetch(base + '/intelligence/address/' + encodeURIComponent(opts.address), { headers: { 'X-Orion-Token': opts.token, 'Accept': 'application/json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (res) {
        return res.text().then(function (body) {
          var json = null; try { json = JSON.parse(body); } catch (e) { json = null; }
          var msg = json && typeof json.error === 'string' ? text(json.error, 300) : '';
          if (res.status === 404) return { found: false, ext: toExt({}, undefined) };
          if (res.status === 401) throw fail('token', msg || 'The proxy rejected the token.', 401);
          if (res.status === 429) throw fail('rate', msg || 'Rate limit reached: wait a moment and try again.', 429);
          if (res.status === 403 || res.status === 502 && /key/i.test(msg)) throw fail('key', msg || 'Arkham rejected the API key.', res.status);
          if (!res.ok) throw fail('upstream', msg || 'The lookup failed (HTTP ' + res.status + ').', res.status);
          if (json === null) throw fail('bad', 'The proxy answered with something that is not JSON.', res.status);
          var ext = toExt(json);
          return { found: ext.found, ext: ext };
        });
      }, function (e) {
        if (timedOut) throw fail('timeout', 'The proxy did not answer in time.');
        throw fail('proxy', 'Could not reach the proxy at ' + base + '. Is tools/arkham_proxy.py running? (' + (e && e.message ? e.message : e) + ')');
      }).then(function (v) { if (timer) clearTimeout(timer); return v; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  /** GET /health on the proxy: { ok, keyConfigured, upstream }. */
  function proxyHealth(opts) {
    var base = String(opts.base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return Promise.reject(fail('proxy', 'Enter the address of the lookup proxy first.'));
    return opts.fetch(base + '/health', { headers: { 'X-Orion-Token': opts.token || '' } }).then(function (res) {
      if (res.status === 401) throw fail('token', 'The proxy is running but rejected the token.', 401);
      if (!res.ok) throw fail('proxy', 'The proxy answered HTTP ' + res.status + '.', res.status);
      return res.json();
    }, function (e) { throw fail('proxy', 'Could not reach the proxy at ' + base + '. Is tools/arkham_proxy.py running? (' + (e && e.message ? e.message : e) + ')'); });
  }

  return { SOURCES: SOURCES, parseArkham: parseArkham, tagFor: tagFor, toExt: toExt, cleanExt: cleanExt, lookupArkham: lookupArkham, proxyHealth: proxyHealth, RAW_LIMIT: RAW_LIMIT };
}));
