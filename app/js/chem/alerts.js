/* alerts — structural alerts, by direct inspection of the molecular graph.
 *
 * ————— WHAT AN ALERT IS, AND WHAT IT IS NOT —————
 *
 * Every id this module returns is a TRIAGE FLAG: "this molecule contains a
 * substructure that, in the medicinal-chemistry literature, is a common reason
 * a screening hit turns out to be uninteresting". Reactive groups react with
 * whatever is in the well; some scaffolds interfere with assay readouts;
 * others are simply hard to develop. Flagging one is a note for a human
 * reading a shortlist, and nothing else.
 *
 * An alert is NOT a verdict. It does not say a molecule is unsafe, does not
 * say it is a poison, does not say it will fail, and must never be rendered in
 * the UI as though it did. Half the flags below appear in shipped medicines —
 * aspirin's chemistry is an acyl transfer, cisplatin is a metal complex,
 * cyclophosphamide is an alkylating agent, and every one of them was worth
 * developing. A flagged molecule is a molecule with a QUESTION attached, and
 * the question is for a researcher, not for this program.
 *
 * There is no SMARTS engine here on purpose: the whole chemistry stack in this
 * app is dependency-free and must be reproducible bit for bit on every
 * volunteer's browser, so each pattern is a small hand-written walk over the
 * graph ./smiles.js built. Consequences, enforced by construction:
 *   - no Math.random, no clock, no locale, no transcendental math;
 *   - the returned array is de-duplicated and sorted with a code-unit
 *     comparator, never localeCompare — the ids ride into the consensus
 *     digest, so their ORDER is part of the trust model;
 *   - nothing throws. A malformed or hand-built Mol returns [].
 *
 * Aromaticity is taken from ./descriptors.js, not re-derived here. The parser
 * READS aromaticity rather than perceiving it, so most of PubChem arrives in
 * Kekulé form; without a shared perception a plain benzene ring would read as
 * three Michael acceptors and every second molecule in the pool would be
 * flagged for nothing.
 */

import { aromaticAtoms, perceivedRings } from "./descriptors.js";

/* ————— the catalogue —————
 * Each `why` is one sentence, written for someone who has never taken a
 * chemistry class, and phrased as a REASON TO LOOK rather than a judgement. */
export const ALERTS = [
  { id: "acyl_halide", name: "Acyl halide",
    why: "A very reactive group that tends to fall apart in water, so it rarely survives long enough to be tested as a drug." },
  { id: "aldehyde", name: "Aldehyde",
    why: "Aldehydes stick to proteins fairly indiscriminately, which is a common reason a screening hit looks active against everything." },
  { id: "alkyl_halide_triad", name: "Polyhalogenated carbon",
    why: "A single carbon carrying three or more halogen atoms, a group that often behaves very differently from the rest of the molecule." },
  { id: "aromatic_nitro", name: "Nitro group on an aromatic ring",
    why: "Nitro groups attached to a ring are broken down by the body in ways that frequently cause problems later in development." },
  { id: "azide", name: "Azide",
    why: "A chain of three nitrogens that stores a lot of energy and is usually a laboratory reagent rather than a candidate medicine." },
  { id: "epoxide", name: "Epoxide",
    why: "A strained three-membered ring containing oxygen that pops open easily and reacts with things it meets." },
  { id: "hydrazine", name: "Hydrazine or hydrazone",
    why: "Two nitrogens bonded directly to each other, a group that is chemically unstable and awkward to develop." },
  { id: "isocyanate", name: "Isocyanate or isothiocyanate",
    why: "A highly reactive group that bonds to proteins on contact, so any activity it shows is usually not selective." },
  { id: "long_alkyl_chain", name: "Long greasy chain",
    why: "More than twelve carbons in a row makes a molecule behave like a detergent, which can disrupt cells non-specifically." },
  { id: "michael_acceptor", name: "Michael acceptor",
    why: "A double bond sitting next to a carbonyl group, an arrangement that reacts permanently with proteins rather than binding reversibly." },
  { id: "n_oxide", name: "N-oxide",
    why: "An oxygen attached directly to a nitrogen, which changes how the molecule is absorbed and is often unstable in storage." },
  { id: "nitro", name: "Nitro group",
    why: "A nitrogen carrying two oxygens; the group is often reduced inside the body into something quite different from what was tested." },
  { id: "nitroso", name: "Nitroso group",
    why: "A nitrogen double-bonded to a single oxygen, a group closely related to compounds regulators watch carefully." },
  { id: "peroxide", name: "Peroxide",
    why: "Two oxygens bonded to each other, a weak link that breaks apart readily and releases reactive fragments." },
  { id: "phosphonic_ester", name: "Phosphonate or phosphate ester",
    why: "A phosphorus-oxygen ester, the shape shared by a large family of enzyme-blocking reagents used in pesticides." },
  { id: "quinone", name: "Quinone",
    why: "A ring carrying two facing carbonyl groups that cycles electrons, which makes such molecules score well in many assays for reasons unrelated to the target." },
  { id: "sulfonyl_halide", name: "Sulfonyl halide",
    why: "A sulfur-based reactive group used in the lab to label proteins on purpose, so it will label them here too." },
  { id: "thiol", name: "Free thiol",
    why: "A sulfur-hydrogen group that oxidises in air and forms bonds with proteins, which often shows up as false activity." }
];

