/* fingerprint — an ECFP4-style Morgan circular fingerprint, folded to 1024
 * bits held in a Uint32Array(32).
 *
 * THE WHOLE POINT IS REPRODUCIBILITY. Two volunteers' browsers screening the
 * same work unit must agree bit-for-bit, and a second implementation in
 * another language must be able to land on the same 1024 bits. So the
 * algorithm below is specified down to the string that gets hashed, and every
 * place where an ordering could vary is sorted explicitly:
 *
 *   1. Atom invariant at radius 0:
 *        fnv1a32(`${el}|${heavyDegree}|${hcount}|${charge}|${arom}|${ring}`)
 *      with arom/ring rendered as 1 or 0. Set bit (invariant % 1024).
 *   2. For r = 1..radius, for each atom: collect [bondCode, neighbourInvariant]
 *      pairs from the PREVIOUS round's invariants, where bondCode is 4 for an
 *      aromatic bond and otherwise the bond order; sort numerically by
 *      bondCode then invariant; then
 *        newInvariant = fnv1a32(`${prevInvariant}|` + pairs.join(","))
 *      and set bit (newInvariant % 1024). Every atom's new invariant is
 *      computed from the previous round's values — a full simultaneous update,
 *      never reading a value written in the same round.
 *   3. Identical environments simply collide onto the same bit. There is no
 *      de-duplication bookkeeping, and there must not be: bookkeeping is state,
 *      and state is where two implementations drift apart.
 *
 * No floating point touches a bit or a count. Nothing here reads a clock, draws
 * a random number, calls a transcendental, or formats by locale — the only
 * number-to-string is plain decimal concatenation, which the language spec
 * fixes independently of locale. Zero dependencies; this module takes a Mol
 * object and deliberately does NOT import the SMILES parser.
 *
 * Hostile input never throws: a missing/ill-formed Mol yields an all-zero
 * fingerprint, a bond whose atom indices are not in-range integers is skipped,
 * a self-bond is ignored, and a Mol whose own property accessors throw is
 * refused whole (all-zero) rather than half-read. "Skipped" means SKIPPED: a
 * bond with a missing, NaN or non-integer index is dropped, never quietly
 * rewritten into a bond to atom 0.
 *
 * An unusable radius (null, NaN, a string, an object, a negative or fractional
 * number) is the DEFAULT radius 2, never a silent collapse to ECFP0 — a
 * degraded fingerprint that still looks and compares like a real one is the
 * worst failure mode this module has. +Infinity means "as deep as allowed" and
 * clamps to MAX_RADIUS.
 *
 * PINNED WIRE FORMAT. The hashed strings above are the swarm's wire format;
 * changing any of them forks the volunteer population into two mutually
 * conflicting digest populations, and no relational test can see that happen.
 * fnv1a32 is exported and qa/chem.mjs section 4 pins its vectors, the two
 * invariant-string traces and a whole folded bit set built from a Mol literal
 * (so the pin holds the FINGERPRINT format, independent of the SMILES parser).
 * Those literals are the format's definition; a second-language canary
 * generator should be able to reproduce them from this header alone.
 */

/** 1024 bits, packed 32 to a word. */
export const FP_WORDS = 32;

/** Bit width of a folded fingerprint. Not exported — FP_WORDS is the contract. */
const FP_BITS = FP_WORDS * 32;

/** A radius past this is meaningless on a drug-sized molecule and is only ever
 * a hostile or buggy caller; clamp rather than spin. */
const MAX_RADIUS = 16;

/** ECFP4. The documented default, and what an unusable radius resolves to. */
const DEFAULT_RADIUS = 2;

/* ————— FNV-1a, 32-bit, over UTF-8 bytes ————— */

/* Every string this module hashes is ASCII (element symbols, decimal digits,
 * '|', ',', '-'), for which the UTF-8 byte stream and the UTF-16 code units are
 * the same sequence. The non-ASCII branch exists anyway so that a garbage
 * element symbol out of a hostile Mol still hashes to something defined, and
 * defined the same way a reference implementation over UTF-8 bytes would. */
