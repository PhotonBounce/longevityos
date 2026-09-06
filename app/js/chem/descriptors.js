/* descriptors — the physicochemical profile of one molecule.
 *
 * descriptors(mol) -> { mw, heavy, hbd, hba, rotb, rings, aromRings,
 *                       tpsa, clogp, charge, fsp3 }
 *   ... or null, deliberately, for a Mol this module cannot describe honestly
 *   (a missing atom list, an element with no published atomic weight). FAIL
 *   CLOSED: every caller handles null, and a molecular weight quietly missing
 *   an atom is worse than no answer at all.
 *   A twelfth diagnostic, `tpsaUnknown`, is attached non-enumerably — readable
 *   as d.tpsaUnknown, invisible to Object.keys and JSON.stringify, so the
 *   eleven-key contract every consumer is written against holds exactly.
 *
 * These numbers are the triage layer of the screen: they never claim anything
 * about what a molecule DOES, only what it is made of and roughly how it is
 * likely to behave in the crude, published, well-known sense that Lipinski and
 * Veber meant. A shortlist built on them is a shortlist of hypotheses for a
 * researcher to look at.
 *
 * DETERMINISM, which is the swarm's whole trust model, is a correctness
 * requirement here and is enforced by construction:
 *   - no Math.random, no clock, no locale, no transcendental math (an engine
 *     that rounds Math.log one bit differently would fork every digest);
 *   - only +, -, *, / and integer comparisons reach a returned value;
 *   - every iteration runs over an array in a fixed index order — no plain
 *     object's key order and no Set/Map insertion order ever reaches output;
 *   - rounding is Math.round(x * 100) / 100, exactly specified by ECMA-262.
 * And ROBUSTNESS: this function never throws. Hostile, hand-built or partial
 * Mol objects return null, which every caller already handles.
 *
 * ————— THE HONEST LIMITS OF THESE NUMBERS —————
 *
 * 1. TPSA is the published Ertl (2000) fragment sum. Every constant below is
 *    quoted from that table with its environment written out beside it. An
 *    environment the table does not cover contributes ZERO and is counted in
 *    `tpsaUnknown` — this module never guesses a fragment value, because a
 *    plausible-looking invented constant is exactly the kind of error that
 *    survives every test and quietly poisons a ranked list.
 *
 *    WHICH ERTL VARIANT, AND WHY IT MATTERS DOWNSTREAM. The sum below is the
 *    FULL published table: nitrogen, oxygen AND the sulfur and phosphorus
 *    fragments. The number a researcher will read on PubChem is the N+O-only
 *    variant, and so is the sum Veber calibrated the tpsa > 140 cutoff in
 *    score.js against. So a sulfonamide or a phosphate is reported here some
 *    8-20 Å² above its public value (taurine 88.77 vs 80.39, celecoxib 85.84
 *    vs 77.46, NAD+ 337.58 vs 317.96) and reaches that cutoff earlier than the
 *    rule intends. That is a live decision for whoever owns the threshold, not
 *    a settled one: either the S/P terms come out to match the published
 *    convention, or the cutoff is re-derived for this variant — but the two
 *    halves have to be decided together, and before ENGINE_VERSION is frozen,
 *    because either choice moves every stored digest. Note also that the S
 *    block, the P block, the eight cationic-nitrogen constants and OM_1S are
 *    at present pinned by no test in qa/chem.mjs.
 *
 * 2. cLogP is a Wildman–Crippen (1999) atomic-contribution sum, and it is a
 *    SUBSET of that method, not a reimplementation of it. The published model
 *    is 68 SMARTS-defined atom types; what follows is a hand-written classifier
 *    covering the environments that actually occur in drug-like molecules,
 *    with unmatched atoms falling back to their element's published class
 *    default. Spot-checked against reference values it reproduces benzene
 *    (1.687) and ethanol (-0.001) exactly and lands within a few tenths on
 *    substituted aromatics; on unusual chemistry it will drift. It is used in
 *    this app only to compare against the Lipinski threshold of 5, which it is
 *    accurate enough for, and it must never be reported to a user as a
 *    measured partition coefficient.
 *
 * 3. AROMATICITY. The parser in ./smiles.js reads aromaticity, it does not
 *    perceive it (see NOTE AROMATIC there), so a molecule deposited in Kekulé
 *    form — which is most of PubChem — arrives with every aromatic flag false.
 *    TPSA and cLogP both type nitrogen, oxygen and carbon differently inside an
 *    aromatic ring, so descriptors would be wrong for half the candidate pool
 *    if it took the flags at face value. This module therefore runs its own
 *    small, deterministic ring perception (below) ON TOP of whatever the SMILES
 *    declared: declared aromaticity is always believed, and a Kekulé ring is
 *    additionally tested against a Hückel electron count. It is deliberately
 *    conservative — see ringIsAromatic for exactly what it refuses and why.
 *
 *    ————— THERE ARE TWO AROMATICITY PERCEPTIONS IN THIS ENGINE, AND THAT IS
 *    A KNOWN, UNRESOLVED SEAM. NOT A DESIGN. —————
 *
 *    Everything that screens a molecule enters through molFromSmiles()
 *    (aromatic.js), which perceives aromaticity and MUTATES the arom flags
 *    before descriptors() ever sees the graph. Because rule 1 above believes
 *    declared aromaticity without argument, and aromatic.js's rule is the more
 *    permissive of the two (it lets a ring carbonyl contribute zero and stay
 *    in the ring, this module refuses the ring outright), the perception below
 *    adds nothing at all on the screening path — measured: not one extra
 *    aromatic flag across the 27 reference actives and 22 further drug-like
 *    molecules. What it does do is decide the numbers whenever a caller hands
 *    over a RAW parseSmiles graph, which is what qa/chem.mjs does — so the
 *    gate currently pins values the swarm never computes. Caffeine, Kekulé,
 *    measured both ways: TPSA 57.92 / 60.26, cLogP -0.58 / 0.88, aromatic
 *    rings 1 / 2. The pinned "caffeine TPSA 58.44 ±1.5" passes only on the
 *    raw graph.
 *
 *    So the claim two paragraphs up — that refusing caffeine's dione ring is
 *    "what reproduces caffeine's published TPSA" — is true of this module read
 *    alone and NOT true of the app: on the screening path aromatic.js has
 *    already called that ring aromatic and descriptors agrees with it.
 *
 *    ONE model has to win, and the choice cannot be made inside this file:
 *    matching aromatic.js here means re-pinning qa/chem.mjs's published
 *    values, and keeping this stricter rule means aromatic.js adopting it.
 *    Both files belong to other hands. It must be settled BEFORE
 *    ENGINE_VERSION is frozen — it moves every stored digest — and it is the
 *    reason two chemically identical spellings can still be scored by
 *    different rules today. Until then, this module is documented as it
 *    behaves rather than as it wishes it behaved.
 */

