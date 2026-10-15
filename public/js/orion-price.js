/*
 * Orion fiat conversion: turn satoshis into a currency amount using the price at a moment in time (or today's).
 * Pure functions, no network: the page fetches the data, this module reads it.
 *
 * Data shapes (mempool.space):
 *   GET /api/v1/historical-price?currency=EUR  -> { prices: [{time, USD, EUR}, ...], exchangeRates: {USDEUR: 0.9, ...} }
 *       newest first; an entry is -1 where that currency has no data; weekly points before 2023-03-05, daily until
 *       2024-01-05, hourly after. Between points the price is interpolated linearly.
 *   GET /api/v1/prices                         -> { time, USD, EUR, GBP, CAD, CHF, AUD, JPY }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionPrice = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY'];
  var DAY = 86400;
  // Data points further apart than this make an interpolated price only approximate (weekly data is ~7 days apart).
  var APPROX_SPAN = 2 * DAY;

  function validPrice(v) { return typeof v === 'number' && isFinite(v) && v > 0; }

  /** Linear interpolation over points sorted by time ascending. Returns {price, span, before, after} or null if empty. */
  function interpolate(pts, t) {
    if (!pts.length) return null;
    if (t <= pts[0].t) return { price: pts[0].p, span: 0, before: pts[0].t, after: pts[0].t, outside: t < pts[0].t };
    var last = pts[pts.length - 1];
    if (t >= last.t) return { price: last.p, span: 0, before: last.t, after: last.t, outside: t > last.t };
    var lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (pts[mid].t <= t) lo = mid; else hi = mid; }
    var a = pts[lo], b = pts[hi], k = (t - a.t) / (b.t - a.t);
    return { price: a.p + (b.p - a.p) * k, span: b.t - a.t, before: a.t, after: b.t, outside: false };
  }

  /**
   * A price history for one currency. `json` is the historical-price response. Entries without data for the currency
   * are skipped; before the first usable entry the USD price times the exchange rate is used and marked derived.
   */
  function PriceBook(json, currency) {
    this.currency = currency;
    var usd = [], own = [], rates = (json && json.exchangeRates) || {};
    ((json && json.prices) || []).forEach(function (p) {
      if (!p || typeof p.time !== 'number') return;
      if (validPrice(p.USD)) usd.push({ t: p.time, p: p.USD });
      if (currency === 'USD') { if (validPrice(p.USD)) own.push({ t: p.time, p: p.USD }); }
      else if (validPrice(p[currency])) own.push({ t: p.time, p: p[currency] });
    });
    function byTime(a, b) { return a.t - b.t; }
    this.usd = usd.sort(byTime); this.own = own.sort(byTime);
    this.cross = currency === 'USD' ? 1 : (typeof rates['USD' + currency] === 'number' ? rates['USD' + currency] : null);
  }

  PriceBook.prototype.size = function () { return this.own.length || this.usd.length; };
  PriceBook.prototype.firstTime = function () { var a = this.own.length ? this.own : this.usd; return a.length ? a[0].t : null; };
  PriceBook.prototype.lastTime = function () { var a = this.own.length ? this.own : this.usd; return a.length ? a[a.length - 1].t : null; };

  /**
   * The price of one BTC at unix time t: { price, approx, derived, spanDays, before, after, outside } or null.
   *   approx   the surrounding data points are more than 2 days apart (older history is weekly)
   *   derived  no data in this currency that early: USD price converted at today's exchange rate
   *   outside  t is before the first / after the last data point (the nearest point is used)
   */
  PriceBook.prototype.rateAt = function (t) {
    var r = interpolate(this.own, t), derived = false;
    if (!r || (r.outside && this.usd.length && t < this.own[0].t)) {
      var u = this.cross != null ? interpolate(this.usd, t) : null;
      if (u) { r = { price: u.price * this.cross, span: u.span, before: u.before, after: u.after, outside: u.outside }; derived = true; }
    }
    if (!r) return null;
    return { price: r.price, approx: r.span > APPROX_SPAN || derived || r.outside, derived: derived, outside: r.outside, spanDays: r.span / DAY, before: r.before, after: r.after };
  };

  /** Today's price from /v1/prices: { price, time } or null when the currency is missing. */
  function parseToday(json, currency) {
    if (!json || !validPrice(json[currency])) return null;
    return { price: json[currency], time: typeof json.time === 'number' ? json.time : null };
  }

  /** Satoshis -> currency units at `price` per BTC. */
  function convert(sats, price) { return sats / 1e8 * price; }

  /** "$1,234.56", "¥1,235", "< $0.01" for tiny values. */
  function format(value, currency) {
    if (value == null || !isFinite(value)) return '';
    var digits = currency === 'JPY' ? 0 : 2, nf;
    try { nf = new Intl.NumberFormat('en-US', { style: 'currency', currency: currency, minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch (e) { return value.toFixed(digits) + ' ' + currency; }
    if (value !== 0 && Math.abs(value) < Math.pow(10, -digits)) return (value < 0 ? '-' : '< ') + nf.format(Math.pow(10, -digits));
    return nf.format(value);
  }

  /** A fixed-precision number for exports (never scientific notation). */
  function plain(value, currency) { return value == null || !isFinite(value) ? '' : value.toFixed(currency === 'JPY' ? 2 : 4); }

  return { CURRENCIES: CURRENCIES, PriceBook: PriceBook, parseToday: parseToday, convert: convert, format: format, plain: plain, interpolate: interpolate, APPROX_SPAN: APPROX_SPAN };
}));
