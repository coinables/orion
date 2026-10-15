'use strict';
const test = require('node:test');
const assert = require('node:assert');
const X = require('../public/js/orion-external.js');

// the documented shape (field names from Arkham's published API); NOT captured from a live key
const SAMPLE = { address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', chain: 'bitcoin',
  arkhamEntity: { name: 'Binance', id: 'binance', type: 'cex', note: 'Exchange', website: 'https://binance.com' },
  arkhamLabel: { name: 'Hot Wallet', address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', chainType: 'btc' },
  populatedTags: [{ id: 'cex', label: 'CEX' }, { id: 'hot', label: 'Hot wallet' }], isUserAddress: false, contract: false };

function fakeFetch(handler) {
  const calls = [];
  const f = (url, init) => { calls.push({ url, init }); return Promise.resolve(handler(url, init)); };
  f.calls = calls; return f;
}
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)), json: () => Promise.resolve(body) });

test('parseArkham reads entity, label, tags and website into plain text', () => {
  const p = X.parseArkham(SAMPLE);
  assert.deepEqual([p.found, p.name, p.type, p.label, p.website, p.note], [true, 'Binance', 'cex', 'Hot Wallet', 'https://binance.com', 'Exchange']);
  assert.deepEqual(p.tags, ['CEX', 'Hot wallet']);
});

test('parseArkham is tolerant: nested per-chain replies, synonyms, missing parts, garbage', () => {
  assert.equal(X.parseArkham({ bitcoin: SAMPLE }).name, 'Binance', 'a reply keyed by chain');
  assert.equal(X.parseArkham({ entity: { name: 'X' } }).name, 'X');
  const onlyLabel = X.parseArkham({ arkhamLabel: { name: 'Cold storage' } });
  assert.equal(onlyLabel.found, true); assert.equal(onlyLabel.name, '');
  assert.equal(X.parseArkham({ predictedEntity: { name: 'Maybe Kraken' } }).predicted, 'Maybe Kraken');
  ['', null, undefined, 5, [], {}, { arkhamEntity: null }, { populatedTags: 'x' }, 'text'].forEach((g) => assert.equal(X.parseArkham(g).found, false, JSON.stringify(g)));
  assert.deepEqual(X.parseArkham({ populatedTags: ['a', { id: 'b' }, { label: '' }, 5] }).tags, ['a', 'b', '5']);
});

test('parseArkham makes everything inert text and caps it', () => {
  const p = X.parseArkham({ arkhamEntity: { name: '<img src=x onerror=1>\u0000\n' + 'x'.repeat(500), type: 'cex' } });
  assert.ok(p.name.length <= 200);
  assert.ok(!/[\u0000-\u001F]/.test(p.name));
  assert.equal(typeof p.name, 'string');
  assert.equal(X.parseArkham({ populatedTags: new Array(50).fill('t') }).tags.length, 12);
});

test('tagFor suggests a preset from the entity type or name, and says nothing when unsure', () => {
  assert.equal(X.tagFor('cex', 'Binance'), 'EXCH');
  assert.equal(X.tagFor('', 'Kraken Hot Wallet'), 'EXCH');
  assert.equal(X.tagFor('mixer', 'Tornado'), 'MIXER');
  assert.equal(X.tagFor('hacker', 'Lazarus Group'), 'THREAT');
  assert.equal(X.tagFor('', 'Ransomware wallet'), 'THREAT');
  assert.equal(X.tagFor('market', 'Some Market'), 'MARKET');
  assert.equal(X.tagFor('gambling', 'Stake'), 'GAMBLING');
  assert.equal(X.tagFor('payment-processor', ''), 'SERVICE');
  assert.equal(X.tagFor('individual', 'Some Person'), '');
  assert.equal(X.tagFor('', ''), '');
});

test('toExt keeps the parsed fields, the time, a capped raw copy and the suggestion', () => {
  const e = X.toExt(SAMPLE, 1700000000);
  assert.equal(e.at, 1700000000); assert.equal(e.suggest, 'EXCH'); assert.equal(e.found, true);
  assert.ok(e.raw.startsWith('{') && e.raw.includes('arkhamEntity'));
  const big = X.toExt({ arkhamEntity: { name: 'N' }, pad: 'z'.repeat(20000) }, 1);
  assert.ok(big.raw.length <= X.RAW_LIMIT + 1 && big.raw.endsWith('…'));
  assert.equal(X.toExt({}, 5).found, false);
});