import { ringInfo } from "./smiles.js";

/* ————— atomic weights —————
 * Standard atomic weights, IUPAC 2021, to four decimal places (fewer where the
 * published value itself carries fewer). An element that is not on this list
 * has no weight here, and descriptors() returns null rather than a molecular
 * weight that is quietly missing an atom. */
const WEIGHTS = {
  H: 1.008, He: 4.0026,
  Li: 6.94, Be: 9.0122, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Ne: 20.180,
  Na: 22.990, Mg: 24.305, Al: 26.982, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.948,
  K: 39.098, Ca: 40.078, Sc: 44.956, Ti: 47.867, V: 50.942, Cr: 51.996, Mn: 54.938,
  Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Ga: 69.723, Ge: 72.630,
  As: 74.922, Se: 78.971, Br: 79.904, Kr: 83.798,
  Rb: 85.468, Sr: 87.62, Y: 88.906, Zr: 91.224, Nb: 92.906, Mo: 95.95, Tc: 96.906,
  Ru: 101.07, Rh: 102.91, Pd: 106.42, Ag: 107.87, Cd: 112.41, In: 114.82, Sn: 118.71,
  Sb: 121.76, Te: 127.60, I: 126.904, Xe: 131.29,
  Cs: 132.91, Ba: 137.33, La: 138.91, Ce: 140.12, Pr: 140.91, Nd: 144.24, Pm: 144.913,
  Sm: 150.36, Eu: 151.96, Gd: 157.25, Tb: 158.93, Dy: 162.50, Ho: 164.93, Er: 167.26,
  Tm: 168.93, Yb: 173.05, Lu: 174.97, Hf: 178.49, Ta: 180.95, W: 183.84, Re: 186.21,
  Os: 190.23, Ir: 192.22, Pt: 195.08, Au: 196.97, Hg: 200.59, Tl: 204.38, Pb: 207.2,
  Bi: 208.98, Po: 208.982, At: 209.987, Rn: 222.018,
  Fr: 223.020, Ra: 226.025, Ac: 227.028, Th: 232.04, Pa: 231.04, U: 238.03,
  Np: 237.048, Pu: 244.064, Am: 243.061, Cm: 247.070
};

/* Elements this module treats as heteroatoms when typing carbon for cLogP. */
const CLOGP_HETERO = { N: 1, O: 1, P: 1, S: 1, F: 1, Cl: 1, Br: 1, I: 1 };

/* Work bounds. A work unit must be bounded work: past these sizes the ring
 * perception is skipped and declared aromaticity is used on its own. A
 * 900-bond molecule is not a drug candidate, and the fallback is honest
 * rather than slow. */
const MAX_PERCEPTION_BONDS = 900;
const MAX_RING_SIZE = 7;      /* rings larger than this are never aromatic here */

/* Two decimals / three decimals, by exactly specified integer rounding.
 *
 * The `r === 0 ? 0 : r` is not decoration: Math.round(-0.14)/100 is NEGATIVE
 * zero, so every value in (-0.005, 0] left here as -0. Nothing digests a
 * descriptor today and JSON.stringify prints -0 as 0, but Object.is(-0, 0) is
 * false and a Map keyed on the value would hold two entries for one number.
 * A trust model built on bit-identical answers does not get to ship two
 * spellings of zero. */
function round2(x) { const r = Math.round(x * 100) / 100; return r === 0 ? 0 : r; }
function round3(x) { const r = Math.round(x * 1000) / 1000; return r === 0 ? 0 : r; }

/* ————— graph views —————
 * Adjacency as arrays, never objects: iteration order is index order, which is
 * the same on every engine forever. Neighbour lists are sorted by neighbour
 * index so the breadth-first search below cannot depend on bond order either. */
function adjacency(mol) {
  const n = mol.atoms.length;
  const nbr = new Array(n);
  for (let i = 0; i < n; i++) nbr[i] = [];
  const bonds = mol.bonds;
  for (let k = 0; k < bonds.length; k++) {
    const b = bonds[k];
    if (!b) continue;
    const a = b.a, c = b.b;
    if (!Number.isInteger(a) || !Number.isInteger(c)) continue;
    if (a < 0 || c < 0 || a >= n || c >= n || a === c) continue;
    nbr[a].push({ j: c, k });
    nbr[c].push({ j: a, k });
  }
  for (let i = 0; i < n; i++) nbr[i].sort((x, y) => (x.j - y.j) || (x.k - y.k));
  return nbr;
}

/* The π-relevant order of a bond. An aromatic-flagged bond is treated as
 * carrying one π bond, which is what the Kekulé test below needs. */
function piOrder(bond) {
  if (!bond) return 1;
  if (bond.arom === true) return 2;
  const o = bond.order;
  return o === 2 || o === 3 ? o : 1;
}

/* ————— ring perception —————
 * For every bond that lies on a cycle, the smallest cycle through it. This is
 * the practical, deterministic stand-in for a smallest-set-of-smallest-rings:
 * the ring SET is famously not unique, but "the shortest cycle through this
 * bond, breaking ties by the first path a fixed-order breadth-first search
 * finds" is a definite answer that two engines will always agree on. Rings are
 * de-duplicated by their sorted atom list and returned in a fixed order
 * (size ascending, then key ascending) so nothing downstream can inherit an
 * insertion order. Only rings up to MAX_RING_SIZE are looked for — larger
 * cycles are never treated as aromatic here. */
