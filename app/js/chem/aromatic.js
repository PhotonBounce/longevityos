/* aromatic.js — aromaticity perception, and the single front door for turning
 * a SMILES string into a screenable molecule.
 *
 * WHY THIS EXISTS (a bug that would have quietly ruined every score):
 * benzene can be written "c1ccccc1" or "C1=CC=CC=C1". Both are correct, and
 * PubChem hands out both conventions depending on the record. The parser
 * faithfully reports what it was given — aromatic flags for the first, plain
 * alternating double bonds for the second — and the Morgan fingerprint keys its
 * atom invariants on exactly those flags. Result, measured before this module
 * existed: benzene vs benzene scored 0/1000, phenol vs phenol 38/1000. Every
 * "similarity to a known longevity drug" would have been a measure of how the
 * two SMILES happened to be typed.
 *
 * So before anything is fingerprinted, rings are perceived and a Hückel-style
 * test aromatizes them, collapsing both spellings onto the same graph. This is
 * the same normalisation step real toolkits perform when they sanitize a
 * molecule; the rules below are deliberately conservative — when in doubt a
 * ring is left non-aromatic rather than aromatized on a guess.
 */

import { parseSmiles } from "./smiles.js";

const MAX_RING = 10;          // aromatic systems in drug-like matter are 5-7
const FIXPOINT_PASSES = 4;    // fused systems need their neighbours settled first

/* ————— ring perception: the smallest cycle through each bond ————— */

function adjacency(mol) {
  const adj = mol.atoms.map(() => []);
  mol.bonds.forEach((b, i) => {
    adj[b.a].push({ atom: b.b, bond: i });
    adj[b.b].push({ atom: b.a, bond: i });
  });
  return adj;
}

/* BFS for the shortest path between the two ends of a bond, without using that
 * bond — the classic "smallest ring through this bond". Collect the unique
 * rings by their sorted atom set; that is not a formally minimal SSSR, but it
 * finds every ring that matters here and never invents one. */
function findRings(mol) {
  const adj = adjacency(mol);
  const seen = new Set();
  const rings = [];
  for (let bi = 0; bi < mol.bonds.length; bi++) {
    const { a: start, b: goal } = mol.bonds[bi];
    const prev = new Map([[start, -1]]);
    const queue = [start];
    let found = false;
    while (queue.length && !found) {
      const cur = queue.shift();
      for (const nb of adj[cur]) {
        if (nb.bond === bi) continue;
        if (prev.has(nb.atom)) continue;
        prev.set(nb.atom, cur);
        if (nb.atom === goal) { found = true; break; }
        queue.push(nb.atom);
      }
    }
    if (!found) continue;
    const path = [];
    let cur = goal;
    while (cur !== -1 && path.length <= MAX_RING + 1) { path.push(cur); cur = prev.get(cur); }
    if (path.length < 3 || path.length > MAX_RING) continue;
    const key = [...path].sort((x, y) => x - y).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    rings.push(path);
  }
  return rings;
}

/* ————— the π-electron count ————— */

/* Elements that can carry an aromatic ring position at all. Anything else in a
 * ring means the ring is not aromatic — no exceptions, no guessing. */
const SP2_OK = new Set(["C", "N", "O", "S", "P", "Se", "B", "Si"]);
const LONE_PAIR_DONOR = new Set(["N", "O", "S", "Se", "P"]);

function bondsOf(mol, idx, adj) {
  return adj[idx].map((nb) => ({ ...mol.bonds[nb.bond], other: nb.atom }));
}