test('cleanExt (import) keeps only the known fields of known sources', () => {
  const clean = X.cleanExt({ arkham: Object.assign(X.toExt(SAMPLE, 9), { evil: '<script>', suggest: 'NOPE' }), other: { x: 1 } });
  assert.deepEqual(Object.keys(clean), ['arkham']);
  assert.equal(clean.arkham.name, 'Binance'); assert.equal(clean.arkham.suggest, '', 'an unknown preset is dropped');
  assert.ok(!('evil' in clean.arkham));
  ['x', null, [], 5, {}, { other: 1 }, { arkham: 'str' }].forEach((v) => assert.equal(X.cleanExt(v), null, JSON.stringify(v)));
  assert.equal(X.cleanExt({ arkham: { name: 'n', at: 'now', tags: 'x' } }).arkham.at, 0);
});

test('lookupArkham asks the proxy for one address with the token and nothing else', async () => {
  const f = fakeFetch(() => resp(200, SAMPLE));
  const r = await X.lookupArkham({ fetch: f, base: 'http://127.0.0.1:8787/', token: 'T0K', address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h' });
  assert.equal(r.found, true); assert.equal(r.ext.name, 'Binance');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8787/intelligence/address/bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h');
  assert.equal(f.calls[0].init.headers['X-Orion-Token'], 'T0K');
  assert.ok(!JSON.stringify(f.calls[0].init.headers).toLowerCase().includes('api-key'), 'the Arkham key is never in the page');
});

test('lookupArkham: no entry is an answer, not an error; every failure has a kind and a sentence', async () => {
  const base = 'http://127.0.0.1:8787';
  const run = (status, body) => X.lookupArkham({ fetch: fakeFetch(() => resp(status, body)), base, token: 't', address: 'a'.repeat(30) });
  assert.equal((await run(404, { error: 'not found' })).found, false);
  assert.equal((await run(200, {})).found, false);
  await assert.rejects(run(401, { error: 'bad token' }), (e) => e.kind === 'token' && /bad token/.test(e.message));
  await assert.rejects(run(429, { error: 'slow down' }), (e) => e.kind === 'rate');
  await assert.rejects(run(403, { error: 'upstream rejected the API key' }), (e) => e.kind === 'key');
  await assert.rejects(run(502, { error: 'Arkham rejected the API key (HTTP 401)' }), (e) => e.kind === 'key');
  await assert.rejects(run(500, 'oops'), (e) => e.kind === 'upstream' && /HTTP 500/.test(e.message));
  await assert.rejects(run(200, 'not json'), (e) => e.kind === 'bad');
  await assert.rejects(X.lookupArkham({ fetch: () => Promise.reject(new TypeError('NetworkError')), base, token: 't', address: 'a' }), (e) => e.kind === 'proxy' && /arkham_proxy/.test(e.message));
  await assert.rejects(X.lookupArkham({ fetch: fakeFetch(() => resp(200, {})), base: '', token: 't', address: 'a' }), (e) => e.kind === 'proxy');
  await assert.rejects(X.lookupArkham({ fetch: fakeFetch(() => resp(200, {})), base, token: '', address: 'a' }), (e) => e.kind === 'token');
});

test('lookupArkham times out instead of hanging', async () => {
  const hang = (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  await assert.rejects(X.lookupArkham({ fetch: hang, base: 'http://127.0.0.1:8787', token: 't', address: 'a', timeoutMs: 30 }), (e) => e.kind === 'timeout');
});

test('proxyHealth reports the proxy state or why it is unreachable', async () => {
  const ok = await X.proxyHealth({ fetch: fakeFetch(() => resp(200, { ok: true, keyConfigured: true, upstream: 'https://api.arkm.com' })), base: 'http://127.0.0.1:8787', token: 't' });
  assert.deepEqual(ok, { ok: true, keyConfigured: true, upstream: 'https://api.arkm.com' });
  await assert.rejects(X.proxyHealth({ fetch: fakeFetch(() => resp(401, {})), base: 'http://x', token: 'bad' }), (e) => e.kind === 'token');
  await assert.rejects(X.proxyHealth({ fetch: () => Promise.reject(new Error('refused')), base: 'http://x', token: 't' }), (e) => e.kind === 'proxy');
});