function perceiveRings(mol, nbr) {
  const bonds = mol.bonds;
  const seen = new Map();
  if (bonds.length > MAX_PERCEPTION_BONDS) return [];
  const n = mol.atoms.length;
  const dist = new Int32Array(n);
  const prev = new Int32Array(n);

  for (let k = 0; k < bonds.length; k++) {
    const b = bonds[k];
    if (!b) continue;
    const a = b.a, c = b.b;
    if (!Number.isInteger(a) || !Number.isInteger(c)) continue;
    if (a < 0 || c < 0 || a >= n || c >= n || a === c) continue;
    if (nbr[a].length < 2 || nbr[c].length < 2) continue;   /* a bridge for sure */

    /* shortest path a -> c that does not use bond k */
    dist.fill(-1); prev.fill(-1);
    dist[a] = 0;
    let frontier = [a];
    let found = false;
    while (frontier.length && !found) {
      const next = [];
      for (let f = 0; f < frontier.length; f++) {
        const v = frontier[f];
        if (dist[v] >= MAX_RING_SIZE - 1) continue;
        const list = nbr[v];
        for (let t = 0; t < list.length; t++) {
          const e = list[t];
          if (e.k === k) continue;
          if (dist[e.j] !== -1) continue;
          dist[e.j] = dist[v] + 1;
          prev[e.j] = v;
          if (e.j === c) { found = true; break; }
          next.push(e.j);
        }
        if (found) break;
      }
      frontier = next;
    }
    if (!found) continue;

    const ring = [];
    let cur = c;
    let guard = 0;
    while (cur !== -1 && guard <= MAX_RING_SIZE) { ring.push(cur); cur = prev[cur]; guard++; }
    if (ring.length < 3 || ring.length > MAX_RING_SIZE) continue;
    const key = [...ring].sort((x, y) => x - y).join(",");
    if (!seen.has(key)) seen.set(key, ring);
  }

  const out = [];
  for (const [key, ring] of seen) out.push({ key, ring });
  out.sort((x, y) => (x.ring.length - y.ring.length) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return out.map((r) => r.ring);
}

/* Is this ring aromatic?
 *
 * Two ways to qualify, in order:
 *
 *   1. THE SMILES SAID SO. Every atom carries the aromatic flag the depositor
 *      wrote. Believed without argument — second-guessing a depositor's own
 *      notation is how two spellings of one molecule end up scoring
 *      differently.
 *
 *   2. A HÜCKEL COUNT ON THE KEKULÉ FORM. Every ring atom must contribute to
 *      one continuous π system: a π bond INSIDE the ring counts one electron;
 *      a neutral N, P, O, S or a carbanion with no π bond donates its lone
 *      pair, two. The ring is aromatic when the total is 4n+2.
 *
 *      Two refusals are deliberate and both cost real molecules:
 *        - an sp3 atom in the ring refuses it (correct: cyclopentadiene,
 *          dihydropyridines);
 *        - a ring atom whose only π bond points OUT of the ring refuses it.
 *          That is the strict "fully conjugated within the ring" reading. It
 *          correctly rejects quinones, cyclohexanones and the dione ring of
 *          the xanthines (caffeine's six-membered ring is NOT aromatic here,
 *          and its imidazole ring is — which is what reproduces caffeine's
 *          published TPSA). It also rejects tropone and the pyranones, which
 *          some models do call aromatic. That is a known, accepted miss:
 *          under-calling aromaticity moves a TPSA term by a couple of Å², and
 *          over-calling it would silently retype every carbonyl-bearing ring
 *          in the pool. */
function ringIsAromatic(mol, ring, nbr) {
  const atoms = mol.atoms;
  let declared = true;
  for (let i = 0; i < ring.length; i++) {
    const at = atoms[ring[i]];
    if (!at || at.arom !== true) { declared = false; break; }
  }
  if (declared) return true;

  const inRing = new Uint8Array(atoms.length);
  for (let i = 0; i < ring.length; i++) inRing[ring[i]] = 1;

  let electrons = 0;
  for (let i = 0; i < ring.length; i++) {
    const idx = ring[i];
    const at = atoms[idx];
    if (!at) return false;
    const el = at.el;
    if (el !== "C" && el !== "N" && el !== "O" && el !== "S" &&
        el !== "P" && el !== "Se" && el !== "As" && el !== "B") return false;

    let piIn = false, piOut = false, triple = false;
    const list = nbr[idx];
    for (let t = 0; t < list.length; t++) {
      const ord = piOrder(mol.bonds[list[t].k]);
      if (ord === 3) triple = true;
      if (ord === 2) { if (inRing[list[t].j]) piIn = true; else piOut = true; }
    }
    if (triple) return false;
    if (piIn) { electrons += 1; continue; }
    if (piOut) return false;
    if (el === "N" || el === "P" || el === "O" || el === "S" || el === "Se" || el === "As") {
      electrons += 2; continue;
    }
    if (el === "C" && at.charge === -1) { electrons += 2; continue; }
    return false;
  }
  return electrons >= 2 && ((electrons - 2) % 4) === 0;
}

/* aromaticAtoms(mol) -> { flags: Uint8Array, count: number }
 *
 * flags[i] is 1 when atom i is aromatic — either because the SMILES declared
 * it or because it sits in a ring this module perceived as aromatic. `count`
 * is the number of aromatic rings found. Exported because ./alerts.js has to
 * make the same call about the same ring (a Kekulé benzene must not read as a
 * pile of Michael acceptors), and two independent perceptions of aromaticity
 * in one engine is exactly the kind of drift that ends up in a digest. */
export function aromaticAtoms(mol) {
  const out = { flags: new Uint8Array(0), count: 0 };
  try {
    if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) return out;
    const atoms = mol.atoms;
    const flags = new Uint8Array(atoms.length);
    for (let i = 0; i < atoms.length; i++) if (atoms[i] && atoms[i].arom === true) flags[i] = 1;
    const nbr = adjacency(mol);
    const rings = perceiveRings(mol, nbr);
    let count = 0;
    for (let r = 0; r < rings.length; r++) {
      if (!ringIsAromatic(mol, rings[r], nbr)) continue;
      count++;
      for (let i = 0; i < rings[r].length; i++) flags[rings[r][i]] = 1;
    }
    return { flags, count };
  } catch (_e) {
    return out;
  }
}

/* perceivedRings(mol) -> Array<Array<number>>
 *
 * The ring set this module works from: the smallest cycle through every ring
 * bond, de-duplicated, in a fixed order (see perceiveRings). Exported so
 * ./alerts.js can ask about the same rings this module typed atoms against —
 * a second, subtly different ring perception in one engine is exactly the kind
 * of drift that ends up in a consensus digest. Never throws; a hostile or
 * oversized Mol comes back as an empty list. */
export function perceivedRings(mol) {
  try {
    if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) return [];
    return perceiveRings(mol, adjacency(mol));
  } catch (_e) {
    return [];
  }
}

/* Is atom i a member of some three-membered ring? Needed by the TPSA table,
 * which gives aziridine and epoxide their own fragment values. Cheap and
 * exact: two neighbours of i that are themselves bonded. */
