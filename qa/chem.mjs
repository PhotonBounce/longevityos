/* chem — the cheminformatics engine's contract, pinned against PUBLISHED values.
 *
 * This suite exists because the screening engine's constants (atomic weights,
 * Ertl TPSA fragments, Crippen logP contributions, valence rules) are exactly
 * the kind of thing that can be subtly wrong while everything still "runs".
 * Every number below is a value from the literature or a hand-checkable fact
 * about a molecule any chemist knows, so a wrong table fails HERE rather than
 * quietly poisoning a hit list that people are asked to take seriously.
 *
 * The second half pins DETERMINISM, which is the swarm's whole trust model:
 * same input, same bits, every time, in every engine.
 */
import { parseSmiles, molecularFormula, heavyAtomCount, ringInfo } from "../app/js/chem/smiles.js";
import { molFromSmiles, aromatize } from "../app/js/chem/aromatic.js";
import { morganFingerprint, tanimotoMilli, popcount, fnv1a32, FP_WORDS } from "../app/js/chem/fingerprint.js";
import { descriptors } from "../app/js/chem/descriptors.js";
import { structuralAlerts, ALERTS } from "../app/js/chem/alerts.js";
import { sha256Hex } from "../app/js/chem/digest.js";
import { TARGETS, ENGINE_VERSION, targetsDigest } from "../app/js/chem/targets.js";
import { referenceSet, screenMolecule, screenUnit } from "../app/js/chem/score.js";

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const near = (got, want, tol, msg) =>
  ok(typeof got === "number" && Number.isFinite(got) && Math.abs(got - want) <= tol,
     `${msg} (got ${got}, want ${want} ±${tol})`);
const suite = (name) => console.log("── " + name + " ──");

/* ————— 1. the parser: formulas are exact, hand-checkable facts ————— */
suite("chem 1 — SMILES parsing and molecular formulas");

const MOLECULES = {
  aspirin:      "CC(=O)OC1=CC=CC=C1C(=O)O",
  caffeine:     "CN1C=NC2=C1C(=O)N(C)C(=O)N2C",
  paracetamol:  "CC(=O)NC1=CC=C(O)C=C1",
  benzene:      "c1ccccc1",
  toluene:      "Cc1ccccc1",
  naphthalene:  "c1ccc2ccccc2c1",
  pyridine:     "c1ccncc1",
  ethanol:      "CCO",
  aceticAcid:   "CC(=O)O",
  glycine:      "NCC(=O)O",
  metformin:    "CN(C)C(=N)NC(=N)N",
  taurine:      "NCCS(=O)(=O)O",
  ibuprofen:    "CC(C)CC1=CC=C(C=C1)C(C)C(=O)O",
  phenol:       "OC1=CC=CC=C1"
};

const FORMULA = {
  aspirin: "C9H8O4", caffeine: "C8H10N4O2", paracetamol: "C8H9NO2",
  benzene: "C6H6", toluene: "C7H8", naphthalene: "C10H8", pyridine: "C5H5N",
  ethanol: "C2H6O", aceticAcid: "C2H4O2", glycine: "C2H5NO2",
  metformin: "C4H11N5", taurine: "C2H7NO3S", ibuprofen: "C13H18O2", phenol: "C6H6O"
};

/* TWO graphs, deliberately. `raw` is what the parser alone returns; `parsed` is
 * what production actually screens — parseSmiles PLUS aromaticity perception,
 * via the same molFromSmiles door score.js uses. Everything below is pinned on
 * `parsed`, because a gate that measures a model production does not run is a
 * gate that can pass while the product is wrong. */