const HALOGEN = { F: 1, Cl: 1, Br: 1, I: 1 };

/* Bond order for counting. An aromatic-flagged bond is one σ bond here — the
 * π system is handled through the aromatic flags, never through orders. */
function order(bond) {
  if (!bond) return 1;
  if (bond.arom === true) return 1;
  const o = bond.order;
  return o === 2 || o === 3 ? o : 1;
}

/* Adjacency as arrays, sorted by neighbour index: iteration order is index
 * order, on every engine, forever. */
function adjacency(mol) {
  const n = mol.atoms.length;
  const nbr = new Array(n);
  for (let i = 0; i < n; i++) nbr[i] = [];
  for (let k = 0; k < mol.bonds.length; k++) {
    const b = mol.bonds[k];
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

function el(mol, i) { const a = mol.atoms[i]; return a && typeof a.el === "string" ? a.el : ""; }
function hcount(mol, i) {
  const a = mol.atoms[i];
  return a && Number.isInteger(a.hcount) && a.hcount > 0 ? a.hcount : 0;
}
function charge(mol, i) {
  const a = mol.atoms[i];
  return a && Number.isInteger(a.charge) ? a.charge : 0;
}
function heavyDegree(mol, nbr, i) {
  let d = 0;
  for (let t = 0; t < nbr[i].length; t++) if (el(mol, nbr[i][t].j) !== "H") d++;
  return d;
}

/* Is this bond an aromatic RING bond, given the shared perception's verdict on
 * its two atoms?
 *
 * A bond can be aromatic in fact and carry no flag of its own — the parser
 * reads aromaticity rather than perceiving it, so a Kekulé ring that
 * aromaticAtoms() has just perceived has aromatic ATOMS and no aromatic bond
 * flags at all. Hence the second clause. The ring test is what keeps a bond
 * that merely LINKS two aromatic systems (a biaryl bond, an N-N joining two
 * azoles) out of this: those are substituent bonds, not ring bonds. A
 * hand-built Mol carrying no ring flags falls back to trusting the two atoms,
 * which is the conservative direction for a triage flag — a missed note, never
 * an invented one. */
function isAromaticRingBond(bond, aromA, aromB) {
  if (!bond) return false;
  if (bond.arom === true) return true;
  if (!aromA || !aromB) return false;
  return typeof bond.ring === "boolean" ? bond.ring : true;
}

/* Does atom i carry a double bond to an atom of element `sym`? */
function doubleTo(mol, nbr, i, sym) {
  for (let t = 0; t < nbr[i].length; t++) {
    const e = nbr[i][t];
    if (order(mol.bonds[e.k]) === 2 && el(mol, e.j) === sym) return true;
  }
  return false;
}

/* ————— structuralAlerts(mol) -> sorted, de-duplicated array of alert ids ——— */
export function structuralAlerts(mol) {
  try {
    return scan(mol);
  } catch (_e) {
    /* Defence in depth: every path below is written to return, not throw. A
     * molecule that finds one anyway must not take a volunteer's whole work
     * unit down with it. */
    return [];
  }
}

function scan(mol) {
  if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) return [];
  const atoms = mol.atoms;
  const n = atoms.length;
  if (n === 0) return [];

  const nbr = adjacency(mol);
  const arom = aromaticAtoms(mol).flags;
  const isArom = (i) => arom.length > i && arom[i] === 1;
  const hits = Object.create(null);
  const flag = (id) => { hits[id] = 1; };

  /* ————— atom-centred patterns ————— */
  for (let i = 0; i < n; i++) {
    const e0 = el(mol, i);

    /* thiol — sulfur carrying a hydrogen */
    if (e0 === "S" && hcount(mol, i) >= 1 && heavyDegree(mol, nbr, i) <= 1) flag("thiol");

    /* nitrogen-centred groups */
    if (e0 === "N") {
      let doubleO = 0, anionicO = 0, otherHeavy = 0, nitrogenNbrs = 0;
      let aromaticSubstituent = false;
      for (let t = 0; t < nbr[i].length; t++) {
        const e = nbr[i][t];
        const je = el(mol, e.j);
        if (je === "H") continue;
        const ord = order(mol.bonds[e.k]);
        if (je === "O") {
          if (ord === 2) doubleO++;
          else if (ord === 1 && charge(mol, e.j) === -1 && heavyDegree(mol, nbr, e.j) === 1) anionicO++;
          else otherHeavy++;
        } else {
          otherHeavy++;
          if (je === "N") nitrogenNbrs++;
          if (isArom(e.j)) aromaticSubstituent = true;
        }
      }
      const oxides = doubleO + anionicO;

      /* nitro — two oxygens on one nitrogen, written either as N(=O)=O or as
       * the charge-separated [N+](=O)[O-]; both spellings are common */
      if (oxides >= 2 && otherHeavy >= 1) {
        flag("nitro");
        if (aromaticSubstituent) flag("aromatic_nitro");
      } else if (oxides === 1 && otherHeavy >= 1) {
        /* one oxygen only: nitroso when it is a double bond and the nitrogen
         * has nothing else, an N-oxide when the nitrogen is fully substituted */
        if (doubleO === 1 && otherHeavy === 1) flag("nitroso");
        else if (otherHeavy >= 3) flag("n_oxide");
        else if (anionicO === 1 && charge(mol, i) > 0) flag("n_oxide");
      }

      /* azide — N-N-N with a terminal nitrogen; `i` is the middle one */
      if (nitrogenNbrs === 2 && otherHeavy === 2 && oxides === 0) {
        let terminal = false;
        for (let t = 0; t < nbr[i].length; t++) {
          const j = nbr[i][t].j;
          if (el(mol, j) === "N" && heavyDegree(mol, nbr, j) === 1) terminal = true;
        }
        if (terminal) flag("azide");
      }
    }

    /* carbon-centred groups */
    if (e0 === "C") {
      let halogens = 0, doubleO = 0, doubleN = 0, doubleS = 0;
      let heteroNbrs = 0, halogenSingle = 0, sp3 = !isArom(i);
      for (let t = 0; t < nbr[i].length; t++) {
        const e = nbr[i][t];
        const je = el(mol, e.j);
        if (je === "H") continue;
        const ord = order(mol.bonds[e.k]);
        if (ord >= 2) sp3 = false;
        if (Object.prototype.hasOwnProperty.call(HALOGEN, je)) {
          halogens++;
          if (ord === 1) halogenSingle++;
        }
        if (ord === 2) {
          if (je === "O") doubleO++;
          else if (je === "N") doubleN++;
          else if (je === "S") doubleS++;
        }
        if (je === "O" || je === "N" || je === "S") heteroNbrs++;
      }

      /* acyl halide — a carbonyl carbon also bonded to a halogen */
      if (doubleO === 1 && halogenSingle >= 1) flag("acyl_halide");

      /* aldehyde — a carbonyl carbon that still carries a hydrogen and has no
       * other heteroatom on it (which would make it an acid, ester or amide) */
      if (doubleO === 1 && hcount(mol, i) >= 1 && heteroNbrs === 1) flag("aldehyde");

      /* isocyanate / isothiocyanate — N=C=O and N=C=S */
      if (doubleN === 1 && (doubleO === 1 || doubleS === 1)) flag("isocyanate");

      /* three or more halogens on one saturated carbon */
      if (sp3 && halogens >= 3) flag("alkyl_halide_triad");
    }

    /* sulfonyl halide — S bearing two double-bonded oxygens and a halogen */
    if (e0 === "S") {
      let dO = 0, hal = 0;
      for (let t = 0; t < nbr[i].length; t++) {
        const e = nbr[i][t];
        const je = el(mol, e.j);
        if (order(mol.bonds[e.k]) === 2 && je === "O") dO++;
        if (Object.prototype.hasOwnProperty.call(HALOGEN, je)) hal++;
      }
      if (dO >= 2 && hal >= 1) flag("sulfonyl_halide");
    }

    /* Phosphonate / phosphate ESTER — P=O carrying at least TWO P-O-C links.
     *
     * Two, not one, and the difference matters a great deal in this app's
     * candidate pool. A single P-O-C is the ordinary phosphate monoester of
     * every nucleotide in biology: NMN, NAD+, ATP, every sugar phosphate. Those
     * are exactly the molecules a longevity screen is most interested in, and
     * flagging them would push the whole NAD-precursor family down a hit list
     * for being made of ordinary biochemistry. The di- and tri-esters are the
     * organophosphate reagents this flag is actually about. */
    if (e0 === "P" && (doubleTo(mol, nbr, i, "O") || doubleTo(mol, nbr, i, "S"))) {
      let esters = 0;
      for (let t = 0; t < nbr[i].length; t++) {
        const e = nbr[i][t];
        if (el(mol, e.j) !== "O" || order(mol.bonds[e.k]) !== 1) continue;
        const lo = nbr[e.j];
        for (let u = 0; u < lo.length; u++) {
          if (lo[u].j !== i && el(mol, lo[u].j) === "C") { esters++; break; }
        }
      }
      if (esters >= 2) flag("phosphonic_ester");
    }

    /* epoxide — an oxygen whose two neighbours are carbons bonded to each other */
    if (e0 === "O" && heavyDegree(mol, nbr, i) === 2) {
      const list = [];
      for (let t = 0; t < nbr[i].length; t++) if (el(mol, nbr[i][t].j) !== "H") list.push(nbr[i][t].j);
      if (list.length === 2 && el(mol, list[0]) === "C" && el(mol, list[1]) === "C") {
        const l0 = nbr[list[0]];
        for (let t = 0; t < l0.length; t++) if (l0[t].j === list[1]) { flag("epoxide"); break; }
      }
    }
  }

  /* ————— bond-centred patterns ————— */
  for (let k = 0; k < mol.bonds.length; k++) {
    const b = mol.bonds[k];
    if (!b) continue;
    const a = b.a, c = b.b;
    if (!Number.isInteger(a) || !Number.isInteger(c)) continue;
    if (a < 0 || c < 0 || a >= n || c >= n || a === c) continue;
    const ea = el(mol, a), ec = el(mol, c), ord = order(b);

    /* peroxide — an oxygen-oxygen single bond */
    if (ord === 1 && ea === "O" && ec === "O") flag("peroxide");

    /* hydrazine / hydrazone — a nitrogen-nitrogen SINGLE bond. The azide
     * middle nitrogen is excluded, because that pattern has its own id and
     * flagging it twice would say the same thing about one group twice.
     *
     * AN AROMATIC N-N IS NOT A HYDRAZINE. order() maps an aromatic bond to 1
     * on purpose (the π system travels in the flags, never in the orders), so
     * without this guard the N-N of every pyrazole, pyridazine, indazole and
     * 1,2,4-triazole read as a hydrazine — stable aromatic heterocycles in
     * celecoxib, sildenafil, anastrozole and letrozole, each paying a 50-point
     * alert penalty in score.js for a group they do not contain. Worse, the
     * penalty was arbitrary between isomers: 1,2,3-triazole, benzotriazole and
     * tetrazole escaped only because the azide suppression below happens to
     * fire on their contiguous N-N-N, so chemically equivalent scaffolds were
     * ranked apart for a reason that has nothing to do with chemistry.
     *
     * The test is the bond, not the atoms: an aromatic RING bond between two
     * aromatic nitrogens is a ring bond and no hydrazine, while an N-N single
     * bond LINKING two rings still is one. Hydralazine, phenelzine, isoniazid
     * and the hydrazones keep their flag. */
    if (ord === 1 && ea === "N" && ec === "N" && !isAromaticRingBond(b, isArom(a), isArom(c))) {
      let azideish = false;
      for (const x of [a, c]) {
        let nn = 0;
        for (let t = 0; t < nbr[x].length; t++) if (el(mol, nbr[x][t].j) === "N") nn++;
        if (nn >= 2 && heavyDegree(mol, nbr, x) === 2) azideish = true;
      }
      if (!azideish) flag("hydrazine");
    }

    /* Michael acceptor — a genuine C=C (never an aromatic ring bond) with a
     * carbonyl, nitrile or sulfonyl one atom away. This is the pattern that
     * makes the shared aromaticity perception load-bearing: every Kekulé
     * benzene in the pool would otherwise match it. */
    if (ord === 2 && ea === "C" && ec === "C" && !isArom(a) && !isArom(c)) {
      if (conjugatedToElectronSink(mol, nbr, a, c) || conjugatedToElectronSink(mol, nbr, c, a)) {
        flag("michael_acceptor");
      }
    }
  }

  /* ————— ring-centred: quinone ————— */
  const rings = perceivedRings(mol);
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (ring.length !== 6) continue;
    let allArom = true;
    for (let i = 0; i < ring.length; i++) if (!isArom(ring[i])) { allArom = false; break; }
    if (allArom) continue;                       /* an aromatic ring is not a quinone */

    /* The ring must be all carbon. Without that test the xanthine diones —
     * caffeine, theobromine, theophylline, half the purine chemistry in the
     * candidate pool — match this pattern, and they are not quinones: the
     * electron-cycling behaviour the flag is about needs the carbon ring. */
    let allCarbon = true;
    for (let i = 0; i < ring.length; i++) if (el(mol, ring[i]) !== "C") { allCarbon = false; break; }
    if (!allCarbon) continue;

    const inRing = new Uint8Array(n);
    for (let i = 0; i < ring.length; i++) inRing[ring[i]] = 1;

    /* A quinone is two ring carbonyls sitting in a ring that is otherwise
     * unsaturated all the way around them. The discriminating test is what
     * FLANKS each carbonyl: in a real quinone both of its ring neighbours are
     * sp2 — a carbon-carbon double bond (p-benzoquinone), a fused aromatic
     * bond (anthraquinone, 1,4-naphthoquinone) or the partner carbonyl itself
     * (ortho-quinones). A plain diketone in a saturated ring
     * (cyclohexane-1,4-dione) has CH2 groups beside its carbonyls, and so does
     * a diketone fused to a benzene, and neither is a quinone. */
    let carbonyls = 0;
    for (let i = 0; i < ring.length; i++) {
      const idx = ring[i];
      let exoCarbonyl = false;
      for (let t = 0; t < nbr[idx].length; t++) {
        const e = nbr[idx][t];
        if (order(mol.bonds[e.k]) === 2 && !inRing[e.j] && el(mol, e.j) === "O") exoCarbonyl = true;
      }
      if (!exoCarbonyl) continue;
      let flanked = true;
      for (let t = 0; t < nbr[idx].length; t++) {
        const e = nbr[idx][t];
        if (!inRing[e.j]) continue;
        if (!isUnsaturated(mol, nbr, e.j)) { flanked = false; break; }
      }
      if (flanked) carbonyls++;
    }
    if (carbonyls >= 2) flag("quinone");
  }

  /* ————— a long greasy chain ————— */
  if (longestSaturatedChain(mol, nbr) > 12) flag("long_alkyl_chain");

  /* Sorted with a code-unit comparator, never localeCompare: these ids reach
   * the consensus digest, so their order is part of what two contributors have
   * to agree on. Object.create(null) keys are collected into an array first so
   * no property enumeration order leaks out. */
  const out = [];
  for (const id in hits) out.push(id);
  out.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return out;
}