function inThreeRing(nbr, i) {
  const list = nbr[i];
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const x = list[a].j, y = list[b].j;
      const lx = nbr[x];
      for (let t = 0; t < lx.length; t++) if (lx[t].j === y) return true;
    }
  }
  return false;
}

/* ————— TPSA: Ertl, Rohde & Selzer, J. Med. Chem. 43 (2000) 3714 —————
 *
 * Every constant is the published fragment contribution for the environment
 * written beside it, in Å². "*" is any atom; "-" single, "=" double, "#"
 * triple, ":" aromatic; a ring subscript means the fragment sits in a
 * three-membered ring. Nothing here is interpolated or averaged: an
 * environment the paper does not list contributes 0 and increments
 * `tpsaUnknown`, so a molecule full of exotic nitrogen reports an honest
 * under-count rather than a confident wrong number. */

/* nitrogen, neutral */
const N_3S      = 3.24;   /* [N](-*)(-*)-*      tertiary amine, amide N       */
const N_3S_RING = 3.01;   /* [N]1(-*)(-*)-*1    aziridine nitrogen            */
const N_1S1D    = 12.36;  /* [N](-*)=*          imine, C=N-                   */
const N_1T      = 23.79;  /* [N]#*              nitrile nitrogen              */
const N_1S2D    = 11.68;  /* [N](-*)(=*)=*      pentavalent nitro nitrogen    */
const N_1D1T    = 13.60;  /* [N](=*)#*                                        */
const NH_2S     = 12.03;  /* [NH](-*)-*         secondary amine, amide NH     */
const NH_2S_RNG = 21.94;  /* [NH]1(-*)-*1       aziridine NH                  */
const NH_1D     = 23.85;  /* [NH]=*             imine NH                      */
const NH2_1S    = 26.02;  /* [NH2]-*            primary amine                 */
/* nitrogen, cationic */
const NP_4S     = 0.00;   /* [N+](-*)(-*)(-*)-* quaternary ammonium           */
const NP_2S1D   = 3.01;   /* [N+](-*)(-*)=*     charge-separated nitro N      */
const NP_1S1T   = 4.36;   /* [N+](-*)#*         nitrilium                     */
const NHP_3S    = 4.44;   /* [NH+](-*)(-*)-*                                  */
const NHP_1S1D  = 13.97;  /* [NH+](-*)=*                                      */
const NH2P_2S   = 16.61;  /* [NH2+](-*)-*                                     */
const NH2P_1D   = 25.59;  /* [NH2+]=*                                         */
const NH3P_1S   = 27.64;  /* [NH3+]-*                                         */
/* nitrogen, aromatic */
const n_2A      = 12.89;  /* [n](:*):*          pyridine-type n               */
const n_1S2A    = 4.41;   /* [n](-*)(:*):*      N-substituted pyrrole-type n  */
const n_1D2A    = 4.93;   /* [n](=*)(:*):*      n with an exocyclic π bond    */
const nH_2A     = 15.79;  /* [nH](:*):*         pyrrole NH                    */
const nP_1S2A   = 4.10;   /* [n+](-*)(:*):*     N-alkyl pyridinium            */
const nHP_2A    = 14.14;  /* [nH+](:*):*        protonated pyridine           */
/* oxygen */
const O_2S      = 9.23;   /* [O](-*)-*          ether, ester -O-              */
const O_2S_RING = 12.53;  /* [O]1(-*)-*1        epoxide                       */
const O_1D      = 17.07;  /* [O]=*              carbonyl, nitro, sulfonyl O   */
const OH_1S     = 20.23;  /* [OH]-*             hydroxyl, carboxylic acid OH  */
const OM_1S     = 23.06;  /* [O-]-*             alkoxide, carboxylate O       */
const o_2A      = 13.14;  /* [o](:*):*          furan-type o                  */
/* sulfur */
const S_2S      = 25.30;  /* [S](-*)-*          thioether                     */
const S_1D      = 32.09;  /* [S]=*              thione                        */
const S_2S1D    = 19.21;  /* [S](-*)(-*)=*      sulfoxide                     */
const S_2S2D    = 8.38;   /* [S](-*)(-*)(=*)=*  sulfone, sulfonamide, sulfonic*/
const SH_1S     = 38.80;  /* [SH]-*             thiol                         */
const s_2A      = 28.24;  /* [s](:*):*          thiophene-type s              */
const s_1D2A    = 21.70;  /* [s](=*)(:*):*                                    */
/* phosphorus */
const P_3S      = 13.59;  /* [P](-*)(-*)-*      phosphine                     */
const P_1S1D    = 34.14;  /* [P](-*)=*                                        */
const P_3S1D    = 9.81;   /* [P](-*)(-*)(-*)=*  phosphate, phosphonate        */
const PH_2S1D   = 23.47;  /* [PH](-*)(-*)=*                                   */