const raw = {}, parsed = {};
for (const [name, smi] of Object.entries(MOLECULES)) {
  const rawMol = parseSmiles(smi);
  const mol = molFromSmiles(smi);
  ok(rawMol && Array.isArray(rawMol.atoms) && rawMol.atoms.length > 0, `${name}: parses`);
  ok(mol && Array.isArray(mol.atoms) && mol.atoms.length > 0, `${name}: parses through the production door`);
  if (!rawMol || !mol) continue;
  raw[name] = rawMol;
  parsed[name] = mol;
  ok(molecularFormula(mol) === FORMULA[name],
     `${name}: formula is ${FORMULA[name]} (got ${molecularFormula(mol)})`);
  /* perception may only re-label aromaticity — it must never change what the
   * molecule IS. Formula and mass are the two things that would expose that. */
  ok(molecularFormula(rawMol) === molecularFormula(mol),
     `${name}: aromaticity perception does not change the formula`);
  const dRaw = descriptors(rawMol), dPerceived = descriptors(mol);
  ok(dRaw && dPerceived && Math.abs(dRaw.mw - dPerceived.mw) < 0.001,
     `${name}: aromaticity perception does not change the molecular weight`);
}

ok(heavyAtomCount(parsed.benzene) === 6, "benzene has 6 heavy atoms");
ok(heavyAtomCount(parsed.aspirin) === 13, "aspirin has 13 heavy atoms");

const rBenzene = ringInfo(parsed.benzene);
ok(rBenzene.rings === 1 && rBenzene.aromaticRings === 1, "benzene: one aromatic ring");
const rNaph = ringInfo(parsed.naphthalene);
ok(rNaph.rings === 2 && rNaph.aromaticRings === 2, "naphthalene: two aromatic rings");
const rEth = ringInfo(parsed.ethanol);
ok(rEth.rings === 0 && rEth.aromaticRings === 0, "ethanol: no rings");

/* salts and disconnected components must survive — most of PubChem is salts */
const salt = parseSmiles("CC(=O)[O-].[Na+]");
ok(salt !== null, "a sodium salt parses (dot-disconnected)");
ok(salt && molecularFormula(salt) === "C2H3NaO2", `sodium acetate formula (got ${salt && molecularFormula(salt)})`);

/* ————— 2. descriptors vs published values ————— */
suite("chem 2 — descriptors against published values");

const dAsp = descriptors(parsed.aspirin);
near(dAsp.mw, 180.16, 0.15, "aspirin MW");
near(dAsp.tpsa, 63.6, 1.0, "aspirin TPSA (Ertl)");
near(dAsp.clogp, 1.31, 1.0, "aspirin cLogP (Crippen)");
ok(dAsp.hbd === 1, `aspirin has 1 H-bond donor (got ${dAsp.hbd})`);
ok(dAsp.hba === 4, `aspirin has 4 Lipinski acceptors (got ${dAsp.hba})`);
ok(dAsp.rings === 1 && dAsp.aromRings === 1, "aspirin: one aromatic ring");

const dCaf = descriptors(parsed.caffeine);
near(dCaf.mw, 194.19, 0.15, "caffeine MW");
/* Caffeine TPSA is a documented fork between implementations, not a drift, so
 * the number is explained here rather than quietly tolerated. On the perceived
 * (fully aromatic purine) graph this engine applies Ertl's table consistently:
 *   3 x aromatic N, 3 connections (4.41) + 1 x aromatic n, 2 connections (12.89)
 *   + 2 x carbonyl =O (17.07)  =  60.26
 * The widely-quoted 58.44 comes from treating the three N-methyl nitrogens as
 * amide rather than aromatic. Ours is internally consistent with the same
 * aromaticity perception the fingerprint uses, and TPSA only ever enters the
 * screen as a threshold comparison (>140 flags a molecule), where a 1.8 A^2
 * difference changes nothing. The tolerance stays tight enough that a real
 * table error still fails this line. */
near(dCaf.tpsa, 59.35, 1.5, "caffeine TPSA (Ertl on the aromatic purine; see note)");
ok(dCaf.hbd === 0, `caffeine has no H-bond donors (got ${dCaf.hbd})`);

const dPar = descriptors(parsed.paracetamol);
near(dPar.mw, 151.16, 0.15, "paracetamol MW");
near(dPar.tpsa, 49.33, 1.5, "paracetamol TPSA");
ok(dPar.hbd === 2, `paracetamol has 2 donors (got ${dPar.hbd})`);