/* Does this atom carry any π bond at all — a double bond, a triple bond, or an
 * aromatic bond? */
function isUnsaturated(mol, nbr, i) {
  for (let t = 0; t < nbr[i].length; t++) {
    const b = mol.bonds[nbr[i][t].k];
    if (b && (b.arom === true || b.order === 2 || b.order === 3)) return true;
  }
  return false;
}

/* Is the alkene carbon `a` (whose partner is `other`) attached to a group that
 * pulls electrons hard enough to make the double bond an acceptor? */
function conjugatedToElectronSink(mol, nbr, a, other) {
  for (let t = 0; t < nbr[a].length; t++) {
    const e = nbr[a][t];
    if (e.j === other) continue;
    const je = el(mol, e.j);
    if (je === "C") {
      /* C=O or C=S one bond away — an enone, acrylate, acrylamide */
      if (doubleTo(mol, nbr, e.j, "O") || doubleTo(mol, nbr, e.j, "S")) return true;
      /* a nitrile carbon — acrylonitrile */
      for (let u = 0; u < nbr[e.j].length; u++) {
        if (order(mol.bonds[nbr[e.j][u].k]) === 3 && el(mol, nbr[e.j][u].j) === "N") return true;
      }
    } else if (je === "S") {
      let dO = 0;
      for (let u = 0; u < nbr[e.j].length; u++) {
        if (order(mol.bonds[nbr[e.j][u].k]) === 2 && el(mol, nbr[e.j][u].j) === "O") dO++;
      }
      if (dO >= 2) return true;                  /* a vinyl sulfone */
    }
  }
  return false;
}