/* The polar-surface contribution of one atom, or -1 for "not in the table". */
function tpsaAtom(at, prof, arom, ring3) {
  const el = at.el;
  const h = prof.h, q = at.charge | 0;
  const s = prof.single, d = prof.double, t = prof.triple;

  if (el === "N") {
    if (arom) {
      if (q === 0) {
        if (h >= 1) return nH_2A;
        if (prof.exoDouble) return n_1D2A;
        if (prof.heavy >= 3) return n_1S2A;
        return n_2A;
      }
      if (q > 0) {
        if (h >= 1) return nHP_2A;
        if (prof.heavy >= 3) return nP_1S2A;
        return -1;
      }
      return -1;
    }
    if (q === 0) {
      if (h === 0) {
        if (t === 1 && d === 0) return N_1T;
        if (d === 2 && s === 1) return N_1S2D;
        if (d === 1 && t === 1) return N_1D1T;
        if (d === 1 && s === 1) return N_1S1D;
        if (d === 0 && t === 0 && s === 3) return ring3 ? N_3S_RING : N_3S;
        return -1;
      }
      if (h === 1) {
        if (d === 1 && s === 0 && t === 0) return NH_1D;
        if (d === 0 && t === 0 && s === 2) return ring3 ? NH_2S_RNG : NH_2S;
        return -1;
      }
      if (h === 2 && d === 0 && t === 0 && s === 1) return NH2_1S;
      return -1;
    }
    if (q > 0) {
      if (h === 0) {
        if (s === 4 && d === 0 && t === 0) return NP_4S;
        if (s === 2 && d === 1 && t === 0) return NP_2S1D;
        if (s === 1 && t === 1 && d === 0) return NP_1S1T;
        return -1;
      }
      if (h === 1) {
        if (s === 3 && d === 0 && t === 0) return NHP_3S;
        if (s === 1 && d === 1 && t === 0) return NHP_1S1D;
        return -1;
      }
      if (h === 2) {
        if (s === 2 && d === 0 && t === 0) return NH2P_2S;
        if (s === 0 && d === 1 && t === 0) return NH2P_1D;
        return -1;
      }
      if (h === 3 && s === 1 && d === 0 && t === 0) return NH3P_1S;
      return -1;
    }
    return -1;
  }

  if (el === "O") {
    if (arom) return q === 0 ? o_2A : -1;
    if (q === 0) {
      if (h === 0) {
        if (d === 1 && s === 0 && t === 0) return O_1D;
        if (d === 0 && t === 0 && s === 2) return ring3 ? O_2S_RING : O_2S;
        return -1;
      }
      if (h === 1 && s === 1 && d === 0 && t === 0) return OH_1S;
      return -1;
    }
    if (q === -1 && h === 0 && s === 1 && d === 0 && t === 0) return OM_1S;
    return -1;
  }

  if (el === "S") {
    if (arom) {
      if (q !== 0) return -1;
      return prof.exoDouble ? s_1D2A : s_2A;
    }
    if (q !== 0) return -1;
    if (h === 0) {
      if (s === 2 && d === 2) return S_2S2D;
      if (s === 2 && d === 1) return S_2S1D;
      if (s === 2 && d === 0 && t === 0) return S_2S;
      if (s === 0 && d === 1 && t === 0) return S_1D;
      return -1;
    }
    if (h === 1 && s === 1 && d === 0 && t === 0) return SH_1S;
    return -1;
  }

  if (el === "P") {
    if (arom || q !== 0) return -1;
    if (h === 0) {
      if (s === 3 && d === 1) return P_3S1D;
      if (s === 3 && d === 0 && t === 0) return P_3S;
      if (s === 1 && d === 1 && t === 0) return P_1S1D;
      return -1;
    }
    if (h === 1 && s === 2 && d === 1) return PH_2S1D;
    return -1;
  }

  return 0;   /* every other element is non-polar in this model: 0, not unknown */
}

/* ————— cLogP: Wildman & Crippen, J. Chem. Inf. Comput. Sci. 39 (1999) 868 —
 *
 * A SUBSET, honestly (see the header). Values are the published per-atom-type
 * contributions; the classifier below is hand-written rather than SMARTS. The
 * type label in each comment is the paper's own (C1, N7, O4 …) so a reviewer
 * can look the constant up. Where this module cannot decide a type it uses the
 * element's published class default (CS, NS, OS), which is exactly what the
 * paper prescribes for an unmatched atom. */
const CRIPPEN = {
  /* carbon */
  C1: 0.1441,    /* [CH3]C, [CH2](C)C — primary/secondary aliphatic, C only    */
  C2: 0.0000,    /* [CH](C)(C)C, [C](C)(C)(C)C — tertiary/quaternary aliphatic */
  C3: -0.2035,   /* [CH3]X, [CH2](X)… — primary/secondary bonded to hetero     */
  C4: -0.2051,   /* [CH](X)…, [C](X)… — tertiary/quaternary bonded to hetero   */
  C5: -0.2783,   /* [C]=[hetero] — carbonyl, thiocarbonyl, imine carbon        */
  C6: 0.1551,    /* [CH]=[CH], [C]=[C] — olefinic carbon                       */
  C7: 0.0017,    /* [C]#[C], [C]#N — acetylenic / nitrile carbon               */
  C8: 0.08452,   /* [CH3]c — methyl on aromatic carbon                         */
  C9: -0.1444,   /* [CH3]a — methyl on an aromatic heteroatom                  */
  C18: 0.1581,   /* [cH] — aromatic CH                                         */
  C19: 0.2955,   /* c fused between two aromatic rings (bridgehead)            */
  C20: 0.2713,   /* c bonded to another aromatic ring (biphenyl link)          */
  C21: 0.1360,   /* c-C — aromatic carbon bearing an aliphatic carbon          */
  C22: 0.4619,   /* c-N — aromatic carbon bearing nitrogen                     */
  C23: 0.5437,   /* c-O — aromatic carbon bearing oxygen                       */
  C24: 0.1893,   /* c-S — aromatic carbon bearing sulfur                       */
  C26: 0.2640,   /* C=C conjugated to an aromatic ring (styrene-type)          */
  CS: 0.08129,   /* class default for an unmatched carbon                      */
  /* hydrogen */
  H1: 0.1230,    /* H on carbon or on any non-polar atom                       */
  H2: -0.2677,   /* H on an alcohol or phenol oxygen                           */
  H3: 0.2142,    /* H on nitrogen                                              */
  H4: 0.2980,    /* acidic H — carboxyl O-H, S-H                               */
  HS: 0.1125,    /* class default for an unmatched hydrogen                    */
  /* nitrogen */
  N1: -1.0190,   /* primary aliphatic amine                                    */
  N2: -0.7096,   /* secondary aliphatic amine                                  */
  N3: -1.0270,   /* primary aromatic amine (NH2 on a ring)                     */
  N4: -0.5188,   /* secondary aromatic amine / amide N on a ring               */
  N5: 0.08387,   /* [NH]=C — imine NH                                          */
  N6: 0.1836,    /* [N]=C — substituted imine                                  */
  N7: -0.3187,   /* tertiary aliphatic amine                                   */
  N8: -0.4458,   /* tertiary aromatic amine                                    */
  N9: 0.01508,   /* nitrile nitrogen                                           */
  N10: -1.9500,  /* protonated amine                                           */
  N11: -0.3239,  /* unprotonated aromatic n                                    */
  N12: -1.1190,  /* protonated aromatic n                                      */
  N13: -0.3396,  /* quaternary ammonium nitrogen                               */
  N14: 0.2887,   /* other nitrogen — nitro, azide, N-oxide                     */
  NS: -0.4806,   /* class default for an unmatched nitrogen                    */
  /* oxygen */
  O1: 0.1552,    /* aromatic o                                                 */
  O2: -0.2893,   /* alcohol / phenol oxygen                                    */
  O3: -0.0684,   /* aliphatic ether oxygen                                     */
  O4: 0.4166,    /* oxygen bridging an aliphatic and an aromatic atom          */
  O5: -0.2783,   /* oxide oxygen — N-oxide, nitro, sulfonyl                    */
  O11: -0.1858,  /* carbonyl oxygen of an ester, amide or carboxylic acid      */
  O9: -0.1526,   /* carbonyl oxygen of an aldehyde or ketone                   */
  O12: -0.3339,  /* carboxylic-acid hydroxyl oxygen                            */
  OS: -0.1188,   /* class default for an unmatched oxygen                      */
  /* the rest */
  F: 0.4202, Cl: 0.6895, Br: 0.8456, I: 0.8857,
  S1: 0.6482,    /* thiol / thioether sulfur                                   */
  S2: -0.0024,   /* thiolate                                                   */
  S3: 0.6237,    /* sulfoxide / sulfone / aromatic sulfur                      */
  P: 0.8612,
  ME: -0.3808    /* metals and everything else                                 */
};

