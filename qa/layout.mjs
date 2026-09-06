/* layout — THE MOLECULE BUILDER in bare Node.
 *
 * viewLayoutMolecule must draw every reference active and a set of hard
 * structures (fused, bridged, spiro, a macrocycle, charges, isotopes, stereo,
 * salts, long chains, the 80/81-atom boundary), refuse what the lens does not
 * draw, never throw on garbage, keep every coordinate finite and inside the
 * viewBox, reference only real atoms, be byte-identical across runs AND across
 * two separate processes, and stay under the performance budget (≤ 4 ms each,
 * ≤ 1.5 ms median on this machine). The numbers are printed.
 *
 * Invoked with --digest it prints one line — the sha256 of every layout's
 * JSON — and exits; the main run spawns itself that way to prove cross-process
 * determinism. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { viewLayoutMolecule } from "../app/js/view/layout.js";
import { molFromSmiles } from "../app/js/chem/aromatic.js";
import { TARGETS } from "../app/js/chem/targets.js";

const SELF = fileURLToPath(import.meta.url);
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

/* ————— the corpus ————— */

const actives = [];
for (const t of TARGETS) for (const a of t.actives || []) actives.push({ name: a.name, smiles: a.smiles });

const HARD = [
  ["naphthalene", "c1ccc2ccccc2c1"],
  ["anthracene", "c1ccc2cc3ccccc3cc2c1"],
  ["phenanthrene", "c1ccc2c(c1)ccc1ccccc12"],
  ["pyrene", "c1cc2ccc3cccc4ccc(c1)c2c34"],
  ["indole", "c1ccc2[nH]ccc2c1"],
  ["purine", "c1ncc2nc[nH]c2n1"],
  ["spiro[4.5]decane", "C1CCC2(CC1)CCCC2"],
  ["norbornane (bridged)", "C1CC2CCC1C2"],
  ["adamantane (cage)", "C1C2CC3CC1CC(C2)C3"],
  ["cubane", "C12C3C4C1C5C2C3C45"],
  ["testosterone", "CC12CCC3C(C1CCC2O)CCC4=CC(=O)CCC34C"],
  ["cholesterol", "CC(C)CCCC(C)C1CCC2C1(CCC3C2CC=C4C3(CCC(C4)O)C)C"],
  ["ammonium", "[NH4+]"],
  ["acetate sodium (salt)", "CC(=O)[O-].[Na+]"],
  ["tetramethylammonium", "C[N+](C)(C)C"],
  ["nitrobenzene", "[O-][N+](=O)c1ccccc1"],
  ["13C methane (isotope)", "[13CH4]"],
  ["d3-acetic acid (isotope)", "[2H]C([2H])([2H])C(=O)O"],
  ["L-alanine (stereo)", "C[C@H](N)C(=O)O"],
  ["trans-difluoroethene (stereo bond)", "F/C=C/F"],
  ["trans-dimethylcyclohexane", "C[C@@H]1CC[C@H](C)CC1"],
  ["magnesium chloride (3 components)", "[Cl-].[Cl-].[Mg+2]"],
  ["benzene.benzene.water", "c1ccccc1.c1ccccc1.O"],
  ["triacontane (30-chain)", "C".repeat(30)],
  ["80-carbon chain (boundary)", "C".repeat(80)],
  ["cyclooctadecane (macrocycle, ring not perceived)", "C1CCCCCCCCCCCCCCCCC1"],
  ["18-crown-6", "C1COCCOCCOCCOCCOCCO1"],
  ["triyne", "C#CC#CC#C"],
  ["phthalonitrile", "N#Cc1ccccc1C#N"],
  ["allene", "CC=C=CC"],
  ["porphine", "c1cc2cc3ccc(cc4ccc(cc5ccc(cc1n2)[nH]5)n4)[nH]3"],
  ["methylsulfonyl nitrobenzene", "CS(=O)(=O)c1ccc(cc1)[N+](=O)[O-]"],
  ["dipeptide", "CC(C)C[C@H](NC(=O)[C@H](Cc1ccccc1)NC(=O)C)C(=O)O"],
  ["sildenafil", "CCCc1nn(C)c2c1nc([nH]c2=O)-c1cc(ccc1OCC)S(=O)(=O)N1CCN(C)CC1"],
  ["dasatinib", "CC1=NC(=CC(=C1Cl)NC(=O)C2=CN=C(S2)NC3=CC(=NC(=N3)C)N4CCN(CC4)CCO)C"],
  ["caffeine", "CN1C=NC2=C1C(=O)N(C)C(=O)N2C"],
  ["aspirin", "CC(=O)OC1=CC=CC=C1C(=O)O"],
  ["single atom", "C"],
  ["hydrogen molecule as atoms", "[H][H]"]
];

