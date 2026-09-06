/* digest — a pure-JS SHA-256 (FIPS 180-4), lowercase hex out.
 *
 * WHY THIS EXISTS AT ALL. The swarm's trust model is that two strangers'
 * browsers, screening the same work unit, produce a BIT-IDENTICAL digest.
 * That only holds if the hash itself is identical everywhere it runs, so this
 * module deliberately refuses every convenient shortcut:
 *
 *   - no platform hashing library: the node builtin is Node-only and the web
 *     one is async and absent on insecure origins,
 *   - no platform byte buffer and no platform text encoder — both exist, but
 *     each is one more thing standing between us and the bytes, so UTF-8 is
 *     encoded here, by hand, and the byte stream is defined by THIS file,
 *   - no floating point anywhere on the hashing path: every value is kept in
 *     32-bit integer space with |0 / >>> 0 / Math.imul.
 *
 * Zero dependencies. Node 22 and every browser, same bytes.
 *
 * Contract:
 *   sha256Hex("")    -> e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 *   sha256Hex("abc") -> ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 *
 * Hostile input never throws: non-strings are coerced with String() and
 * NOTHING else — so null hashes as "null" and undefined as "undefined", the
 * way every reference implementation in every other language would render
 * them, never colliding with the empty string — an argument whose own toString
 * throws hashes as "", and unpaired surrogates encode as U+FFFD (the WHATWG
 * replacement rule) instead of emitting invalid UTF-8 or blowing up.
 */

/* First 32 bits of the fractional parts of the cube roots of the first 64
 * primes. Written out as literals on purpose — deriving them at load time
 * would put cube roots, and therefore floating point, on the trust path. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/* First 32 bits of the fractional parts of the square roots of the first 8
 * primes. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]);

const HEX = "0123456789abcdef";

/* UTF-8 encode a JS (UTF-16) string ourselves. Surrogate pairs are combined;
 * a lone surrogate — high with no low, or a stray low — becomes U+FFFD rather
 * than an exception or a malformed byte. */
function utf8Bytes(str) {
  const n = str.length;
  /* Worst case is 3 bytes per UTF-16 unit (4-byte code points consume two
   * units, so they cost 2 bytes/unit). Allocate once, trim at the end. */
  const out = new Uint8Array(n * 3);
  let p = 0;
  for (let i = 0; i < n; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = (i + 1 < n) ? str.charCodeAt(i + 1) : 0;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + (((cp - 0xd800) << 10) | (lo - 0xdc00));
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out[p++] = cp;
    } else if (cp < 0x800) {
      out[p++] = 0xc0 | (cp >>> 6);
      out[p++] = 0x80 | (cp & 0x3f);
    } else if (cp < 0x10000) {
      out[p++] = 0xe0 | (cp >>> 12);
      out[p++] = 0x80 | ((cp >>> 6) & 0x3f);
      out[p++] = 0x80 | (cp & 0x3f);
    } else {
      out[p++] = 0xf0 | (cp >>> 18);
      out[p++] = 0x80 | ((cp >>> 12) & 0x3f);
      out[p++] = 0x80 | ((cp >>> 6) & 0x3f);
      out[p++] = 0x80 | (cp & 0x3f);
    }
  }
  return out.subarray(0, p);
}

/* Coerce anything to a string without ever throwing, using String() semantics
 * and NOTHING ELSE.
 *
 * There used to be a special case here mapping null and undefined to "", which
 * made sha256Hex(null), sha256Hex(undefined) and sha256Hex("") three names for
 * one digest. That is a bad trade in exactly this module: the whole reason
 * this file exists is that a second implementation — a PHP or Python canary
 * generator writing hash('sha256', strval($x)) — has to land on the same 64
 * characters, and every such implementation renders these two values as "null"
 * and "undefined"/"None", not as "". A hidden three-way collision in the one
 * function whose job is cross-implementation agreement is worth more than the
 * convenience of an empty string, so the special case is gone: String() is the
 * only rule, and it is the rule a reimplementer will guess.
 *
 * Nothing in the app relies on the old behaviour — score.js and targets.js
 * always hand this a built string — and no pinned vector covered it.
 *
 * String() itself still cannot be trusted with a hostile argument (an object
 * whose toString runs code and throws, a null-prototype object with no
 * toString at all), so the call stays guarded and those hash as "". Note that
 * String(Symbol()) is defined and does NOT throw. */
function asString(input) {
  if (typeof input === "string") return input;
  try {
    return String(input);
  } catch (_) {
    return "";
  }
}

/**
 * SHA-256 of a string, as 64 lowercase hex characters.
 * @param {string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  const bytes = utf8Bytes(asString(input));
  const len = bytes.length;

  /* Pad: 0x80, then zeros, then the 64-bit big-endian bit length, to a
   * multiple of 64 bytes. floor((len + 9 + 63) / 64) blocks. */
  const blocks = (len + 72) >>> 6;
  const buf = new Uint8Array(blocks << 6);
  buf.set(bytes);
  buf[len] = 0x80;

  /* Bit length = len * 8 as a 64-bit big-endian integer. The high word is
   * floor(len / 2^29), which for a 32-bit length is exactly len >>> 29 — no
   * division, no float. Bytes 0..2 of the length field stay zero: a string
   * long enough to need them cannot exist in either runtime. */
  const tail = buf.length - 8;
  const hi = len >>> 29;
  const lo = (len << 3) >>> 0;
  buf[tail + 3] = (hi >>> 0) & 0xff;
  buf[tail + 4] = (lo >>> 24) & 0xff;
  buf[tail + 5] = (lo >>> 16) & 0xff;
  buf[tail + 6] = (lo >>> 8) & 0xff;
  buf[tail + 7] = lo & 0xff;

  /* Per-call state. Module-level scratch would be faster, but a hash whose
   * correctness depends on nobody re-entering it is not the kind of thing to
   * build a trust model on. */
  const W = new Uint32Array(64);
  const H = new Uint32Array(H0);

  for (let off = 0; off < buf.length; off += 64) {
    for (let t = 0; t < 16; t++) {
      const i = off + (t << 2);
      W[t] = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15];
      const w2 = W[t - 2];
      const s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
      const s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];

    for (let t = 0; t < 64; t++) {
      const S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }

    H[0] = (H[0] + a) >>> 0;
    H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0;
    H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0;
    H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0;
    H[7] = (H[7] + h) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    const v = H[i];
    hex += HEX[(v >>> 28) & 15] + HEX[(v >>> 24) & 15] + HEX[(v >>> 20) & 15] + HEX[(v >>> 16) & 15] +
           HEX[(v >>> 12) & 15] + HEX[(v >>> 8) & 15] + HEX[(v >>> 4) & 15] + HEX[v & 15];
  }
  return hex;
}
