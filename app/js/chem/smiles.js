/* smiles — the SMILES parser and molecular graph.
 *
 * This is the foundation of the screening path, so it obeys the platform's
 * trust model: DETERMINISM. Two browsers parsing the same string must build
 * the same graph, atom for atom, bond for bond, hydrogen for hydrogen — a
 * screening digest that depends on the parser is only as trustworthy as the
 * parser is reproducible.
 *
 * Consequences, enforced by construction below:
 *   - no Math.random, no Date.now, no clock, no locale, no environment;
 *   - no Math.log/exp/pow/sqrt — only +, -, *, / and comparisons;
 *   - nothing iterates a plain object's keys to produce output; every list
 *     that reaches a caller is built in a fixed order or sorted explicitly
 *     with a code-unit comparator (never localeCompare, which is locale- and
 *     ICU-version-dependent and would silently fork the digest);
 *   - hydrogen counts come from a table, not from a heuristic that could be
 *     tuned differently on two machines.
 *
 * And ROBUSTNESS: nothing here throws. Every exported function is wrapped so
 * that malformed SMILES, hostile JSON, a megabyte of garbage or a non-string
 * returns null (or an empty result) rather than killing a work unit — a
 * volunteer's browser must survive whatever the candidate pool contains.
 *
 * Grammar supported (the practical drug-molecule subset of OpenSMILES):
 *   organic-subset atoms B C N O P S F Cl Br I written bare;
 *   aromatic lowercase b c n o p s;
 *   bracket atoms with isotope, chirality, H count, charge, atom class:
 *     [nH] [Na+] [C@@H] [15N] [Si] [O-] [NH4+] [Fe+2] [C@H](...) [2H];
 *   bonds - = # : and / \ (stereo bonds are read as single bonds; the
 *     cis/trans information is deliberately discarded — see NOTE STEREO);
 *   branches with nested parentheses;
 *   ring closures 1..9, %10..%99, with an optional bond symbol on either or
 *     both ends (C1=CC=CC=C1, C=1CCCCC=1);
 *   dot-disconnected components (salts: "CC(=O)O.[Na+]").
 *
 * NOTE STEREO: stereochemistry is parsed and thrown away. This module builds
 * a constitutional graph — the screen downstream is a 2D similarity screen,
 * and it must give the same answer for a molecule whether or not whoever
 * deposited it recorded its stereocentres. Two SMILES that differ only in @
 * or / therefore produce identical graphs, identical fingerprints and
 * identical scores. That is a deliberate limitation of the screen, not an
 * oversight, and the shortlist it produces is a shortlist of HYPOTHESES for
 * researchers to look at — stereochemistry is one of the first things a
 * researcher looking at one of them would have to restore.
 */

/* ————— hard limits (a work unit must be bounded work) ————— */
const MAX_LEN = 4000;          /* longer input is refused outright */
const MAX_ATOMS = 2000;        /* bounds the graph algorithms below */
const MAX_BRANCH_DEPTH = 200;  /* "((((((..." can never allocate forever */
const MAX_OPEN_RINGS = 200;    /* bounded ring-bond bookkeeping */
/* Every bond costs at least one character of input, so a graph this parser can
 * build never comes near this — it is a ceiling for the exported helpers,
 * which also accept Mol objects nobody parsed. */
const MAX_BONDS = MAX_ATOMS * 4;

/* ————— element table —————
 * Bracket atoms may name any real element; anything not on this list is an
 * unknown element and the whole parse is refused. Being strict here is the
 * cheapest way to reject garbage that merely LOOKS like a molecule. */
const ELEMENTS = new Set(
  ("H,He,Li,Be,B,C,N,O,F,Ne,Na,Mg,Al,Si,P,S,Cl,Ar,K,Ca,Sc,Ti,V,Cr,Mn,Fe,Co,Ni,Cu,Zn," +
   "Ga,Ge,As,Se,Br,Kr,Rb,Sr,Y,Zr,Nb,Mo,Tc,Ru,Rh,Pd,Ag,Cd,In,Sn,Sb,Te,I,Xe,Cs,Ba,La,Ce," +
   "Pr,Nd,Pm,Sm,Eu,Gd,Tb,Dy,Ho,Er,Tm,Yb,Lu,Hf,Ta,W,Re,Os,Ir,Pt,Au,Hg,Tl,Pb,Bi,Po,At,Rn," +
   "Fr,Ra,Ac,Th,Pa,U,Np,Pu,Am,Cm,Bk,Cf,Es,Fm,Md,No,Lr,Rf,Db,Sg,Bh,Hs,Mt,Ds,Rg,Cn,Nh,Fl," +
   "Mc,Lv,Ts,Og").split(",")
);