/**
 * FNV-1a over the UTF-8 bytes of `str`, as an unsigned 32-bit integer.
 *
 * Exported for ONE reason: it is the atom of the wire format. A reference
 * implementation in another language (a PHP or Python canary generator that
 * has to agree with these browsers bit-for-bit) needs a shared test vector for
 * this function before anything else, and an unexported helper cannot be
 * asserted from qa/. It is not part of the screening API — score.js never
 * calls it — but it IS part of the pinned format.
 *
 *   fnv1a32("")            -> 2166136261
 *   fnv1a32("C|1|3|0|0|0") -> 2693302896   (ethanol's methyl at radius 0)
 *
 * @param {string} str
 * @returns {number} 0..4294967295
 */
export function fnv1a32(str) {
  if (typeof str !== "string") str = "";
  let h = 0x811c9dc5;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      h = Math.imul(h ^ cp, 0x01000193) >>> 0;
      continue;
    }
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
    if (cp < 0x800) {
      h = Math.imul(h ^ (0xc0 | (cp >>> 6)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 0x01000193) >>> 0;
    } else if (cp < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (cp >>> 12)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | ((cp >>> 6) & 0x3f)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 0x01000193) >>> 0;
    } else {
      h = Math.imul(h ^ (0xf0 | (cp >>> 18)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | ((cp >>> 12) & 0x3f)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | ((cp >>> 6) & 0x3f)), 0x01000193) >>> 0;
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/* ————— bit helpers ————— */

function setBit(fp, bit) {
  fp[bit >>> 5] |= (1 << (bit & 31));
}

/* SWAR population count of one 32-bit word. Math.imul for the final
 * horizontal add so the multiply stays in exact 32-bit integer space. */
function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return Math.imul(v, 0x01010101) >>> 24;
}

/* Integers only, defended against a hostile Mol carrying strings, floats,
 * NaN or Infinity where an integer belongs. ToInt32 semantics are exact and
 * identical in every engine.
 *
 * Number() itself can THROW — on a Symbol, on a BigInt too large to convert,
 * on any object whose valueOf/toString runs code — so the coercion is guarded.
 * A value we cannot read as a number is 0, the same answer a missing field
 * gets, and never an exception escaping into the screening path. The typeof
 * fast path keeps the try out of the hot loop for every real Mol. */
function int(v) {
  if (typeof v === "number") {
    return (v === v && v !== Infinity && v !== -Infinity) ? (v | 0) : 0;
  }
  let n;
  try {
    n = Number(v);
  } catch (_) {
    return 0;
  }
  return (n === n && n !== Infinity && n !== -Infinity) ? (n | 0) : 0;
}

/* Resolve the circular radius.
 *
 * Only an actual non-negative integer Number is taken at face value; +Infinity
 * asks for as much depth as this module allows and gets MAX_RADIUS. EVERYTHING
 * else — null, undefined, NaN, -Infinity, a negative, a fraction, a string, an
 * object, a Symbol — is the documented default. That asymmetry is deliberate:
 * `null` is the most ordinary "no value" idiom there is, and the old ToInt32
 * coercion turned it into radius 0, handing the caller an ECFP0 fingerprint
 * that sets bits, compares as a real fingerprint and is simply the wrong
 * molecule fingerprint. Silently degrading is worse than refusing; here the
 * honest answer is the default the contract already documents.
 *
 * An explicit 0 is still honoured — ECFP0 is a legitimate request. */
function resolveRadius(radius) {
  if (typeof radius !== "number") return DEFAULT_RADIUS;
  if (radius === Infinity) return MAX_RADIUS;
  if (!Number.isInteger(radius) || radius < 0) return DEFAULT_RADIUS;
  return radius > MAX_RADIUS ? MAX_RADIUS : radius;
}

/* Read one property without ever letting a hostile accessor escape. Only used
 * off the hot path; the fingerprint loop reads locals. */