/* inputs that must come back null — and must never throw */
const REFUSED = [
  ["81-carbon chain", "C".repeat(81)],
  ["empty", ""],
  ["unbalanced", "(((((("],
  ["emoji", "💊🧬"],
  ["9 kB of carbon", "C".repeat(9000)],
  ["unknown element", "[Xx]"],
  ["dangling ring bond", "C1CC"],
  ["aromatic open ring", "c1ccccc"],
  ["bad ring label", "C%9"],
  ["NUL byte", "\u0000C"],
  ["BOM", "\ufeffCC"],
  ["not a string", 123],
  ["null", null],
  ["object", { smiles: "CC" }],
  ["array", ["C"]],
  ["unicode confusable", "С1ССССС1"]   // Cyrillic С
];

const DIGEST_CORPUS = [...actives.map((a) => a.smiles), ...HARD.map((h) => h[1])];

function digestAll() {
  const h = createHash("sha256");
  for (const s of DIGEST_CORPUS) h.update(JSON.stringify(viewLayoutMolecule(s)) + "\n");
  return h.digest("hex");
}

if (process.argv.includes("--digest")) {
  process.stdout.write(digestAll() + "\n");
  process.exit(0);
}

/* ————— 1. structure ————— */

function validate(name, lay, mol) {
  const atomsN = mol.atoms.length;
  ok(lay.atoms.length === atomsN, `${name}: every atom is placed (${lay.atoms.length}/${atomsN})`);
  ok(lay.bonds.length === mol.bonds.length, `${name}: every bond is drawn (${lay.bonds.length}/${mol.bonds.length})`);
  ok(lay.box.w === 320 && lay.box.h === 240, `${name}: the viewBox is 320×240`);
  let finite = true, inside = true, refs = true, wavesOk = true, rounded = true;
  const inBox = (x, y) => x >= 0 && x <= 320 && y >= 0 && y <= 240;
  for (const a of lay.atoms) {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) finite = false;
    if (!inBox(a.x, a.y)) inside = false;
    if (Math.abs(a.x * 100 - Math.round(a.x * 100)) > 1e-6 || Math.abs(a.y * 100 - Math.round(a.y * 100)) > 1e-6) rounded = false;
    if (!(a.wave >= 0 && a.wave < lay.waves)) wavesOk = false;
  }
  for (const b of lay.bonds) {
    if (!Number.isInteger(b.a) || !Number.isInteger(b.b) || b.a < 0 || b.b < 0 || b.a >= atomsN || b.b >= atomsN || b.a === b.b) refs = false;
    for (const v of [b.x1, b.y1, b.x2, b.y2]) { if (!Number.isFinite(v)) finite = false; }
    if (!inBox(b.x1, b.y1) || !inBox(b.x2, b.y2)) inside = false;
    for (const o of b.offsets) { for (const v of [o.x1, o.y1, o.x2, o.y2]) { if (!Number.isFinite(v)) finite = false; if (v < -8 || v > 328) inside = false; } }
    if (!(b.wave >= 0 && b.wave < lay.waves)) wavesOk = false;
    if (b.wave !== Math.max(lay.atoms[b.a].wave, lay.atoms[b.b].wave)) wavesOk = false;
  }
  for (const r of lay.aromRings) {
    if (!Number.isFinite(r.cx) || !Number.isFinite(r.cy) || !Number.isFinite(r.r)) finite = false;
    if (!inBox(r.cx, r.cy) || r.r <= 0) inside = false;
    if (!(r.wave >= 0 && r.wave < lay.waves)) wavesOk = false;
  }
  ok(finite, `${name}: every coordinate is finite`);
  ok(inside, `${name}: every coordinate is inside the viewBox`);
  ok(rounded, `${name}: coordinates are rounded to 2 dp`);
  ok(refs, `${name}: every bond references two distinct real atoms`);
  ok(wavesOk && lay.waves >= 1 && lay.waves <= 8, `${name}: waves are 1..8 and every element sits in one (${lay.waves})`);
  ok(lay.bonds.filter((b) => b.closure).length <= 6, `${name}: at most six ring-closure paths`);
  ok(lay.aromRings.length <= 8, `${name}: at most eight aromatic circles`);
  ok(lay.counts.labels <= 48 || lay.approximate, `${name}: label count fits the pool or the layout says approximate`);
  /* no two atoms on the same point, and no bond of zero length */
  let distinct = true;
  for (let i = 0; i < lay.atoms.length; i++) for (let j = i + 1; j < lay.atoms.length; j++) {
    if (Math.abs(lay.atoms[i].x - lay.atoms[j].x) < 0.5 && Math.abs(lay.atoms[i].y - lay.atoms[j].y) < 0.5) distinct = false;
  }
  ok(distinct || lay.approximate, `${name}: no two atoms share a point`);
}