/* Lowercase symbols legal inside brackets, mapped to their capitalized form.
 * The lowercase spelling is what marks the atom aromatic. */
const AROMATIC_BRACKET = {
  b: "B", c: "C", n: "N", o: "O", p: "P", s: "S",
  se: "Se", as: "As", te: "Te", si: "Si"
};

/* Aromatic organic-subset atoms writable bare, outside brackets. */
const AROMATIC_BARE = { b: "B", c: "C", n: "N", o: "O", p: "P", s: "S" };

/* ————— the valence model —————
 * OpenSMILES' standard valences for the organic subset. An atom's implicit
 * hydrogen count is (the smallest standard valence that is >= the sum of its
 * explicit bond orders) minus that sum; if the atom is already over its
 * largest standard valence it simply gets no hydrogens (we never invent a
 * negative count, and we never refuse a molecule for being over-valent —
 * refusing real deposited structures is worse than tolerating an odd one).
 *
 * N and P list 5 as well as 3 so that a SUBSTITUTED nitro group CN(=O)=O and
 * a phosphate P(=O)(O)(O)O land on 0 H rather than being read as over-valent.
 * (Bare "N(=O)=O" sums to 4, so the next standard valence is 5 and it takes
 * one implicit hydrogen — HNO2. That is the valence model working as written,
 * not a special case for nitro; only the substituted form reaches 5.)
 * S lists 2/4/6 for sulfoxides and sulfones.
 *
 * Formal charge: bare organic-subset atoms are ALWAYS neutral in SMILES —
 * a charge can only be written inside brackets, and a bracket atom states
 * its hydrogen count explicitly and never receives implicit H. So the charge
 * correction that a general-purpose toolkit needs here has nothing to act on:
 * [NH4+] has 4 H because it says 4, and [O-] has 0 H because it says none.
 * That is why this table carries no charge term. */
const VALENCES = {
  B: [3], C: [4], N: [3, 5], O: [2], P: [3, 5], S: [2, 4, 6],
  F: [1], Cl: [1], Br: [1], I: [1]
};

/* ————— the aromatic hydrogen model —————
 * Aromaticity is taken from the notation, never perceived (see NOTE AROMATIC
 * near ringInfo). For an atom written lowercase we count each aromatic bond
 * as one connection and read the hydrogen off this table:
 *
 *   c  ->  3 - connections     benzene c1ccccc1: 2 ring bonds -> 1 H each;
 *                              toluene's substituted carbon: 3 -> 0 H;
 *                              a naphthalene fusion carbon: 3 -> 0 H.
 *   n, p, b, as -> 2 - connections
 *                              pyridine n: 2 ring bonds -> 0 H, correct;
 *                              N-substituted n: 3 -> 0 H, correct.
 *   o, s, se, te -> 0          furan's o and thiophene's s carry no H.
 *
 * The deliberate consequence: a bare lowercase `n` NEVER gets a hydrogen.
 * Pyrrole's nitrogen therefore has to be written [nH], which is exactly what
 * every SMILES producer does and what the OpenSMILES specification requires —
 * guessing an H onto a bare `n` would silently disagree with the depositor. */
const AROM_H_BUDGET = { C: 3, N: 2, P: 2, B: 2, As: 2 };

/* ————— tiny character predicates (no regex on the hot path) ————— */
function isDigit(c) { return c >= "0" && c <= "9"; }
function isUpper(c) { return c >= "A" && c <= "Z"; }
function isLower(c) { return c >= "a" && c <= "z"; }

/* Code-unit string comparison. Explicitly NOT localeCompare: element order in
 * a formula must be identical on every device forever. */