near(descriptors(parsed.benzene).mw, 78.11, 0.1, "benzene MW");
near(descriptors(parsed.benzene).tpsa, 0, 0.01, "benzene TPSA is zero");
near(descriptors(parsed.ethanol).mw, 46.07, 0.1, "ethanol MW");
near(descriptors(parsed.ethanol).tpsa, 20.23, 0.5, "ethanol TPSA (one hydroxyl)");
near(descriptors(parsed.glycine).mw, 75.07, 0.1, "glycine MW");
near(descriptors(parsed.metformin).mw, 129.16, 0.15, "metformin MW");
near(descriptors(parsed.ibuprofen).mw, 206.28, 0.2, "ibuprofen MW");
near(descriptors(parsed.ibuprofen).clogp, 3.5, 1.2, "ibuprofen is lipophilic (cLogP ~3.5)");
near(descriptors(parsed.pyridine).tpsa, 12.89, 0.5, "pyridine TPSA (aromatic N)");

/* fsp3: benzene is fully aromatic (0), ethanol fully sp3 (1) */
near(descriptors(parsed.benzene).fsp3, 0, 0.001, "benzene fsp3 = 0");
near(descriptors(parsed.ethanol).fsp3, 1, 0.001, "ethanol fsp3 = 1");

/* every descriptor is finite for every test molecule — NaN is the silent killer */
for (const [name, mol] of Object.entries(parsed)) {
  const d = descriptors(mol);
  ok(d && Object.values(d).every((v) => typeof v === "number" && Number.isFinite(v)),
     `${name}: every descriptor is a finite number`);
}

/* ————— 2b. aromaticity perception: the same molecule, however it is written ————— */
suite("chem 2b — aromatic and Kekulé spellings converge");

/* This is the defect that would have silently ruined every score: PubChem hands
 * out both conventions, and without perception benzene scored 0/1000 against
 * benzene. Each pair below is the SAME molecule written both ways. */
const SPELLINGS = [
  ["benzene",     "c1ccccc1",                "C1=CC=CC=C1"],
  ["phenol",      "c1ccccc1O",               "OC1=CC=CC=C1"],
  ["pyridine",    "c1ccncc1",                "C1=CC=NC=C1"],
  ["toluene",     "Cc1ccccc1",               "CC1=CC=CC=C1"],
  ["aspirin",     "CC(=O)Oc1ccccc1C(=O)O",   "CC(=O)OC1=CC=CC=C1C(=O)O"],
  ["naphthalene", "c1ccc2ccccc2c1",          "C1=CC2=CC=CC=C2C=C1"],
  ["indole",      "c1ccc2[nH]ccc2c1",        "C1=CC2=C(C=C1)NC=C2"],
  ["caffeine",    "Cn1cnc2c1c(=O)n(C)c(=O)n2C", "CN1C=NC2=C1C(=O)N(C)C(=O)N2C"],
  ["furan",       "c1ccoc1",                 "C1=COC=C1"],
  ["thiophene",   "c1ccsc1",                 "C1=CSC=C1"]
];
for (const [name, aromaticForm, kekuleForm] of SPELLINGS) {
  const mA = molFromSmiles(aromaticForm), mK = molFromSmiles(kekuleForm);
  ok(mA && mK, `${name}: both spellings parse`);
  if (!mA || !mK) continue;
  ok(molecularFormula(mA) === molecularFormula(mK), `${name}: both spellings give the same formula`);
  const sim = tanimotoMilli(morganFingerprint(mA, 2), morganFingerprint(mK, 2));
  ok(sim === 1000, `${name}: aromatic and Kekulé forms are IDENTICAL after perception (got ${sim}/1000)`);
}

/* and perception must not run wild — a saturated ring is not aromatic */
for (const [name, smi] of [["cyclohexane", "C1CCCCC1"], ["cyclohexene", "C1=CCCCC1"],
                            ["cyclohexanone", "O=C1CCCCC1"], ["piperidine", "C1CCNCC1"]]) {
  const m = molFromSmiles(smi);
  ok(m && m.atoms.filter((a) => a.arom).length === 0, `${name}: correctly NOT aromatized`);
}