suite("layout 1 — every reference active draws");
for (const a of actives) {
  const mol = molFromSmiles(a.smiles);
  ok(!!mol, `${a.name}: the active parses`);
  if (!mol) continue;
  const lay = viewLayoutMolecule(a.smiles);
  if (mol.atoms.length > 80) { ok(lay === null, `${a.name}: > 80 atoms is refused`); continue; }
  ok(!!lay, `${a.name}: draws (${mol.atoms.length} atoms)`);
  if (!lay) continue;
  ok(!lay.approximate, `${a.name}: is constructed, not interpolated`);
  validate(a.name, lay, mol);
}

suite("layout 2 — hard structures");
const approximates = [];
for (const [name, smi] of HARD) {
  const mol = molFromSmiles(smi);
  const lay = viewLayoutMolecule(smi);
  if (!mol) { ok(lay === null, `${name}: unparseable ⇒ null`); continue; }
  if (mol.atoms.length > 80 || mol.bonds.length > 96) { ok(lay === null, `${name}: over the ceiling ⇒ null`); continue; }
  ok(!!lay, `${name}: draws`);
  if (!lay) continue;
  if (lay.approximate) approximates.push(name);
  validate(name, lay, mol);
}
console.log("   approximate (refused by the lens): " + (approximates.join(", ") || "none"));
{
  const l80 = viewLayoutMolecule("C".repeat(80));
  const l81 = viewLayoutMolecule("C".repeat(81));
  ok(l80 && l80.atoms.length === 80, "exactly 80 atoms is drawn");
  ok(l81 === null, "81 atoms is refused");
  const salt = viewLayoutMolecule("CC(=O)[O-].[Na+]");
  ok(salt && salt.counts.components === 2, "a salt is laid out as two components");
  const na = salt.atoms.find((a) => a.el === "Na");
  ok(na && na.label === "Na+", "the sodium ion is labelled with its charge (" + (na && na.label) + ")");
  const o = salt.atoms.find((a) => a.el === "O" && a.label === "O−");
  ok(!!o, "the carboxylate oxygen is labelled O−");
  const naph = viewLayoutMolecule("c1ccc2ccccc2c1");
  ok(naph && naph.aromRings.length === 2, "naphthalene has two aromatic circles");
  ok(naph && naph.atoms.every((a) => !a.label), "carbons are bare vertices");
  ok(naph && naph.bonds.every((b) => b.offsets.length === 0), "aromatic bonds carry no second line");
  const ac = viewLayoutMolecule("CC(=O)O");
  ok(ac && ac.bonds.some((b) => b.order === 2 && b.offsets.length === 1), "a double bond carries one offset line");
  const yne = viewLayoutMolecule("CC#N");
  ok(yne && yne.bonds.some((b) => b.order === 3 && b.offsets.length === 2), "a triple bond carries two offset lines");
  const nh = viewLayoutMolecule("c1ccc2[nH]ccc2c1");
  ok(nh && nh.atoms.some((a) => a.label === "NH"), "hydrogens ride on labels (NH)");
  const am = viewLayoutMolecule("CC(N)=O");
  ok(am && am.atoms.some((a) => a.label === "NH2"), "…and NH2");
  const ring = viewLayoutMolecule("C1CCCCC1");
  const d = [];
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
    const a = ring.atoms[i], b = ring.atoms[j];
    d.push(Math.hypot(a.x - b.x, a.y - b.y));
  }
  const edge = Math.min(...d);
  ok(ring && ring.bonds.every((b) => Math.abs(Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - edge) < 0.6),
     "cyclohexane is a regular hexagon (every bond the same length)");
  const bi = viewLayoutMolecule("c1ccccc1-c1ccccc1");
  ok(bi && bi.counts.systems === 2 && bi.aromRings.length === 2, "biphenyl: two ring systems, both aromatic");
  const chain = viewLayoutMolecule("CCCCCC");
  ok(chain && chain.waves === 6, "a six-carbon chain grows in six waves");
  const big = viewLayoutMolecule("C".repeat(80));
  ok(big && big.waves === 8, "a long chain is capped at eight waves");
}