/*
 * Electrons contributed by one ring atom:
 *   1  — it has a double/aromatic bond to another atom of THIS ring
 *   1  — its double bond leaves the ring but lands on an atom already known
 *        aromatic (a fused-ring junction, e.g. indole's C3a/C7a)
 *   0  — a carbon whose double bond leaves the ring to a heteroatom
 *        (a carbonyl on the ring, as in a quinone or a pyridone): sp2, and
 *        contributes nothing — the ring can still be aromatic without it
 *   2  — a neutral N/O/S/P with a lone pair and no double bond (pyrrole,
 *        furan, thiophene), or a carbanion-like negatively charged carbon
 *  -1  — not sp2: the ring cannot be aromatic
 */
function contribution(mol, idx, ringSet, adj, aromaticAtoms) {
  const at = mol.atoms[idx];
  if (!SP2_OK.has(at.el)) return -1;

  const bl = bondsOf(mol, idx, adj);
  const inRingMultiple = bl.find((b) => (b.order === 2 || b.arom) && ringSet.has(b.other));
  if (inRingMultiple) return 1;

  const exo = bl.find((b) => b.order === 2 && !ringSet.has(b.other));
  if (exo) {
    if (aromaticAtoms.has(exo.other)) return 1;                  // fused junction
    if (at.el === "C" && mol.atoms[exo.other].el !== "C") return 0; // ring carbonyl
    return -1;                                                    // an ordinary exocyclic alkene breaks it
  }

  if (at.arom) return 1;                       // the parser already said so (lowercase input)
  if (LONE_PAIR_DONOR.has(at.el) && at.charge >= 0) return 2;
  if (at.el === "C" && at.charge < 0) return 2;
  if (at.el === "C" && at.charge > 0) return 0;
  return -1;
}

/* ————— the pass ————— */

export function aromatize(mol) {
  if (!mol || !Array.isArray(mol.atoms) || !mol.atoms.length) return mol;
  const adj = adjacency(mol);
  const rings = findRings(mol);
  if (!rings.length) return mol;

  const aromaticAtoms = new Set();
  for (let i = 0; i < mol.atoms.length; i++) if (mol.atoms[i].arom) aromaticAtoms.add(i);

  const aromaticRings = [];
  for (let pass = 0; pass < FIXPOINT_PASSES; pass++) {
    let changed = false;
    for (const ring of rings) {
      const key = [...ring].sort((a, b) => a - b).join(",");
      if (aromaticRings.includes(key)) continue;
      const ringSet = new Set(ring);
      let electrons = 0, ok = true;
      for (const idx of ring) {
        const c = contribution(mol, idx, ringSet, adj, aromaticAtoms);
        if (c < 0) { ok = false; break; }
        electrons += c;
      }
      /* Hückel: 4n + 2 π electrons */
      if (ok && electrons >= 2 && (electrons - 2) % 4 === 0) {
        aromaticRings.push(key);
        for (const idx of ring) aromaticAtoms.add(idx);
        changed = true;
      }
    }
    if (!changed) break;
  }

  /* Write the perception back onto the graph. Bond ORDER is deliberately left
   * untouched — the formula and every valence/hydrogen count still derive from
   * the Kekulé structure the parser read. Only the aromatic FLAGS change, and
   * those are what the fingerprint keys on, so both spellings converge. */
  for (const idx of aromaticAtoms) mol.atoms[idx].arom = true;
  for (const b of mol.bonds) {
    if (aromaticAtoms.has(b.a) && aromaticAtoms.has(b.b) && inSameAromaticRing(b, aromaticRings)) {
      b.arom = true;
    }
  }
  return mol;
}

function inSameAromaticRing(bond, aromaticRingKeys) {
  for (const key of aromaticRingKeys) {
    const atoms = key.split(",");
    if (atoms.includes(String(bond.a)) && atoms.includes(String(bond.b))) return true;
  }
  return false;
}

/* ————— the single front door ————— */

/* Everything that screens a molecule goes through here, so no caller can
 * accidentally fingerprint an un-normalised graph and compare spellings
 * instead of structures. */
export function molFromSmiles(smiles) {
  const mol = parseSmiles(smiles);
  if (!mol) return null;
  return aromatize(mol);
}
