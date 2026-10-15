/*
 * Orion address handling: put whatever was typed or pasted into its proper form, and check it locally.
 *
 *   bech32 / bech32m (bc1..., tb1..., bcrt1...)   case does not matter, so it is lower-cased ("Bc1q..." from an
 *                                                  autocorrecting keyboard, "BC1Q..." from a QR code)
 *   base58 (1..., 3...)                            case DOES matter and cannot be repaired, so it is left alone
 *
 * Checksums are verified without any network request, so a typo is reported at once instead of as an HTTP 400.
 * Pure JavaScript (no BigInt, no Web Crypto), so it works from file:// and under `node --test`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrionAddress = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- SHA-256 --------------------------------------------------------------------------------
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /** SHA-256 of an array of byte values (0..255); returns an array of 32 bytes. */
  function sha256(bytes) {
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length, bitLen = len * 8;
    var padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    [hi, lo].forEach(function (w) { padded.push((w >>> 24) & 255, (w >>> 16) & 255, (w >>> 8) & 255, w & 255); });
    var w = new Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = ((padded[off + 4 * i] << 24) | (padded[off + 4 * i + 1] << 16) | (padded[off + 4 * i + 2] << 8) | padded[off + 4 * i + 3]) | 0;
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0, (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0];
    }
    var out = [];
    h.forEach(function (x) { out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255); });
    return out;
  }

  // ---- bech32 / bech32m (BIP 173, BIP 350) ------------------------------------------------------
  var CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  var BECH32_CONST = 1, BECH32M_CONST = 0x2bc830a3;

  function polymod(values) {
    var chk = 1;
    for (var p = 0; p < values.length; p++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[p];
      for (var i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
    }
    return chk >>> 0;
  }
  function hrpExpand(hrp) {
    var out = [], i;
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }

  /** {hrp, data(5-bit values without checksum), encoding:'bech32'|'bech32m'} or {error}. */
  function bech32Decode(str) {
    if (str.length < 8 || str.length > 90) return { error: 'length' };
    if (str !== str.toLowerCase() && str !== str.toUpperCase()) return { error: 'mixedCase' };
    str = str.toLowerCase();
    var pos = str.lastIndexOf('1');
    if (pos < 1 || pos + 7 > str.length) return { error: 'format' };
    var hrp = str.slice(0, pos), data = [];
    for (var i = pos + 1; i < str.length; i++) {
      var v = CHARSET.indexOf(str[i]);
      if (v < 0) return { error: 'charset' };
      data.push(v);
    }
    var c = polymod(hrpExpand(hrp).concat(data));
    var encoding = c === BECH32_CONST ? 'bech32' : c === BECH32M_CONST ? 'bech32m' : null;
    if (!encoding) return { error: 'checksum' };
    return { hrp: hrp, data: data.slice(0, data.length - 6), encoding: encoding };
  }

  function convertBits(data, from, to, pad) {
    var acc = 0, bits = 0, out = [], maxv = (1 << to) - 1;
    for (var i = 0; i < data.length; i++) {
      if (data[i] < 0 || (data[i] >>> from) !== 0) return null;
      acc = (acc << from) | data[i]; bits += from;
      while (bits >= to) { bits -= to; out.push((acc >>> bits) & maxv); }
      acc &= (1 << bits) - 1;
    }
    if (pad) { if (bits) out.push((acc << (to - bits)) & maxv); }
    else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
    return out;
  }

  // ---- base58check ------------------------------------------------------------------------------
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function base58Decode(str) {
    var bytes = [0], i, j;
    for (i = 0; i < str.length; i++) {
      var carry = B58.indexOf(str[i]);
      if (carry < 0) return null;
      for (j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 255; carry >>= 8; }
      while (carry > 0) { bytes.push(carry & 255); carry >>= 8; }
    }
    for (i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
    return bytes.reverse();
  }

  // ---- public API -------------------------------------------------------------------------------
  var BECH32_PREFIX = /^(bc1|tb1|bcrt1)/i;

  /** The form to look an address up in: bech32 lower-cased, everything else untouched. */
  function normalise(addr) {
    var a = String(addr == null ? '' : addr).trim();
    return BECH32_PREFIX.test(a) ? a.toLowerCase() : a;
  }

  /**
   * Check an address (after normalise). Returns {ok:true, kind} or {ok:false, reason, kind?}.
   * reason: 'format' (not any address shape) | 'checksum' | 'charset' | 'length' | 'mixedCase' | 'witness'
   * kind: 'bech32' | 'bech32m' | 'base58'
   */
  function validate(addr) {
    var a = String(addr == null ? '' : addr).trim();
    if (!a) return { ok: false, reason: 'format' };
    var dec = bech32Decode(a);
    if (!dec.error) {
      var res = { ok: true, kind: dec.encoding, hrp: dec.hrp };
      if (dec.hrp === 'bc' || dec.hrp === 'tb' || dec.hrp === 'bcrt') {          // Bitcoin: also apply the witness program rules
        var ver = dec.data[0], prog = convertBits(dec.data.slice(1), 5, 8, false);
        if (ver === undefined || ver > 16 || !prog || prog.length < 2 || prog.length > 40) return { ok: false, reason: 'witness', kind: dec.encoding };
        if (ver === 0 && (dec.encoding !== 'bech32' || (prog.length !== 20 && prog.length !== 32))) return { ok: false, reason: 'witness', kind: dec.encoding };
        if (ver !== 0 && dec.encoding !== 'bech32m') return { ok: false, reason: 'witness', kind: dec.encoding };
        res.version = ver;
      }
      return res;
    }
    if (BECH32_PREFIX.test(a)) return { ok: false, reason: dec.error, kind: 'bech32' };
    if (/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(a)) {
      var bytes = base58Decode(a);
      if (!bytes || bytes.length !== 25) return { ok: false, reason: 'length', kind: 'base58' };
      var sum = sha256(sha256(bytes.slice(0, 21)));
      for (var i = 0; i < 4; i++) if (sum[i] !== bytes[21 + i]) return { ok: false, reason: 'checksum', kind: 'base58' };
      return { ok: true, kind: 'base58', version: bytes[0] };
    }
    return { ok: false, reason: 'format' };
  }

  /** A sentence for the user, or '' when the address is fine. */
  function explain(result) {
    if (!result || result.ok) return '';
    if (result.kind === 'base58' && (result.reason === 'checksum' || result.reason === 'length'))
      return 'This looks like a legacy address (starting with 1 or 3) but it does not check out. Legacy addresses are case-sensitive, so check capital and small letters as well as missing or extra characters.';
    if (result.kind === 'bech32' || result.kind === 'bech32m') {
      if (result.reason === 'checksum') return 'This looks like a SegWit/Taproot address (bc1…) but its checksum does not match: a character is wrong, missing or extra.';
      if (result.reason === 'charset') return 'This looks like a SegWit/Taproot address (bc1…) but contains characters that cannot appear in one (1, b, i, o are not used after the separator).';
      if (result.reason === 'witness') return 'This is a well-formed bech32 string but not a valid Bitcoin address (wrong witness version or length).';
      return 'This looks like a SegWit/Taproot address (bc1…) but its length or format is wrong.';
    }
    return 'That is not a Bitcoin address or transaction id.';
  }

  return { normalise: normalise, validate: validate, explain: explain, sha256: sha256, bech32Decode: bech32Decode, base58Decode: base58Decode };
}));