function cmpStr(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/* ============================================================ parse ===== */

/* parseSmiles(smiles) -> Mol | null
 *   Mol = { atoms: [{ el, arom, charge, hcount, ring }],
 *           bonds: [{ a, b, order, arom, ring }] }
 * Returns null — never throws — for every malformed, hostile or oversized
 * input. */
export function parseSmiles(smiles) {
  try {
    return parseInner(smiles);
  } catch (_e) {
    /* A defence in depth, not a plan: parseInner is written to return null on
     * every path it knows about. If it ever finds one it does not know about,
     * a volunteer's screening run still must not die. */
    return null;
  }
}

function parseInner(src) {
  if (typeof src !== "string") return null;
  const n = src.length;
  if (n === 0 || n > MAX_LEN) return null;

  /* raw atoms carry two extra fields the public Mol does not:
   *   brH   — the hydrogen count a bracket atom stated, or -1 for a bare atom
   *   folded — explicit [H] atoms collapsed into this atom later */
  const atoms = [];
  const bonds = [];
  const bondKeys = new Set();   /* "a:b" with a<b — rejects duplicate bonds */

  let prev = -1;                /* atom the next atom bonds back to */
  let pending = null;           /* bond symbol seen but not yet consumed */
  const branch = [];            /* saved `prev` values, one per open paren */
  const openRings = new Map();  /* ring number -> { atom, order, arom, explicit } */

  let i = 0;
  while (i < n) {
    const c = src[i];

    /* — component break — */
    if (c === ".") {
      if (pending !== null) return null;   /* "C=.C" is nonsense */
      prev = -1;
      i++;
      continue;
    }

    /* — bond symbols — */
    if (c === "-" || c === "=" || c === "#" || c === ":" || c === "/" || c === "\\") {
      if (pending !== null) return null;   /* "C==C" */
      /* NOTE STEREO: / and \ are directional single bonds. We keep the bond
       * and discard the direction. */
      pending = {
        order: c === "=" ? 2 : (c === "#" ? 3 : 1),
        arom: c === ":",
        explicit: true
      };
      i++;
      continue;
    }

    /* — branches — */
    if (c === "(") {
      if (prev < 0) return null;           /* "(C)" / "((((", nothing to branch from */
      if (pending !== null) return null;   /* "C=(C)" */
      if (branch.length >= MAX_BRANCH_DEPTH) return null;
      branch.push(prev);
      i++;
      continue;
    }
    if (c === ")") {
      if (branch.length === 0) return null;  /* unbalanced */
      if (pending !== null) return null;     /* "C(=)" */
      prev = branch.pop();
      i++;
      continue;
    }

    /* — ring closures — */
    if (isDigit(c) || c === "%") {
      let num = -1;
      if (c === "%") {
        /* %NN — exactly two digits, 10..99 */
        if (i + 2 >= n || !isDigit(src[i + 1]) || !isDigit(src[i + 2])) return null;
        num = (src.charCodeAt(i + 1) - 48) * 10 + (src.charCodeAt(i + 2) - 48);
        if (num < 10) return null;
        i += 3;
      } else {
        num = src.charCodeAt(i) - 48;
        i += 1;
      }
      if (prev < 0) return null;             /* a ring bond with no atom */
      const bond = pending;
      pending = null;

      const open = openRings.get(num);
      if (open === undefined) {
        if (openRings.size >= MAX_OPEN_RINGS) return null;
        openRings.set(num, {
          atom: prev,
          order: bond === null ? 0 : bond.order,
          arom: bond === null ? false : bond.arom,
          explicit: bond !== null
        });
        continue;
      }
      /* closing it */
      openRings.delete(num);
      const a = open.atom, b = prev;
      if (a === b) return null;              /* "C11" — an atom bonded to itself */
      if (!addBond(a, b)) return null;       /* already bonded — reject */

      let order, arom;
      if (open.explicit && bond !== null) {
        /* both ends wrote a bond symbol; they have to agree */
        if (open.order !== bond.order || open.arom !== bond.arom) return null;
        order = bond.order; arom = bond.arom;
      } else if (open.explicit) {
        order = open.order; arom = open.arom;
      } else if (bond !== null) {
        order = bond.order; arom = bond.arom;
      } else {
        /* default: aromatic when both ends are aromatic, single otherwise */
        arom = atoms[a].arom && atoms[b].arom;
        order = 1;
      }
      bonds.push({ a, b, order, arom, ring: false });
      continue;
    }

    /* — bracket atom — */
    if (c === "[") {
      const res = readBracket(src, i, n);
      if (res === null) return null;
      if (atoms.length >= MAX_ATOMS) return null;
      const idx = atoms.length;
      atoms.push(res.atom);
      if (!linkToPrev(idx)) return null;
      prev = idx;
      i = res.next;
      continue;
    }

    /* — bare organic-subset atom — */
    if (isUpper(c) || isLower(c)) {
      let el = null, arom = false, len = 0;
      /* two-character symbols first, so "Cl" never reads as "C" then "l" */
      if (i + 1 < n) {
        const two = c + src[i + 1];
        if (two === "Cl" || two === "Br") { el = two; len = 2; }
      }
      if (el === null) {
        if (c === "B" || c === "C" || c === "N" || c === "O" || c === "P" ||
            c === "S" || c === "F" || c === "I") {
          el = c; len = 1;
        } else if (Object.prototype.hasOwnProperty.call(AROMATIC_BARE, c)) {
          el = AROMATIC_BARE[c]; arom = true; len = 1;
        }
      }
      if (el === null) return null;          /* not in the organic subset */
      if (atoms.length >= MAX_ATOMS) return null;
      const idx = atoms.length;
      atoms.push({ el, arom, charge: 0, hcount: 0, ring: false, brH: -1, folded: 0 });
      if (!linkToPrev(idx)) return null;
      prev = idx;
      i += len;
      continue;
    }

    /* anything else — '*', '$', whitespace, a stray '%', a byte of garbage */
    return null;
  }

  if (pending !== null) return null;         /* trailing "C=" */
  if (branch.length !== 0) return null;      /* unbalanced parentheses */
  if (openRings.size !== 0) return null;     /* unclosed ring, e.g. "C1CC" */
  if (atoms.length === 0) return null;

  return finalize(atoms, bonds);

  /* ---- closures over atoms/bonds ---- */

  function addBond(a, b) {
    const key = a < b ? a + ":" + b : b + ":" + a;
    if (bondKeys.has(key)) return false;
    bondKeys.add(key);
    return true;
  }

  /* Bond a freshly created atom back to whatever precedes it. */
  function linkToPrev(idx) {
    if (prev < 0) {
      /* start of the string or start of a component: no bond, and a bond
       * symbol here ("=CC" / "C.=C") is malformed */
      if (pending !== null) return false;
      return true;
    }
    let order, arom;
    if (pending !== null) {
      order = pending.order; arom = pending.arom;
      pending = null;
    } else {
      /* the default bond: aromatic between two aromatic atoms, else single */
      arom = atoms[prev].arom && atoms[idx].arom;
      order = 1;
    }
    if (!addBond(prev, idx)) return false;
    bonds.push({ a: prev, b: idx, order, arom, ring: false });
    return true;
  }
}

/* Read one [...] atom starting at `start`. Returns { atom, next } or null.
 * Bracket grammar, in order: isotope, symbol, chirality, H count, charge,
 * atom class. */
function readBracket(src, start, n) {
  let i = start + 1;
  if (i >= n) return null;

  /* isotope — parsed and then deliberately discarded. The graph a screen
   * works on is the same graph whichever isotope was deposited; keeping it
   * would make two labellings of one molecule score differently. */
  while (i < n && isDigit(src[i])) { i++; if (i - start > 6) return null; }

  /* symbol */
  if (i >= n) return null;
  let el = null, arom = false;
  const c = src[i];
  if (isUpper(c)) {
    const two = i + 1 < n && isLower(src[i + 1]) ? c + src[i + 1] : null;
    if (two !== null && ELEMENTS.has(two)) { el = two; i += 2; }
    else if (ELEMENTS.has(c)) { el = c; i += 1; }
    else return null;
  } else if (isLower(c)) {
    const two = i + 1 < n && isLower(src[i + 1]) ? c + src[i + 1] : null;
    if (two !== null && Object.prototype.hasOwnProperty.call(AROMATIC_BRACKET, two)) {
      el = AROMATIC_BRACKET[two]; arom = true; i += 2;
    } else if (Object.prototype.hasOwnProperty.call(AROMATIC_BRACKET, c)) {
      el = AROMATIC_BRACKET[c]; arom = true; i += 1;
    } else return null;
  } else {
    return null;                             /* [*], [$], [] */
  }

  /* chirality — @, @@, or @TH1 / @AL2 / @SP1 / @TB15 / @OH20. Discarded. */
  if (i < n && src[i] === "@") {
    i++;
    if (i < n && src[i] === "@") i++;
    else if (i + 1 < n && isUpper(src[i]) && isUpper(src[i + 1])) {
      const cls = src[i] + src[i + 1];
      if (cls === "TH" || cls === "AL" || cls === "SP" || cls === "TB" || cls === "OH") {
        i += 2;
        while (i < n && isDigit(src[i])) i++;
      }
    }
  }

  /* hydrogen count — bracket atoms state it, and get no implicit H ever */
  let brH = 0;
  if (i < n && src[i] === "H") {
    i++;
    brH = 1;
    if (i < n && isDigit(src[i])) {
      brH = src.charCodeAt(i) - 48;
      i++;
      if (i < n && isDigit(src[i])) return null;   /* [CH42] is not a thing */
    }
  }

  /* charge — +, -, ++, --, +2, -3 */
  let charge = 0;
  if (i < n && (src[i] === "+" || src[i] === "-")) {
    const sign = src[i] === "+" ? 1 : -1;
    const sym = src[i];
    i++;
    if (i < n && isDigit(src[i])) {
      let v = 0, digits = 0;
      while (i < n && isDigit(src[i]) && digits < 2) {
        v = v * 10 + (src.charCodeAt(i) - 48);
        i++; digits++;
      }
      charge = sign * v;
    } else {
      let count = 1;
      while (i < n && src[i] === sym && count < 15) { count++; i++; }
      charge = sign * count;
    }
  }

  /* atom class :nn — parsed and discarded */
  if (i < n && src[i] === ":") {
    i++;
    let digits = 0;
    while (i < n && isDigit(src[i]) && digits < 5) { i++; digits++; }
    if (digits === 0) return null;
  }

  if (i >= n || src[i] !== "]") return null;
  return {
    atom: { el, arom, charge, hcount: 0, ring: false, brH, folded: 0 },
    next: i + 1
  };
}

/* ============================================== hydrogens + rings ======= */

/* Collapse explicit [H] atoms, count hydrogens, perceive rings, and hand back
 * the public Mol shape. */
function finalize(rawAtoms, rawBonds) {
  /* — 1. fold plain [H] atoms into their neighbour —
   * An explicit hydrogen written as its own atom is the same hydrogen as an
   * implicit one, and the Mol contract says hcount is the TOTAL attached
   * hydrogens. So [H] atoms that are ordinary terminal hydrogens are removed
   * from the graph. Two guards: an H that carries a charge ([H+]) or its own
   * hydrogens is a real species and stays; and [H][H] (both neighbours are
   * hydrogen) is left alone so dihydrogen does not annihilate itself.
   * Isotope labels were already discarded, so [2H] folds like any other H —
   * a deuterated analogue and its parent share one graph, on purpose.
   *
   * Over-valent explicit hydrogens are DROPPED, not refused, which is the same
   * tolerance the valence model shows: "[H]C([H])([H])([H])[H]" states five
   * hydrogens on one carbon and comes out as CH4, because step 3 hands a bare
   * atom whatever the valence table allows and never more. Five hydrogens on a
   * carbon is not a molecule; answering with methane is the module's standing
   * choice to tolerate an odd deposited structure rather than lose it. */
  const nA = rawAtoms.length;
  const deg = new Int32Array(nA);
  const oneBond = new Int32Array(nA).fill(-1);
  for (let k = 0; k < rawBonds.length; k++) {
    const bd = rawBonds[k];
    deg[bd.a]++; deg[bd.b]++;
    oneBond[bd.a] = k; oneBond[bd.b] = k;
  }
  const dropped = new Uint8Array(nA);
  for (let a = 0; a < nA; a++) {
    const at = rawAtoms[a];
    if (at.el !== "H" || at.charge !== 0 || at.brH !== 0 || deg[a] !== 1) continue;
    const bd = rawBonds[oneBond[a]];
    if (bd.order !== 1 || bd.arom) continue;
    const other = bd.a === a ? bd.b : bd.a;
    if (rawAtoms[other].el === "H") continue;   /* [H][H] stays whole */
    dropped[a] = 1;
    rawAtoms[other].folded++;
  }

  /* — 2. reindex — */
  const map = new Int32Array(nA).fill(-1);
  const atoms = [];
  for (let a = 0; a < nA; a++) {
    if (dropped[a]) continue;
    map[a] = atoms.length;
    atoms.push(rawAtoms[a]);
  }
  if (atoms.length === 0) return null;
  const bonds = [];
  for (let k = 0; k < rawBonds.length; k++) {
    const bd = rawBonds[k];
    if (dropped[bd.a] || dropped[bd.b]) continue;
    bonds.push({ a: map[bd.a], b: map[bd.b], order: bd.order, arom: bd.arom, ring: false });
  }

  /* — 3. hydrogen counts — */
  const sum = new Int32Array(atoms.length);
  for (let k = 0; k < bonds.length; k++) {
    const bd = bonds[k];
    /* an aromatic bond contributes one connection to the valence sum; the
     * ring's extra half-bond is accounted for by AROM_H_BUDGET instead */
    const w = bd.arom ? 1 : bd.order;
    sum[bd.a] += w; sum[bd.b] += w;
  }
  for (let a = 0; a < atoms.length; a++) {
    const at = atoms[a];
    if (at.brH >= 0) {
      /* a bracket atom takes its stated count verbatim, plus any [H] atoms
       * that were folded into it, and never gets implicit hydrogens */
      at.hcount = at.brH + at.folded;
    } else if (at.arom) {
      /* An explicitly written hydrogen is a FACT the depositor stated; the
       * budget table is only a model for the ones nobody wrote down. Step 1
       * folded any [H] neighbour away, so `sum` no longer counts that bond and
       * the table would silently swallow the hydrogen: a bare `n` with two
       * ring bonds is defined here as having no H, so "[H]n1cccc1" (a legal
       * spelling of pyrrole) came out as C4H4N — pyrrole minus a hydrogen —
       * and fingerprinted at 142/1000 against "c1cc[nH]c1", the same molecule.
       * So the folded hydrogens are counted first and the table only fills
       * whatever budget is left over. For carbon this changes nothing (the
       * budget happened to reproduce the folded H by luck: benzene's
       * "[H]c1ccccc1" is 1 either way); for n/o/s it is the difference
       * between the right formula and the wrong one. */
      const budget = Object.prototype.hasOwnProperty.call(AROM_H_BUDGET, at.el)
        ? AROM_H_BUDGET[at.el] : 0;
      const rest = budget - sum[a] - at.folded;
      at.hcount = at.folded + (rest > 0 ? rest : 0);
    } else {
      /* Bare atoms whose explicit hydrogens were folded away are refilled by
       * the valence model itself: the folded bond is gone from `sum`, so the
       * implicit count comes back out at exactly the same number. Adding
       * `folded` here as well would double-count it. */
      at.hcount = implicitH(at.el, sum[a]);
    }
    delete at.brH;
    delete at.folded;
  }

  /* — 4. refuse contradictory aromatic notation —
   * There are two ways to say "aromatic" in SMILES — a lowercase atom, and a
   * ':' bond — and the valence sum above weights a bond by the BOND's flag
   * while the hydrogen model above picks its budget by the ATOM's flag. When
   * the two conventions are mixed the answers stop meaning anything:
   * "C1:C:C:C:C:C1" (uppercase atoms joined by ':') used to come out as C6H12,
   * benzene with six hydrogens too many, and "c1=cc=cc=c1" (lowercase atoms
   * given explicit Kekulé orders) as C6, benzene with no hydrogens at all.
   * Both parsed silently and the first fingerprinted at 0/1000 against real
   * benzene. Neither notation is sanctioned by OpenSMILES and no mainstream
   * producer emits either, so this is malformed input — and this module's rule
   * for malformed input is to refuse it, not to guess at it. Checked here,
   * before applyRings, because applyRings clears the aromatic flag on bonds it
   * proves are not in a ring and would hide the first contradiction. */
  for (let k = 0; k < bonds.length; k++) {
    const bd = bonds[k];
    /* an aromatic bond joins two aromatic atoms, by definition */
    if (bd.arom === true && !(atoms[bd.a].arom && atoms[bd.b].arom)) return null;
  }

  /* — 5. rings — */
  applyRings(atoms, bonds);

  /* The other half of the same contradiction, which needs the ring result: an
   * aromatic atom cannot also carry a Kekulé multiple bond INSIDE a ring — it
   * has already spent that bond order on the aromatic system. An exocyclic
   * double bond is fine and common (2-pyridone "O=c1cccc[nH]1", coumarin),
   * which is exactly why the test is restricted to ring bonds. */
  for (let k = 0; k < bonds.length; k++) {
    const bd = bonds[k];
    if (!bd.ring || bd.arom === true || bd.order <= 1) continue;
    if (atoms[bd.a].arom === true || atoms[bd.b].arom === true) return null;
  }

  return { atoms, bonds };
}

function implicitH(el, bonded) {
  const vs = Object.prototype.hasOwnProperty.call(VALENCES, el) ? VALENCES[el] : null;
  if (vs === null) return 0;                 /* metals and everything exotic */
  for (let k = 0; k < vs.length; k++) {
    if (vs[k] >= bonded) return vs[k] - bonded;
  }
  return 0;                                  /* over-valent: tolerate, add none */
}

/* ————— ring perception —————
 * A bond lies on a cycle exactly when it is NOT a bridge, so ring membership
 * is Tarjan's bridge search — exact, linear, and free of the ambiguity that
 * makes "find the smallest set of smallest rings" a choice rather than a
 * fact. The DFS is iterative: a 2000-atom fused system must not depend on the
 * host's stack depth, which differs between browsers and Node.
 *
 * rings is the circuit rank, bonds - atoms + connectedComponents. That is the
 * SSSR *count*, which is well-defined even though the ring SET is not, and it
 * is what descriptors want.
 *
 * Worked example, because this number is easy to eyeball wrong: cubane
 * ("C1(C2C3C14)C5C2C3C45") has 12 bonds over 8 atoms in one component, so the
 * circuit rank is 12 - 8 + 1 = 5. Five, not the four faces a drawing of a cube
 * suggests — the sixth face is the sum of the other five and is not
 * independent. The SSSR count is 5 too. If a note anywhere says 4, the note is
 * wrong and this code is right.
 */
function bridgeScan(atoms, bonds) {
  const nA = atoms.length, nB = bonds.length;
  /* adjacency in CSR form — fixed iteration order, no object key walking */
  const head = new Int32Array(nA + 1);
  for (let k = 0; k < nB; k++) { head[bonds[k].a + 1]++; head[bonds[k].b + 1]++; }
  for (let a = 0; a < nA; a++) head[a + 1] += head[a];
  const cursor = Int32Array.from(head.subarray(0, nA));
  const adjTo = new Int32Array(nB * 2);
  const adjEdge = new Int32Array(nB * 2);
  for (let k = 0; k < nB; k++) {
    const bd = bonds[k];
    adjTo[cursor[bd.a]] = bd.b; adjEdge[cursor[bd.a]] = k; cursor[bd.a]++;
    adjTo[cursor[bd.b]] = bd.a; adjEdge[cursor[bd.b]] = k; cursor[bd.b]++;
  }

  const disc = new Int32Array(nA).fill(-1);
  const low = new Int32Array(nA);
  const isBridge = new Uint8Array(nB);
  const stV = new Int32Array(nA + 1);
  const stE = new Int32Array(nA + 1);
  const stI = new Int32Array(nA + 1);
  let timer = 0, components = 0;

  for (let root = 0; root < nA; root++) {
    if (disc[root] !== -1) continue;
    components++;
    disc[root] = low[root] = timer++;
    let top = 0;
    stV[0] = root; stE[0] = -1; stI[0] = head[root];
    while (top >= 0) {
      const v = stV[top];
      if (stI[top] < head[v + 1]) {
        const p = stI[top]++;
        const e = adjEdge[p], to = adjTo[p];
        if (e === stE[top]) continue;        /* never walk back up the tree edge */
        if (disc[to] === -1) {
          disc[to] = low[to] = timer++;
          top++;
          stV[top] = to; stE[top] = e; stI[top] = head[to];
        } else if (disc[to] < low[v]) {
          low[v] = disc[to];
        }
      } else {
        const e = stE[top];
        top--;
        if (top >= 0) {
          const par = stV[top];
          if (low[v] < low[par]) low[par] = low[v];
          if (low[v] > disc[par]) isBridge[e] = 1;
        }
      }
    }
  }
  return { isBridge, components };
}

function applyRings(atoms, bonds) {
  const { isBridge } = bridgeScan(atoms, bonds);
  for (let a = 0; a < atoms.length; a++) atoms[a].ring = false;
  for (let k = 0; k < bonds.length; k++) {
    const inRing = isBridge[k] === 0;
    bonds[k].ring = inRing;
    if (inRing) { atoms[bonds[k].a].ring = true; atoms[bonds[k].b].ring = true; }
    /* An aromatic bond outside every ring is a contradiction in terms, and
     * this is the first point in the parse where we can PROVE it: the bridge
     * scan has just said the bond lies on no cycle. The flag gets set upstream
     * by the OpenSMILES default "no bond symbol between two aromatic atoms
     * means an aromatic bond" (linkToPrev and the ring-closure default), which
     * is right inside a ring and wrong for the bridge between two of them. It
     * matters because morganFingerprint keys its bond invariants on this flag,
     * so the two legal spellings of biphenyl — "c1ccccc1-c1ccccc1" with the
     * disambiguating single bond and "c1ccccc1c1ccccc1" without it — used to
     * fingerprint at 500/1000 against each other. aromatic.js cannot repair
     * it downstream: aromatize() only ever SETS b.arom, it has no path that
     * clears one. Hydrogen counts are computed in step 3, before this runs,
     * and the valence weight there is 1 for an aromatic bond and 1 for the
     * order-1 bond it becomes, so no formula moves. */
    if (!inRing) bonds[k].arom = false;
  }
}

/* ================================================== public helpers ===== */

/* ringInfo(mol) -> { rings, aromaticRings, ringAtoms:Set<number> }
 *
 * NOTE AROMATIC: aromaticity is READ, never PERCEIVED. An atom is aromatic
 * here if and only if the SMILES said so — lowercase symbols, or a ':' bond.
 * No Hückel rule is applied. That means a molecule deposited in Kekulé form
 * ("CN1C=NC2=C1..." for caffeine) reports rings but ZERO aromatic rings,
 * while the same molecule deposited in aromatic form reports two. The graph
 * is faithful to the depositor either way, and it is deterministic either
 * way — which is what the trust model requires — but the harvester must
 * normalise its pool to one convention or the two forms of one molecule will
 * be treated as two different molecules by everything downstream. That is a
 * pipeline decision, not a parser one, so this module refuses to guess.
 *
 * aromaticRings is the circuit rank of the subgraph made of aromatic bonds
 * that are also ring bonds: benzene 1, naphthalene 2, biphenyl 2, a
 * pyrimidine-fused purine 2. It counts aromatic CYCLES, not ring systems —
 * a fused bicyclic aromatic counts twice, which is the same convention the
 * total `rings` count uses, so the two numbers are comparable. */
export function ringInfo(mol) {
  const empty = { rings: 0, aromaticRings: 0, ringAtoms: new Set() };
  try {
    if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) return empty;
    const atoms = mol.atoms, bonds = mol.bonds;
    const nA = atoms.length;
    if (nA === 0) return empty;
    /* Bounded work, not just correct work: a Mol that did not come from this
     * parser (hand-built, or JSON deserialized from a work unit) can claim any
     * atoms.length it likes, and a bare `new Array(1e9)` here would stall a
     * volunteer's tab inside the Web Worker for as long as the loop ran. The
     * parser's own ceilings are the honest bound — nothing it can produce is
     * affected — and an oversized graph is refused the same way every other
     * malformed input is. */
    if (nA > MAX_ATOMS || bonds.length > MAX_BONDS) return empty;
    /* hostile Mol objects reach here through screenMolecule's error paths and
     * through anything that hand-builds a graph — validate the indices */
    const clean = [];
    for (let k = 0; k < bonds.length; k++) {
      const bd = bonds[k];
      if (!bd) continue;
      const a = bd.a, b = bd.b;
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      if (a < 0 || b < 0 || a >= nA || b >= nA || a === b) continue;
      clean.push(bd);
    }
    const { isBridge, components } = bridgeScan(atoms, clean);

    const ringAtoms = new Set();
    const aromNodes = new Set();
    let aromEdges = 0;
    const aromBonds = [];
    for (let k = 0; k < clean.length; k++) {
      if (isBridge[k] !== 0) continue;
      const bd = clean[k];
      ringAtoms.add(bd.a);
      ringAtoms.add(bd.b);
      if (bd.arom === true && atoms[bd.a] && atoms[bd.b] &&
          atoms[bd.a].arom === true && atoms[bd.b].arom === true) {
        aromEdges++;
        aromNodes.add(bd.a);
        aromNodes.add(bd.b);
        aromBonds.push(bd);
      }
    }
    const rings = clean.length - nA + components;

    /* circuit rank of the aromatic ring subgraph, on its own node set */
    let aromaticRings = 0;
    if (aromEdges > 0) {
      /* renumber the aromatic nodes densely, in ascending index order so the
       * result cannot depend on Set insertion order */
      const nodes = Array.from(aromNodes);
      nodes.sort((x, y) => x - y);
      const idx = new Map();
      for (let k = 0; k < nodes.length; k++) idx.set(nodes[k], k);
      const sub = [];
      for (let k = 0; k < aromBonds.length; k++) {
        sub.push({ a: idx.get(aromBonds[k].a), b: idx.get(aromBonds[k].b) });
      }
      const fake = new Array(nodes.length);
      for (let k = 0; k < nodes.length; k++) fake[k] = 0;
      const sc = bridgeScan(fake, sub);
      aromaticRings = sub.length - nodes.length + sc.components;
      if (aromaticRings < 0) aromaticRings = 0;
    }

    return { rings: rings > 0 ? rings : 0, aromaticRings, ringAtoms };
  } catch (_e) {
    return empty;
  }
}

