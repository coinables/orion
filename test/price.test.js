'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/js/orion-price.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));
const DAY = 86400;
const utc = (y, m, d, h) => Date.UTC(y, m - 1, d, h || 0) / 1000;

test('convert and format', () => {
  assert.equal(P.convert(1e8, 50000), 50000);
  assert.equal(P.convert(12345678, 40000), 4938.2712);
  assert.equal(P.format(1234.567, 'USD'), '$1,234.57');
  assert.equal(P.format(1234.567, 'JPY'), '¥1,235', 'yen has no decimals');
  assert.equal(P.format(0, 'EUR'), '€0.00');
  assert.equal(P.format(0.004, 'USD'), '< $0.01');
  assert.equal(P.format(-3.5, 'GBP'), '-£3.50');
  assert.equal(P.format(NaN, 'USD'), '');
  assert.equal(P.format(1, 'XXX'.slice(0, 3) === 'XXX' ? 'ZZZ' : 'USD').length > 0, true, 'an unknown currency code still formats');
  assert.equal(P.plain(1234.5678912, 'USD'), '1234.5679');
  assert.equal(P.plain(null, 'USD'), '');
});

// A hand-made series in the real API's shape: newest first, -1 for "no data in this currency"
function series() {
  return { prices: [
    { time: utc(2024, 3, 1), USD: 60000, EUR: 55000 },
    { time: utc(2024, 2, 29), USD: 58000, EUR: 53000 },
    { time: utc(2023, 1, 8), USD: 17000, EUR: -1 },
    { time: utc(2023, 1, 1), USD: 16000, EUR: 15000 },
    { time: utc(2022, 12, 25), USD: 15000, EUR: 14000 },
    { time: utc(2010, 7, 19), USD: 0.08, EUR: -1 }
  ], exchangeRates: { USDEUR: 0.9, USDGBP: 0.75 } };
}

test('PriceBook sorts the newest-first series, drops -1 entries and interpolates linearly', () => {
  const b = new P.PriceBook(series(), 'EUR');
  assert.equal(b.size(), 4, 'the -1 entries are skipped');
  assert.equal(b.firstTime(), utc(2022, 12, 25));
  assert.equal(b.lastTime(), utc(2024, 3, 1));
  const mid = b.rateAt(utc(2022, 12, 28, 12));                   // halfway between 25 Dec (14000) and 1 Jan (15000)
  assert.ok(Math.abs(mid.price - (14000 + 1000 * (3.5 / 7))) < 1e-6, String(mid.price));
  assert.equal(mid.derived, false);
  assert.ok(mid.approx, 'seven days apart: only an approximation');
  assert.ok(Math.abs(mid.spanDays - 7) < 1e-9);
  const exact = b.rateAt(utc(2023, 1, 1));
  assert.equal(exact.price, 15000);
});

test('hourly/daily data is not flagged approximate; weekly is', () => {
  const b = new P.PriceBook(series(), 'USD');
  assert.equal(b.rateAt(utc(2024, 2, 29, 12)).approx, false, 'one day apart');
  assert.equal(b.rateAt(utc(2023, 1, 4)).approx, true);
});

test('before the first data point in a currency, the USD price at today\'s exchange rate is used and flagged derived', () => {
  const b = new P.PriceBook(series(), 'EUR');
  const r = b.rateAt(utc(2023, 1, 8) - 0);                        // the EUR entry for 8 Jan is -1, but 1 Jan..1 Mar EUR points surround it
  assert.equal(r.derived, false, 'inside the range, neighbouring valid points are interpolated');
  const old = b.rateAt(utc(2011, 1, 1));
  assert.equal(old.derived, true);
  assert.ok(old.approx);
  const usdAt = new P.PriceBook(series(), 'USD').rateAt(utc(2011, 1, 1)).price;
  assert.ok(Math.abs(old.price - usdAt * 0.9) < 1e-9, 'the USD price times the USD->EUR exchange rate');
  assert.equal(new P.PriceBook(series(), 'JPY').rateAt(utc(2023, 1, 1)), null, 'no yen data and no exchange rate: nothing to say');
});

test('outside the series the nearest point is used and flagged', () => {
  const b = new P.PriceBook(series(), 'USD');
  const future = b.rateAt(utc(2030, 1, 1));
  assert.equal(future.price, 60000);
  assert.ok(future.outside && future.approx);
  const empty = new P.PriceBook({ prices: [] }, 'USD');
  assert.equal(empty.rateAt(utc(2024, 1, 1)), null);
  assert.equal(empty.size(), 0);
  assert.equal(new P.PriceBook(null, 'USD').rateAt(1), null);
});

test('garbage entries are ignored', () => {
  const b = new P.PriceBook({ prices: [{ time: 'x', USD: 1 }, { time: 10, USD: 'high' }, null, { time: 20, USD: 100 }, { time: 30, USD: -5 }, { time: 40, USD: 0 }] }, 'USD');
  assert.equal(b.size(), 1);
  assert.equal(b.rateAt(25).price, 100);
});

test('real mempool.space sample: weekly in 2022 (flagged), recent points exact, EUR -1 gaps skipped', () => {
  const j = fx('historical_price_sample.json');
  const usd = new P.PriceBook(j, 'USD'), eur = new P.PriceBook(j, 'EUR');
  assert.ok(usd.size() > 30);
  const t = 1649176756;                                           // 2022-04-05 16:39 UTC, the sample transaction
  const r = usd.rateAt(t);
  assert.ok(r.approx && r.spanDays > 5 && r.spanDays < 8, JSON.stringify(r));
  assert.ok(r.price > 40000 && r.price < 48000, 'USD/BTC early April 2022 was around 45k, got ' + r.price);
  const e = eur.rateAt(t);
  assert.ok(e.price < r.price && e.price > r.price * 0.8, 'euro price is below the dollar price');
  const newest = Math.max(...j.prices.map((p) => p.time));
  assert.equal(usd.rateAt(newest).price, j.prices.find((p) => p.time === newest).USD);
  assert.equal(usd.lastTime(), newest);
});

test('parseToday reads /v1/prices and refuses a missing currency', () => {
  const j = fx('prices_now.json');
  assert.deepEqual(P.parseToday(j, 'EUR'), { price: 73541, time: 1792083612 });
  assert.equal(P.parseToday(j, 'XYZ'), null);
  assert.equal(P.parseToday(null, 'USD'), null);
  assert.equal(P.parseToday({ USD: -1 }, 'USD'), null);
  assert.deepEqual(P.CURRENCIES, ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY']);
});