/* Is bond k, joining atoms i and j, an AROMATIC RING bond?
 *
 * A bond can be aromatic in fact and carry no flag of its own: the parser
 * READS aromaticity rather than perceiving it, so a Kekulé benzene whose ring
 * this module has just perceived has six aromatic atoms and not one aromatic
 * bond. The honest test is therefore "the bond says so, or both of its atoms
 * are aromatic AND the bond lies on a ring" — and the ring clause is the whole
 * point: it is what keeps the biphenyl link, whose two atoms are both
 * aromatic, a SUBSTITUENT bond rather than a ring bond. */
function isAromaticRingBond(mol, k, i, j, aromFlags, ringBond) {
  const b = mol.bonds[k];
  if (!b) return false;
  if (b.arom === true) return true;
  return aromFlags[i] === 1 && aromFlags[j] === 1 && ringBond[k] === 1;
}

/* One atom's cLogP contribution, hydrogens included. `prof` is its bond
 * profile, `arom` this module's perceived aromaticity. */
function crippenAtom(mol, i, nbr, prof, aromFlags, ringBond) {
  const at = mol.atoms[i];
  const el = at.el;
  const arom = aromFlags[i] === 1;
  const h = prof.h;
  let v = 0;

  /* — hydrogens, typed by what they hang off — */
  let hType = CRIPPEN.H1;
  if (el === "O") hType = prof.acidOH ? CRIPPEN.H4 : CRIPPEN.H2;
  else if (el === "N") hType = CRIPPEN.H3;
  else if (el === "S") hType = CRIPPEN.H4;
  else if (el !== "C" && el !== "B" && el !== "Si") hType = CRIPPEN.HS;
  v += h * hType;

  if (el === "C") {
    if (arom) {
      if (h >= 1) return v + CRIPPEN.C18;

      /* A SUBSTITUTED AROMATIC CARBON IS TYPED BY ITS BONDS, NEVER BY ITS
       * NEIGHBOURING ATOMS. Wildman & Crippen define these types as a carbon
       * with two aromatic bonds plus one more connection, and it is that third
       * connection — reached over a bond which is NOT an aromatic ring bond —
       * that names the type:
       *
       *   C19  [c](:a)(:a):a    three aromatic ring bonds — a fusion bridgehead
       *   C20  [c](:a)(:a)-a    substituent is itself aromatic — the biaryl link
       *   C21  [c](:a)(:a)-C    an aliphatic carbon
       *   C22  [c](:a)(:a)-N    nitrogen
       *   C23  [c](:a)(:a)-O    oxygen
       *   C24  [c](:a)(:a)-S    sulfur
       *
       * Keying on ATOMS instead had two failures, both reproduced. A ring
       * heteroatom two positions round the ring is not this carbon's
       * substituent, but it was read as one, and whichever of the ring
       * neighbour and the real substituent carried the lower atom index won —
       * so 2-methylpyridine typed C22 or C21 depending purely on how its SMILES
       * was written (cLogP 1.72 vs 1.39 for one molecule). And a biaryl ipso
       * carbon has three aromatic NEIGHBOURS but only two aromatic BONDS, so
       * every biaryl link was typed C19, the ring-fusion bridgehead, leaving
       * C20 unreachable. Descriptors that change with the spelling are the one
       * thing this engine exists to prevent. */
      let sub = null, aromNbrs = 0;
      const list = nbr[i];
      for (let t = 0; t < list.length; t++) {
        const e = list[t];
        if (isAromaticRingBond(mol, e.k, i, e.j, aromFlags, ringBond)) { aromNbrs++; continue; }
        const other = mol.atoms[e.j];
        if (!other || typeof other.el !== "string") continue;
        if (sub === null) sub = aromFlags[e.j] === 1 ? "a" : other.el;
      }
      if (aromNbrs >= 3) return v + CRIPPEN.C19;
      if (sub === null) return v + CRIPPEN.CS;
      if (sub === "a") return v + CRIPPEN.C20;
      if (sub === "N") return v + CRIPPEN.C22;
      if (sub === "O") return v + CRIPPEN.C23;
      if (sub === "S") return v + CRIPPEN.C24;
      if (sub === "C") return v + CRIPPEN.C21;
      return v + CRIPPEN.CS;
    }
    if (prof.triple > 0) return v + CRIPPEN.C7;
    if (prof.doubleHetero > 0) return v + CRIPPEN.C5;
    if (prof.double > 0) return v + (prof.nextToAromatic ? CRIPPEN.C26 : CRIPPEN.C6);
    if (h === 3 && prof.aromaticCarbonNbr) return v + CRIPPEN.C8;
    if (h === 3 && prof.aromaticHeteroNbr) return v + CRIPPEN.C9;
    if (h >= 2) return v + (prof.hetero > 0 ? CRIPPEN.C3 : CRIPPEN.C1);
    return v + (prof.hetero > 0 ? CRIPPEN.C4 : CRIPPEN.C2);
  }

  if (el === "N") {
    if (arom) return v + (at.charge > 0 ? CRIPPEN.N12 : CRIPPEN.N11);
    if (prof.oxygenNbrs >= 2 && (prof.double > 0 || at.charge > 0)) return v + CRIPPEN.N14;
    if (at.charge > 0) return v + (prof.heavy === 4 && h === 0 ? CRIPPEN.N13 : CRIPPEN.N10);
    if (prof.triple > 0) return v + CRIPPEN.N9;
    if (prof.double > 0) return v + (h > 0 ? CRIPPEN.N5 : CRIPPEN.N6);
    if (h === 2) return v + (prof.nextToAromatic ? CRIPPEN.N3 : CRIPPEN.N1);
    if (h === 1) return v + (prof.nextToAromatic ? CRIPPEN.N4 : CRIPPEN.N2);
    if (h === 0) return v + (prof.nextToAromatic ? CRIPPEN.N8 : CRIPPEN.N7);
    return v + CRIPPEN.NS;
  }

  if (el === "O") {
    if (arom) return v + CRIPPEN.O1;
    if (at.charge < 0) return v + (prof.hetero > 0 ? CRIPPEN.O5 : CRIPPEN.O12);
    if (prof.double > 0) {
      if (prof.onHetero) return v + CRIPPEN.O5;
      return v + (prof.carbonylHasHetero ? CRIPPEN.O11 : CRIPPEN.O9);
    }
    if (h >= 1) return v + (prof.acidOH ? CRIPPEN.O12 : CRIPPEN.O2);
    if (prof.heavy === 2) return v + (prof.nextToAromatic ? CRIPPEN.O4 : CRIPPEN.O3);
    return v + CRIPPEN.OS;
  }

  if (el === "F") return v + CRIPPEN.F;
  if (el === "Cl") return v + CRIPPEN.Cl;
  if (el === "Br") return v + CRIPPEN.Br;
  if (el === "I") return v + CRIPPEN.I;
  if (el === "S") {
    if (at.charge < 0) return v + CRIPPEN.S2;
    if (prof.double > 0 || arom) return v + CRIPPEN.S3;
    return v + CRIPPEN.S1;
  }
  if (el === "P") return v + CRIPPEN.P;
  if (el === "H") return v + CRIPPEN.H1;
  return v + CRIPPEN.ME;
}