function fpRead(obj, key) {
  try {
    return obj[key];
  } catch (_) {
    return undefined;
  }
}

/* ————— the fingerprint ————— */

/**
 * ECFP4-style Morgan fingerprint of a Mol, folded to FP_WORDS * 32 bits.
 *
 * @param {{atoms: Array, bonds: Array}} mol  a Mol as produced by parseSmiles
 * @param {number} [radius=2]  circular radius; 2 gives ECFP4. Anything that is
 *   not a non-negative integer resolves to 2 rather than degrading silently.
 * @returns {Uint32Array} FP_WORDS words. All-zero for an unusable Mol.
 */
export function morganFingerprint(mol, radius = DEFAULT_RADIUS) {
  try {
    return buildFingerprint(mol, radius);
  } catch (_) {
    /* Nothing inside buildFingerprint() throws on a Mol made of data; reaching
     * here means the "Mol" carries executable accessors that threw. Refuse it
     * WHOLE — an all-zero fingerprint, the documented answer for an unusable
     * Mol — rather than returning the half-built bits, which would be neither
     * a fingerprint of anything nor stable to reason about. score.js treats an
     * empty fingerprint as no evidence, so this fails closed. */
    return new Uint32Array(FP_WORDS);
  }
}

function buildFingerprint(mol, radius) {
  const fp = new Uint32Array(FP_WORDS);
  if (!mol || typeof mol !== "object") return fp;

  const rawAtoms = fpRead(mol, "atoms");
  const atoms = Array.isArray(rawAtoms) ? rawAtoms : null;
  if (!atoms || atoms.length === 0) return fp;
  const n = atoms.length;
  const rawBonds = fpRead(mol, "bonds");
  const bonds = Array.isArray(rawBonds) ? rawBonds : [];

  const rad = resolveRadius(radius);

  /* Adjacency as two parallel flat lists per atom, so nothing depends on
   * object key order anywhere. */
  const nbrAtom = [];
  const nbrCode = [];
  for (let i = 0; i < n; i++) { nbrAtom.push([]); nbrCode.push([]); }
  const heavyDeg = new Int32Array(n);

  for (let k = 0; k < bonds.length; k++) {
    const b = bonds[k];
    if (!b || typeof b !== "object") continue;
    /* Validate BEFORE coercing. int() maps undefined, NaN and "oops" all to 0,
     * and 0 is a perfectly valid atom index — so coercing first makes a corrupt
     * bond indistinguishable from an explicit bond to atom 0, and a corrupt
     * bond then silently CHANGES the fingerprint instead of being dropped.
     * Requiring a real integer sends every one of those through the range
     * guard below, which is the documented behaviour: skipped. */
    const a = Number.isInteger(b.a) ? b.a : -1;
    const c = Number.isInteger(b.b) ? b.b : -1;
    if (a < 0 || a >= n || c < 0 || c >= n || a === c) continue;
    let order = int(b.order);
    if (order < 1 || order > 3) order = 1;
    const code = b.arom ? 4 : order;
    nbrAtom[a].push(c); nbrCode[a].push(code);
    nbrAtom[c].push(a); nbrCode[c].push(code);
    /* "heavyDegree is the number of bonds to heavy atoms" — an explicit [H]
     * that the parser chose to keep as an atom does not raise the degree of
     * its partner. It is still a neighbour in the circular expansion. */
    if (!isHydrogen(atoms[c])) heavyDeg[a]++;
    if (!isHydrogen(atoms[a])) heavyDeg[c]++;
  }

  /* Radius 0 */
  let cur = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const at = atoms[i] && typeof atoms[i] === "object" ? atoms[i] : {};
    const el = typeof at.el === "string" ? at.el : "*";
    const inv = fnv1a32(
      el + "|" + heavyDeg[i] + "|" + int(at.hcount) + "|" + int(at.charge) +
      "|" + (at.arom ? 1 : 0) + "|" + (at.ring ? 1 : 0)
    );
    cur[i] = inv;
    setBit(fp, inv % FP_BITS);
  }

  /* Radii 1..rad, simultaneous update */
  for (let r = 1; r <= rad; r++) {
    const next = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const ns = nbrAtom[i];
      const cs = nbrCode[i];
      const pairs = new Array(ns.length);
      for (let k = 0; k < ns.length; k++) pairs[k] = [cs[k], cur[ns[k]]];
      /* bondCode first, then the neighbour's previous invariant. Both are
       * small non-negative integers, so the subtractions are exact. */
      pairs.sort(cmpPair);
      /* Array.prototype.join on an array of pairs stringifies each pair with
       * its own comma — "4,123,1,456" — which is exactly the specified
       * "sorted pairs joined with ','". */
      const inv = fnv1a32(cur[i] + "|" + pairs.join(","));
      next[i] = inv;
      setBit(fp, inv % FP_BITS);
    }
    cur = next;
  }

  return fp;
}