/* heavyAtomCount(mol) -> number of non-hydrogen atoms. */
export function heavyAtomCount(mol) {
  try {
    if (!mol || !Array.isArray(mol.atoms)) return 0;
    if (mol.atoms.length > MAX_ATOMS) return 0;   /* see the note in ringInfo */
    let count = 0;
    for (let a = 0; a < mol.atoms.length; a++) {
      const at = mol.atoms[a];
      if (at && at.el !== "H") count++;
    }
    return count;
  } catch (_e) {
    return 0;
  }
}

/* molecularFormula(mol) -> Hill notation.
 * Carbon first, hydrogen second, then every other element in code-unit
 * ascending order; a count of 1 is written as nothing. Hydrogens are the sum
 * of every atom's hcount plus any hydrogen that survived as its own atom
 * ([H+], [H-], dihydrogen). Charge is not rendered: "[Na+]" -> "Na". */
export function molecularFormula(mol) {
  try {
    if (!mol || !Array.isArray(mol.atoms)) return "";
    if (mol.atoms.length > MAX_ATOMS) return "";  /* see the note in ringInfo */
    const counts = new Map();
    let h = 0;
    for (let a = 0; a < mol.atoms.length; a++) {
      const at = mol.atoms[a];
      if (!at || typeof at.el !== "string" || at.el.length === 0) continue;
      const hc = Number.isInteger(at.hcount) && at.hcount > 0 ? at.hcount : 0;
      h += hc;
      if (at.el === "H") { h += 1; continue; }
      counts.set(at.el, (counts.get(at.el) || 0) + 1);
    }
    const rest = [];
    for (const el of counts.keys()) {
      if (el !== "C") rest.push(el);
    }
    rest.sort(cmpStr);

    let out = "";
    const c = counts.get("C") || 0;
    if (c > 0) out += "C" + (c === 1 ? "" : String(c));
    if (h > 0) out += "H" + (h === 1 ? "" : String(h));
    for (let k = 0; k < rest.length; k++) {
      const cnt = counts.get(rest[k]);
      out += rest[k] + (cnt === 1 ? "" : String(cnt));
    }
    return out;
  } catch (_e) {
    return "";
  }
}