/* ————— per-atom bond profile —————
 * Everything the two scoring models need about one atom's surroundings, read
 * once, in index order. */
function profile(mol, i, nbr, aromFlags) {
  const at = mol.atoms[i];
  const list = nbr[i];
  const p = {
    h: Number.isInteger(at.hcount) && at.hcount > 0 ? at.hcount : 0,
    single: 0, double: 0, triple: 0, aromatic: 0, heavy: 0,
    hetero: 0, oxygenNbrs: 0, doubleHetero: 0,
    exoDouble: false, nextToAromatic: false,
    aromaticCarbonNbr: false, aromaticHeteroNbr: false,
    onHetero: false, carbonylHasHetero: false, acidOH: false
  };
  for (let t = 0; t < list.length; t++) {
    const e = list[t];
    const other = mol.atoms[e.j];
    if (!other) continue;
    if (other.el === "H") { p.h++; continue; }
    p.heavy++;
    const bond = mol.bonds[e.k];
    const isArom = bond && bond.arom === true;
    const ord = bond ? (ord2(bond)) : 1;
    if (isArom) p.aromatic++;
    if (ord === 3) p.triple++;
    else if (ord === 2) {
      p.double++;
      /* an exocyclic π bond, from the point of view of an aromatic atom:
       * a double bond leading OUT of the aromatic system */
      if (aromFlags[i] === 1 && aromFlags[e.j] !== 1) p.exoDouble = true;
      if (Object.prototype.hasOwnProperty.call(CLOGP_HETERO, other.el)) p.doubleHetero++;
    } else p.single++;
    if (Object.prototype.hasOwnProperty.call(CLOGP_HETERO, other.el)) p.hetero++;
    if (other.el === "O") p.oxygenNbrs++;
    if (aromFlags[e.j] === 1) {
      p.nextToAromatic = true;
      if (other.el === "C") p.aromaticCarbonNbr = true; else p.aromaticHeteroNbr = true;
    }
    if (other.el !== "C") p.onHetero = p.onHetero || (at.el === "O" && ord === 2);
  }
  /* oxygen bookkeeping the carbonyl/acid types need */
  if (at.el === "O") {
    for (let t = 0; t < list.length; t++) {
      const e = list[t];
      const c = mol.atoms[e.j];
      if (!c || c.el !== "C") continue;
      const bond = mol.bonds[e.k];
      const ord = bond ? ord2(bond) : 1;
      const cl = nbr[e.j];
      let cHasDoubleO = false, cHasOtherHetero = false;
      for (let u = 0; u < cl.length; u++) {
        if (cl[u].j === i) continue;
        const nn = mol.atoms[cl[u].j];
        if (!nn) continue;
        const bb = mol.bonds[cl[u].k];
        if (nn.el === "O" && bb && ord2(bb) === 2) cHasDoubleO = true;
        if (nn.el === "O" || nn.el === "N" || nn.el === "S") cHasOtherHetero = true;
      }
      if (ord === 2 && cHasOtherHetero) p.carbonylHasHetero = true;
      if (ord === 1 && p.h >= 1 && cHasDoubleO) p.acidOH = true;
    }
  }
  return p;
}

function ord2(bond) {
  if (bond.arom === true) return 1;   /* an aromatic bond is one σ for counting */
  const o = bond.order;
  return o === 2 || o === 3 ? o : 1;
}

/* ————— rotatable bonds —————
 * An acyclic single bond between two heavy atoms that each carry more than one
 * heavy neighbour — the standard Veber definition — minus amide C–N bonds,
 * which do not rotate freely. Terminal groups (a methyl, a hydroxyl) are
 * excluded by the degree test, and a bond inside a ring is excluded because a
 * ring cannot rotate about one of its own bonds. */
function rotatableBonds(mol, nbr, ringBond) {
  const bonds = mol.bonds;
  let count = 0;
  for (let k = 0; k < bonds.length; k++) {
    const b = bonds[k];
    if (!b) continue;
    const a = b.a, c = b.b;
    if (!Number.isInteger(a) || !Number.isInteger(c)) continue;
    if (a === c || a < 0 || c < 0 || a >= mol.atoms.length || c >= mol.atoms.length) continue;
    if (ord2(b) !== 1 || b.arom === true) continue;
    if (ringBond[k] === 1) continue;
    if (mol.atoms[a].el === "H" || mol.atoms[c].el === "H") continue;
    if (heavyDegree(mol, nbr, a) < 2 || heavyDegree(mol, nbr, c) < 2) continue;
    if (isAmideBond(mol, nbr, a, c) || isAmideBond(mol, nbr, c, a)) continue;
    count++;
  }
  return count;
}

function heavyDegree(mol, nbr, i) {
  const list = nbr[i];
  let d = 0;
  for (let t = 0; t < list.length; t++) if (mol.atoms[list[t].j] && mol.atoms[list[t].j].el !== "H") d++;
  return d;
}