/* The longest run of contiguous saturated, non-ring carbons, counted in atoms.
 *
 * Those carbons form a FOREST — every ring atom is excluded by definition — so
 * the longest run is each tree's diameter, which two breadth-first sweeps find
 * exactly and in linear time. Both sweeps start from the lowest-numbered atom
 * available and break ties by index, so the answer cannot depend on traversal
 * order on one engine versus another. */
function longestSaturatedChain(mol, nbr) {
  const n = mol.atoms.length;
  const chain = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (el(mol, i) !== "C") continue;
    const at = mol.atoms[i];
    if (at.arom === true || at.ring === true) continue;
    let ok = true;
    for (let t = 0; t < nbr[i].length; t++) {
      const b = mol.bonds[nbr[i][t].k];
      if (b && (b.arom === true || b.order === 2 || b.order === 3)) { ok = false; break; }
    }
    if (ok) chain[i] = 1;
  }

  const seen = new Uint8Array(n);
  let best = 0;
  const dist = new Int32Array(n);

  const sweep = (start) => {
    dist.fill(-1);
    dist[start] = 0;
    let far = start;
    let frontier = [start];
    while (frontier.length) {
      const next = [];
      for (let f = 0; f < frontier.length; f++) {
        const v = frontier[f];
        if (dist[v] > dist[far] || (dist[v] === dist[far] && v < far)) far = v;
        for (let t = 0; t < nbr[v].length; t++) {
          const j = nbr[v][t].j;
          if (chain[j] !== 1 || dist[j] !== -1) continue;
          dist[j] = dist[v] + 1;
          next.push(j);
        }
      }
      frontier = next;
    }
    return far;
  };

  for (let i = 0; i < n; i++) {
    if (chain[i] !== 1 || seen[i]) continue;
    const end = sweep(i);
    for (let j = 0; j < n; j++) if (dist[j] !== -1) seen[j] = 1;
    const other = sweep(end);
    const len = dist[other] + 1;
    if (len > best) best = len;
  }
  return best;
}