/* ————— 3. never throws ————— */
suite("layout 3 — hostile input never throws");
for (const [name, input] of REFUSED) {
  let out = "threw";
  try { out = viewLayoutMolecule(input); } catch (e) { out = "threw:" + e.message; }
  ok(out === null, `${name}: null, not a throw (${String(out).slice(0, 40)})`);
}

/* ————— 4. determinism ————— */
suite("layout 4 — byte-identical across runs and across processes");
const first = DIGEST_CORPUS.map((s) => JSON.stringify(viewLayoutMolecule(s)));
const second = DIGEST_CORPUS.map((s) => JSON.stringify(viewLayoutMolecule(s)));
ok(first.every((j, i) => j === second[i]), "two runs in one process produce byte-identical JSON for every molecule");
/* interleave with other work, then again */
for (const s of ["CCO", "c1ccccc1", "C".repeat(40)]) viewLayoutMolecule(s);
const third = DIGEST_CORPUS.map((s) => JSON.stringify(viewLayoutMolecule(s)));
ok(first.every((j, i) => j === third[i]), "…and after unrelated layouts in between");
const mine = digestAll();
let theirs = "";
try { theirs = execFileSync(process.execPath, [SELF, "--digest"], { encoding: "utf8" }).trim(); } catch (e) { theirs = "spawn failed: " + e.message; }
ok(theirs === mine, `a second process computes the same digest\n      here:  ${mine}\n      there: ${theirs}`);

/* ————— 5. the budget ————— */
suite("layout 5 — performance (≤ 4 ms each, ≤ 1.5 ms median)");
const TIMED = [...actives.map((a) => [a.name, a.smiles]), ...HARD];
for (let w = 0; w < 3; w++) for (const [, s] of TIMED) viewLayoutMolecule(s);   // warm the JIT, as a running page is
const times = [];
for (const [name, s] of TIMED) {
  let best = Infinity;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    viewLayoutMolecule(s);
    best = Math.min(best, performance.now() - t0);
  }
  times.push({ name, ms: best });
}
times.sort((a, b) => a.ms - b.ms);
const median = times[Math.floor(times.length / 2)].ms;
const worst = times[times.length - 1];
console.log(`   ${times.length} molecules · median ${median.toFixed(3)} ms · slowest ${worst.ms.toFixed(3)} ms (${worst.name})`);
console.log("   slowest five: " + times.slice(-5).reverse().map((t) => `${t.name} ${t.ms.toFixed(2)}`).join(" · "));
ok(worst.ms <= 4, `every layout is ≤ 4 ms (slowest ${worst.ms.toFixed(3)} ms — ${worst.name})`);
ok(median <= 1.5, `the median layout is ≤ 1.5 ms (${median.toFixed(3)} ms)`);

console.log(failed ? "layout: " + failed + " FAILED of " + checks : "layout: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