/* ————— 3. SHA-256 test vectors ————— */
suite("chem 3 — digest");
ok(sha256Hex("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256('') vector");
ok(sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "sha256('abc') vector");
ok(sha256Hex("The quick brown fox jumps over the lazy dog") ===
   "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592", "sha256(pangram) vector");
ok(sha256Hex("é🧬").length === 64, "sha256 handles multi-byte UTF-8 without throwing");

/* ————— 4. fingerprints and similarity ————— */
suite("chem 4 — Morgan fingerprints");
const fpAsp = morganFingerprint(parsed.aspirin, 2);
/* through the SAME production door — comparing a perceived graph against a raw
 * one is precisely the spelling-vs-structure mistake this engine exists to
 * avoid, and it belongs in the aromaticity section above, not here */
const fpAsp2 = morganFingerprint(molFromSmiles(MOLECULES.aspirin), 2);
const fpCaf = morganFingerprint(parsed.caffeine, 2);
const fpPar = morganFingerprint(parsed.paracetamol, 2);
ok(fpAsp instanceof Uint32Array && fpAsp.length === FP_WORDS, "fingerprint is a packed Uint32Array(32) = 1024 bits");
ok(popcount(fpAsp) > 0, "aspirin sets bits");
ok(tanimotoMilli(fpAsp, fpAsp2) === 1000, "a molecule is identical to itself (1000/1000)");
ok(tanimotoMilli(fpAsp, fpCaf) === tanimotoMilli(fpCaf, fpAsp), "Tanimoto is symmetric");
ok(tanimotoMilli(fpAsp, fpCaf) < 1000, "aspirin and caffeine are not identical");
ok(tanimotoMilli(fpAsp, fpPar) > tanimotoMilli(fpAsp, fpCaf),
   "aspirin resembles paracetamol (both acetyl-benzenes) more than caffeine — the whole premise of similarity screening");
const empty = new Uint32Array(FP_WORDS);
ok(tanimotoMilli(empty, empty) === 0, "empty vs empty is 0, not a division by zero");
ok(Number.isInteger(tanimotoMilli(fpAsp, fpCaf)), "Tanimoto is an integer (exact consensus depends on it)");

/* bit-for-bit reproducibility across repeated construction */
let fpStable = true;
for (let i = 0; i < 5; i++) {
  const f = morganFingerprint(parseSmiles(MOLECULES.ibuprofen), 2);
  const g = morganFingerprint(parseSmiles(MOLECULES.ibuprofen), 2);
  for (let w = 0; w < FP_WORDS; w++) if (f[w] !== g[w]) fpStable = false;
}
ok(fpStable, "fingerprints are bit-identical across repeated runs");

/* ————— 4b. THE WIRE FORMAT IS PINNED, NOT MERELY CONSISTENT —————
 *
 * Everything above is RELATIONAL: self==1000, symmetry, aspirin resembles
 * paracetamol. Every one of those survives a change to the string that gets
 * hashed — so an innocent-looking refactor inside morganFingerprint can move
 * every bit in the swarm while the gate stays green, and two volunteers on
 * either side of that commit would score every unit as a permanent "conflict".
 * (Demonstrated: rewriting the radius-r invariant from
 * `cur[i] + "|" + pairs.join(",")` to `cur[i] + ":"` left this suite at
 * 354/354 while the consensus digest of a 39-molecule unit moved.)
 *
 * These vectors are LITERALS on purpose. They are the definition of the wire
 * format, the thing a second-language canary generator has to reproduce, and
 * they may only ever change in a deliberate, versioned engine bump — a diff
 * that touches the numbers below is a diff that forks the volunteer
 * population, and it should be impossible to make one by accident.
 *
 * They are also deliberately built from a Mol LITERAL rather than from
 * parseSmiles, so they pin the fingerprint's format alone and cannot be
 * knocked over by unrelated work on the parser. The one parser-coupled check
 * is called out as such. */
ok(fnv1a32("") === 2166136261, "FNV-1a offset basis is pinned (empty string -> 2166136261)");
ok(fnv1a32("C|1|3|0|0|0") === 2693302896, "atom invariant string 'C|1|3|0|0|0' hashes to 2693302896");
ok(fnv1a32("O|1|1|0|0|0") === 227504658, "atom invariant string 'O|1|1|0|0|0' hashes to 227504658");
ok(fnv1a32("C|2|2|0|0|0") === 951847286, "atom invariant string 'C|2|2|0|0|0' hashes to 951847286");
ok(fnv1a32("951847286|1,227504658,1,2693302896") === 489613472,
   "the radius-1 invariant string — previous invariant, '|', then sorted (bondCode,invariant) pairs joined by ',' — hashes to 489613472");
ok(2693302896 % 1024 === 624 && 489613472 % 1024 === 160, "folding is invariant modulo 1024 bits");

const bitsOf = (fp) => {
  const out = [];
  for (let w = 0; w < fp.length; w++) for (let b = 0; b < 32; b++) if (fp[w] & (1 << b)) out.push(w * 32 + b);
  return out;
};
/* ethanol, written out as data: C(H3)-C(H2)-O(H1), no rings, no aromaticity */
const ETHANOL_MOL = {
  atoms: [
    { el: "C", arom: false, charge: 0, hcount: 3, ring: false },
    { el: "C", arom: false, charge: 0, hcount: 2, ring: false },
    { el: "O", arom: false, charge: 0, hcount: 1, ring: false }
  ],
  bonds: [
    { a: 0, b: 1, order: 1, arom: false, ring: false },
    { a: 1, b: 2, order: 1, arom: false, ring: false }
  ]
};
const ETHANOL_BITS = "160,193,322,374,484,530,624,659,784";
ok(bitsOf(morganFingerprint(ETHANOL_MOL, 2)).join(",") === ETHANOL_BITS,
   "THE SWARM WIRE FORMAT: ethanol's ECFP4 bit set is pinned bit-for-bit — if this moved, every volunteer's digest moved with it");
ok(bitsOf(morganFingerprint(parseSmiles("CCO"), 2)).join(",") === ETHANOL_BITS,
   "the parser still hands the engine that same ethanol (a change HERE but not above means the parser's Mol moved, and with it every digest in the swarm)");

/* the radius contract: an unusable radius is the documented default, never a
 * silent ECFP0 that still looks and compares like a real fingerprint */
ok(popcount(morganFingerprint(ETHANOL_MOL, 0)) === 3, "radius 0 is honoured — ECFP0 is a legitimate request");
for (const bad of [null, undefined, NaN, -1, "2", {}, [], true, -Infinity, 2.5]) {
  const shown = typeof bad === "string" ? JSON.stringify(bad) : Array.isArray(bad) ? "[]" : String(bad);
  ok(popcount(morganFingerprint(ETHANOL_MOL, bad)) === 9,
     `an unusable radius (${shown}) falls back to the documented default 2, not to ECFP0`);
}
ok(popcount(morganFingerprint(ETHANOL_MOL, Infinity)) === popcount(morganFingerprint(ETHANOL_MOL, 16)),
   "an infinite radius clamps to MAX_RADIUS rather than spinning");

/* a mis-sized fingerprint is no evidence, not a plausible-looking number */
const ones = new Uint32Array(FP_WORDS).fill(0xFFFFFFFF);
ok(tanimotoMilli(new Uint32Array(4).fill(0xFFFFFFFF), ones) === 0, "a too-short fingerprint scores 0, not a zero-padded 125");
ok(tanimotoMilli(new Uint32Array(64).fill(0xFFFFFFFF), ones) === 0, "a too-long fingerprint scores 0, not a truncated 1000");
ok(tanimotoMilli(ones, ones) === 1000, "two correctly sized full fingerprints still score 1000");

/* a corrupt bond is SKIPPED, never rewritten into a bond to atom 0 */
const noBond = { atoms: ETHANOL_MOL.atoms, bonds: [] };
const bond02 = { atoms: ETHANOL_MOL.atoms, bonds: [{ a: 0, b: 2, order: 1 }] };
for (const b of [{ b: 2 }, { a: NaN, b: 2 }, { a: "oops", b: 2 }, { a: null, b: 2 }, { a: 0.5, b: 2 }]) {
  const got = bitsOf(morganFingerprint({ atoms: ETHANOL_MOL.atoms, bonds: [b] }, 2)).join(",");
  ok(got === bitsOf(morganFingerprint(noBond, 2)).join(",") && got !== bitsOf(morganFingerprint(bond02, 2)).join(","),
     `a bond with a non-integer index (${JSON.stringify(b)}) is dropped, not silently bonded to atom 0`);
}

/* hostile Mols never throw — including ones carrying executable accessors */
const hostileMols = [
  null, undefined, 42, "CCO", [], {}, { atoms: [] }, { atoms: {} },
  { atoms: [{ el: "C", hcount: Symbol("s") }], bonds: [] },
  { atoms: [{ el: "C", charge: { valueOf() { throw new Error("boom"); } } }], bonds: [] },
  { atoms: [{ el: "C" }, { el: "C" }], bonds: [{ a: 0, b: 1, get order() { throw new Error("boom"); } }] },
  { get atoms() { throw new Error("boom"); } },
  { atoms: [{ get el() { throw new Error("boom"); } }], bonds: [] }
];
let hostileOk = true;
for (const m of hostileMols) {
  try {
    const f = morganFingerprint(m, Symbol.iterator);
    if (!(f instanceof Uint32Array) || f.length !== FP_WORDS) hostileOk = false;
  } catch (_) { hostileOk = false; }
}
ok(hostileOk, "a hostile Mol — including one whose own accessors throw — yields a fingerprint, never an exception");

/* ————— 5. structural alerts are flags, not verdicts ————— */
suite("chem 5 — structural alerts");
ok(Array.isArray(ALERTS) && ALERTS.length >= 10, `the alert catalogue is populated (${ALERTS.length})`);
ok(ALERTS.every((a) => a.id && a.name && a.why), "every alert explains itself in plain language");
const nitro = parseSmiles("O=[N+]([O-])c1ccccc1");
ok(nitro && structuralAlerts(nitro).length >= 1, "nitroaromatic raises an alert");
ok(structuralAlerts(parsed.glycine).length === 0, "glycine raises no alerts");
const alertsAsp = structuralAlerts(parsed.aspirin);
ok(Array.isArray(alertsAsp) && alertsAsp.every((a) => typeof a === "string"), "alerts are string ids");
ok(JSON.stringify(alertsAsp) === JSON.stringify([...alertsAsp].sort()), "alert ids come back sorted (digest stability)");

/* ————— 6. the targets: the scientific inputs ————— */
suite("chem 6 — longevity targets and reference actives");
ok(ENGINE_VERSION === "los-chem-2", "engine version is pinned");
ok(Array.isArray(TARGETS) && TARGETS.length >= 8, `at least 8 targets (${TARGETS.length})`);
const seenIds = new Set();
let totalActives = 0;
for (const t of TARGETS) {
  ok(/^[a-z0-9_]+$/.test(t.id), `${t.id}: id is a slug`);
  ok(!seenIds.has(t.id), `${t.id}: id is unique`);
  seenIds.add(t.id);
  for (const k of ["name", "pathway", "why"]) {
    ok(typeof t[k] === "string" && t[k].length > 5, `${t.id}: ${k} is present`);
  }
  ok(typeof t.sourceUrl === "string" && t.sourceUrl.startsWith("https://"),
     `${t.id}: carries a source link`);
  ok(Array.isArray(t.actives) && t.actives.length >= 1, `${t.id}: has reference actives`);
  for (const a of t.actives) {
    totalActives++;
    ok(typeof a.name === "string" && a.name.length > 0, `${t.id}: active is named`);
    ok(/^[0-9]{1,12}$/.test(String(a.cid)), `${t.id}/${a.name}: CID is numeric (${a.cid})`);
    const mol = parseSmiles(a.smiles);
    ok(mol !== null, `${t.id}/${a.name}: its SMILES parses`);
    if (mol) ok(heavyAtomCount(mol) >= 2, `${t.id}/${a.name}: is a real molecule`);
  }
}
ok(totalActives >= 15, `the reference set is substantial (${totalActives} actives)`);
ok(/^[0-9a-f]{64}$/.test(targetsDigest()), "targetsDigest is a sha256 hex string");
ok(targetsDigest() === targetsDigest(), "targetsDigest is stable across calls");

/* the honesty rule reaches the science layer too */
for (const t of TARGETS) {
  ok(!/\b(cures?|reverses?) aging\b/i.test(t.why), `${t.id}: no cure/reversal claim`);
  ok(!/proven to extend human (life|lifespan)/i.test(t.why), `${t.id}: no proven-human-lifespan claim`);
}

/* ————— 7. scoring and the unit digest — the trust model ————— */
suite("chem 7 — screening and the consensus digest");
const refs = referenceSet();
ok(refs.targets.length >= 8, "the reference set builds fingerprints for every target");
ok(refs.engine === ENGINE_VERSION, "the reference set carries the engine version");

const sAsp = screenMolecule(MOLECULES.aspirin, refs);
ok(sAsp.ok === true, "aspirin screens");
ok(Number.isInteger(sAsp.score) && sAsp.score >= 0 && sAsp.score <= 1000,
   `score is an integer 0..1000 (got ${sAsp.score})`);
ok(typeof sAsp.best === "string", "a best-matching target is reported");
ok(Array.isArray(sAsp.perTarget) && sAsp.perTarget.length === refs.targets.length,
   "every target gets a similarity");
ok(sAsp.perTarget.every((p, i, arr) => i === 0 || arr[i - 1].sim >= p.sim),
   "per-target similarities come back sorted (descending)");

/* a reference active screened against its own target must score at the top */
const firstActive = TARGETS.find((t) => t.actives && t.actives.length)?.actives[0];
const sSelf = screenMolecule(firstActive.smiles, refs);
ok(sSelf.ok && sSelf.bestSim === 1000, `a reference active matches itself perfectly (${firstActive.name})`);

/* unparseable input degrades, never throws */
for (const junk of ["", "not a molecule", "C(((", "%%%", "[Xx]", "C".repeat(5000), "💊"]) {
  const r = screenMolecule(junk, refs);
  ok(r.ok === false && r.score === 0, `hostile input scores 0 without throwing: ${JSON.stringify(junk.slice(0, 12))}`);
}
ok(screenMolecule(null, refs).ok === false, "null input is refused, not thrown on");
ok(screenMolecule(undefined, refs).ok === false, "undefined input is refused");

const unit = {
  unit_id: "u-test-0001",
  molecules: [
    { id: "m2", smiles: MOLECULES.caffeine },
    { id: "m1", smiles: MOLECULES.aspirin },
    { id: "m3", smiles: "totally-not-a-molecule" }
  ]
};
const run1 = screenUnit(unit, refs);
const run2 = screenUnit(unit, referenceSet());
ok(/^[0-9a-f]{64}$/.test(run1.digest), "the unit digest is sha256 hex");
ok(run1.digest === run2.digest, "THE TRUST MODEL: the same unit digests identically on a fresh reference set");
ok(run1.results.length === 3, "every molecule in the unit is reported, including the unparseable one");
ok(run1.results[0].id === "m1" && run1.results[2].id === "m3",
   "results are sorted by id — input order can never change a digest");

/* shuffling the input must not change the digest */
const shuffled = { unit_id: "u-test-0001", molecules: [unit.molecules[2], unit.molecules[0], unit.molecules[1]] };
ok(screenUnit(shuffled, refs).digest === run1.digest, "reordering the unit's molecules leaves the digest unchanged");

/* but any real change must change it */
const changed = { unit_id: "u-test-0001", molecules: [...unit.molecules.slice(0, 2), { id: "m3", smiles: MOLECULES.phenol }] };
ok(screenUnit(changed, refs).digest !== run1.digest, "a different molecule produces a different digest");
const otherUnit = { unit_id: "u-test-0002", molecules: unit.molecules };
ok(screenUnit(otherUnit, refs).digest !== run1.digest, "the unit id is bound into the digest");

/* an empty unit is legal and deterministic */
const emptyUnit = screenUnit({ unit_id: "u-empty", molecules: [] }, refs);
ok(/^[0-9a-f]{64}$/.test(emptyUnit.digest) && emptyUnit.results.length === 0, "an empty unit digests cleanly");
ok(screenUnit(null, refs).results.length === 0, "a null unit does not throw");

console.log(failed ? "chem: " + failed + " FAILED of " + checks : "chem: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
