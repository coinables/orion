'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Addr = require('../public/js/orion-address.js');

const fx = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8'));

test('sha256 matches the platform implementation on known and random inputs', () => {
  const hex = (b) => Buffer.from(b).toString('hex');
  assert.equal(hex(Addr.sha256([])), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(Addr.sha256([...Buffer.from('abc')])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {            // lengths around the padding boundaries
    const buf = crypto.randomBytes(n);
    assert.equal(hex(Addr.sha256([...buf])), crypto.createHash('sha256').update(buf).digest('hex'), 'length ' + n);
  }
});

// Vectors from BIP 173 / BIP 350 and the legacy standard
const VALID = [
  'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4',
  'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3',
  'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
  'bc1sw50qgdz25j',
  'bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs',
  '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
  '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
];

test('valid addresses of every kind pass', () => {
  VALID.forEach((a) => { const r = Addr.validate(a); assert.ok(r.ok, a + ' -> ' + JSON.stringify(r)); });
  assert.equal(Addr.validate('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').kind, 'bech32');
  assert.equal(Addr.validate('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0').kind, 'bech32m');
  assert.equal(Addr.validate('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2').kind, 'base58');
});

test('every address in the fixtures is valid (real chain data, all script types seen)', () => {
  const found = new Set();
  ['tx_normal.json', 'tx_coinbase.json', 'tx_opreturn.json', 'tx_spender_0.json', 'tx_spender_1.json', 'address_txs.json'].forEach((f) => {
    const d = fx(f);
    (Array.isArray(d) ? d : [d]).forEach((t) => [...t.vin.map((v) => v.prevout), ...t.vout].forEach((o) => { if (o && o.scriptpubkey_address) found.add(o.scriptpubkey_address); }));
  });
  assert.ok(found.size >= 10);
  found.forEach((a) => assert.ok(Addr.validate(a).ok, a));
});

test('BIP 173 / 350 invalid strings are rejected with a reason', () => {
  const bad = {
    'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5': 'checksum',
    'BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2': 'witness',         // version 17 -> out of range
    'bc1rw5uspcuh': 'witness',                                         // program too short
    'bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90': 'witness',   // program too long
    'BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P': 'witness',                 // v0 with a 16-byte program
    'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh8d2yr': 'checksum',      // bech32m with a flipped end
    'bc1gmk9yu': 'format'                                              // empty program / too short data
  };
  Object.keys(bad).forEach((a) => { const r = Addr.validate(a); assert.equal(r.ok, false, a); });
  assert.equal(Addr.validate('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5').reason, 'checksum');
  assert.equal(Addr.validate('Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4').reason, 'mixedCase', 'mixed case is invalid until it is normalised');
});

test('normalise: bech32 is lower-cased in every spelling, base58 is left exactly as given', () => {
  const lower = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'Bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bC1qW508d6qEjxtdg4y5r3zarvary0c5xw7kv8f3t4', '  ' + lower + '\t'].forEach((a) => {
    assert.equal(Addr.normalise(a), lower, a);
    assert.ok(Addr.validate(Addr.normalise(a)).ok, a);
  });
  assert.equal(Addr.normalise('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2');
  assert.equal(Addr.normalise(' 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy '), '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy');
  assert.equal(Addr.normalise(null), '');
  assert.equal(Addr.normalise('TB1QRP33G0Q5C5TXSP9ARYSRX4K6ZDKFS4NCE4XJ0GDCCCEFVPYSXF3Q0SL5K7'), 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
});

test('base58 is case-sensitive: changing the case of a valid address makes it fail, with advice', () => {
  const a = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';
  assert.ok(Addr.validate(a).ok);
  const r = Addr.validate(a.toLowerCase());
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'base58');
  assert.match(Addr.explain(r), /case-sensitive/);
  assert.equal(Addr.validate(a.slice(0, -1) + (a.endsWith('2') ? '3' : '2')).reason, 'checksum');
});

test('a single wrong character is always caught (bech32 and base58)', () => {
  for (const a of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0']) {
    const alphabet = a.startsWith('bc1') ? 'qpzry9x8gf2tvdw0s3jn54khce6mua7l' : '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (let i = 3; i < a.length; i++) {
      const other = alphabet[(alphabet.indexOf(a[i]) + 1) % alphabet.length];
      const mutated = a.slice(0, i) + other + a.slice(i + 1);
      assert.equal(Addr.validate(mutated).ok, false, mutated);
    }
  }
});

test('explain gives a sentence per failure and nothing for a good address', () => {
  assert.equal(Addr.explain(Addr.validate(VALID[1])), '');
  assert.match(Addr.explain(Addr.validate('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5')), /checksum/);
  assert.match(Addr.explain(Addr.validate('0x52908400098527886E0F7030069857D2E4169EE7')), /not a Bitcoin address/);
  assert.match(Addr.explain(Addr.validate('hello')), /not a Bitcoin address/);
  assert.equal(Addr.explain(null), '');
});

test('bech32 with another prefix is judged on its checksum only, so other Esplora networks (e.g. Liquid) keep working', () => {
  // BIP 173 calls this one invalid for Bitcoin because of its prefix; its checksum is fine, and a custom backend may use it
  assert.ok(Addr.validate('tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty').ok);
  assert.equal(Addr.validate('tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4tz').ok, false, 'but a typo is still caught');
});