/* a is the carbon of an amide C(=O)-N and b is that nitrogen */
function isAmideBond(mol, nbr, a, b) {
  if (mol.atoms[a].el !== "C" || mol.atoms[b].el !== "N") return false;
  const list = nbr[a];
  for (let t = 0; t < list.length; t++) {
    const e = list[t];
    const o = mol.atoms[e.j];
    const bond = mol.bonds[e.k];
    if (o && (o.el === "O" || o.el === "S") && bond && ord2(bond) === 2) return true;
  }
  return false;
}

/* ————— the public function ————— */
export function descriptors(mol) {
  try {
    return describe(mol);
  } catch (_e) {
    /* Defence in depth. Every path below is written to return null rather than
     * throw; if one is ever missed, a volunteer's screening run must still
     * survive the molecule that found it. */
    return null;
  }
}

function describe(mol) {
  if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) return null;
  const atoms = mol.atoms;
  const n = atoms.length;
  if (n === 0) return null;

  for (let i = 0; i < n; i++) {
    const at = atoms[i];
    if (!at || typeof at.el !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(WEIGHTS, at.el)) return null;
  }

  const nbr = adjacency(mol);
  const { flags: aromFlags, count: perceivedAromRings } = aromaticAtoms(mol);
  const ri = ringInfo(mol);

  /* WHICH BONDS LIE ON A RING.
   *
   * The parser answers this exactly, with a bridge scan (smiles.js applyRings):
   * a bond is a ring bond precisely when it is not a bridge. Believe that flag
   * in BOTH directions.
   *
   * Inferring it from the endpoints instead is wrong in one common, important
   * case: in a biaryl — biphenyl, losartan, celecoxib, half the kinase
   * inhibitors ever made — both ends of the connecting bond are ring atoms
   * while the bond itself lies on no cycle. Reading `false` as "ask the
   * endpoints" therefore marked every ring-to-ring single bond as a ring bond,
   * which silently dropped it from `rotb` (biphenyl reported 0 rotatable
   * bonds, sildenafil 6 instead of 7) and mistyped the ipso carbon for cLogP.
   * `rotb` feeds Veber's flexibility flag in score.js, so the molecules that
   * escaped it were exactly the floppy biaryl-rich ones the flag is for.
   *
   * The endpoint test survives only as the fallback for a hand-built Mol that
   * carries no ring flags at all, and it may never overrule a computed false. */
  const ringBond = new Uint8Array(mol.bonds.length);
  for (let k = 0; k < mol.bonds.length; k++) {
    const b = mol.bonds[k];
    if (!b) continue;
    if (typeof b.ring === "boolean") { ringBond[k] = b.ring ? 1 : 0; continue; }
    if (ri.ringAtoms.has(b.a) && ri.ringAtoms.has(b.b)) ringBond[k] = 1;
  }

  /* — composition — */
  let mwSum = 0, hTotal = 0, heavy = 0, charge = 0;
  let hbd = 0, hba = 0;
  let carbons = 0, sp3Carbons = 0;
  let tpsa = 0, tpsaUnknown = 0;
  let clogp = 0;

  const profs = new Array(n);
  for (let i = 0; i < n; i++) profs[i] = profile(mol, i, nbr, aromFlags);

  for (let i = 0; i < n; i++) {
    const at = atoms[i];
    const p = profs[i];
    const w = WEIGHTS[at.el];
    mwSum += w;
    const hc = Number.isInteger(at.hcount) && at.hcount > 0 ? at.hcount : 0;
    hTotal += hc;
    if (at.el !== "H") heavy++;
    charge += Number.isInteger(at.charge) ? at.charge : 0;

    if (at.el === "N" || at.el === "O") {
      hba++;
      if (hc >= 1) hbd++;
    }

    if (at.el === "C") {
      carbons++;
      let sp3 = aromFlags[i] !== 1;
      if (sp3) {
        const list = nbr[i];
        for (let t = 0; t < list.length; t++) {
          const b = mol.bonds[list[t].k];
          if (b && (b.arom === true || b.order === 2 || b.order === 3)) { sp3 = false; break; }
        }
      }
      if (sp3) sp3Carbons++;
    }

    const contrib = tpsaAtom(at, p, aromFlags[i] === 1, inThreeRing(nbr, i));
    if (contrib < 0) tpsaUnknown++;
    else tpsa += contrib;

    clogp += crippenAtom(mol, i, nbr, p, aromFlags, ringBond);
  }

  /* implicit + explicit hydrogens both count toward the average mass */
  mwSum += hTotal * WEIGHTS.H;

  const rings = ri.rings > 0 ? ri.rings : 0;
  let aromRings = perceivedAromRings > ri.aromaticRings ? perceivedAromRings : ri.aromaticRings;
  if (aromRings > rings) aromRings = rings;
  if (aromRings < 0) aromRings = 0;

  const out = {
    mw: round2(mwSum),
    heavy,
    hbd,
    hba,
    rotb: rotatableBonds(mol, nbr, ringBond),
    rings,
    aromRings,
    tpsa: round2(tpsa),
    clogp: round2(clogp),
    charge,
    fsp3: carbons === 0 ? 0 : round3(sp3Carbons / carbons)
  };

  /* `tpsaUnknown` is DEBUG ONLY: how many atoms sat in an environment the Ertl
   * table does not list and therefore contributed nothing to tpsa, so a
   * non-zero value means the printed TPSA is an honest UNDER-count rather than
   * a wrong count. Nothing in the screen reads it.
   *
   * It is attached NON-ENUMERABLY on purpose. The shared interface contract
   * says descriptors() returns exactly the eleven keys above, and every
   * consumer is written against that: it must survive Object.keys, a
   * JSON.stringify round trip and any "every value is finite" sweep unchanged.
   * A twelfth enumerable key quietly broke that promise; hiding the diagnostic
   * from enumeration keeps both — the contract for callers, the number for
   * whoever is debugging a polar-surface figure. It is still a plain finite
   * integer, still readable as `d.tpsaUnknown`. */
  Object.defineProperty(out, "tpsaUnknown", {
    value: tpsaUnknown, enumerable: false, writable: false, configurable: false
  });

  /* Nothing may leave here as NaN or Infinity — a NaN score silently sorts to
   * the bottom of a hit list and nobody ever notices it was a bug. */
  const keys = ["mw", "heavy", "hbd", "hba", "rotb", "rings", "aromRings",
                "tpsa", "clogp", "charge", "fsp3", "tpsaUnknown"];
  for (let i = 0; i < keys.length; i++) {
    const v = out[keys[i]];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
  }
  return out;
}