function cmpPair(x, y) {
  if (x[0] !== y[0]) return x[0] - y[0];
  if (x[1] !== y[1]) return x[1] - y[1];
  return 0;
}

function isHydrogen(atom) {
  return !!atom && typeof atom === "object" && atom.el === "H";
}

/**
 * Tanimoto similarity as an INTEGER in 0..1000 — floor(1000 * |a AND b| / |a OR b|).
 * Integer popcounts throughout; there is no floating-point accumulation across
 * bits, so the value is exactly reproducible. Returns 0 when the union is
 * empty (two empty fingerprints are not "perfectly similar"; they are two
 * molecules we know nothing about) and 0 for anything that is not usable as a
 * fingerprint, rather than throwing.
 *
 * A fingerprint of the wrong WIDTH is not a fingerprint. Reading FP_WORDS
 * words regardless of the argument would zero-pad a short one and truncate a
 * long one, and hand back a confident-looking similarity computed from bits
 * that were never there — 125, say, from an array an eighth of the contracted
 * size. This value flows straight into a ranked shortlist that people are
 * asked to take seriously, so a mis-sized argument scores as NO EVIDENCE.
 *
 * @param {Uint32Array} a
 * @param {Uint32Array} b
 * @returns {number} 0..1000
 */
export function tanimotoMilli(a, b) {
  if (!a || !b) return 0;
  /* safeGet, not a.length: an argument that is not really a fingerprint may be
   * an object with an accessor, and this function may not throw. */
  if (fpRead(a, "length") !== FP_WORDS || fpRead(b, "length") !== FP_WORDS) return 0;
  let inter = 0;
  let union = 0;
  try {
    for (let i = 0; i < FP_WORDS; i++) {
      /* Both arguments are FP_WORDS wide; a non-numeric element (a plain Array
       * carrying junk) reads as undefined, and undefined >>> 0 is 0, so it
       * degrades to empty instead of throwing. An element accessor that throws
       * outright lands in the catch and scores as no evidence. */
      const x = a[i] >>> 0;
      const y = b[i] >>> 0;
      inter += popcount32(x & y);
      union += popcount32(x | y);
    }
  } catch (_) {
    return 0;
  }
  if (union === 0) return 0;
  /* inter <= union <= 1024, so 1000 * inter <= 1024000 — well inside exact
   * integer range, and the quotient is floored, never rounded. */
  return Math.floor((1000 * inter) / union);
}

/**
 * Number of set bits in a fingerprint. Unlike tanimotoMilli this stays
 * tolerant of a short array — it is a diagnostic count of the bits that ARE
 * there, not a similarity that feeds the shortlist — but it never throws and
 * never reads past FP_WORDS.
 *
 * @param {Uint32Array} fp
 * @returns {number}
 */
export function popcount(fp) {
  if (!fp) return 0;
  const len = fpRead(fp, "length");
  if (typeof len !== "number" || !(len > 0)) return 0;
  let total = 0;
  const n = len < FP_WORDS ? len : FP_WORDS;
  try {
    for (let i = 0; i < n; i++) total += popcount32(fp[i] >>> 0);
  } catch (_) {
    return 0;
  }
  return total;
}
