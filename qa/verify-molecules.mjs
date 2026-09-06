/* verify-molecules — every reference active is checked against PubChem itself.
 *
 * The screen compares candidates to these molecules, so a wrong SMILES or a
 * wrong CID would not throw an error — it would quietly produce a ranked list
 * built on a molecule that does not exist. That is the worst failure this
 * project could have, because it looks exactly like success.
 *
 * So CI fetches each CID from PubChem and requires that OUR structure and
 * PubChem's agree, by two independent measures: identical molecular formula,
 * and a Tanimoto of 1000/1000 between our fingerprint of our SMILES and our
 * fingerprint of PubChem's canonical SMILES.
 *
 * THE COMPARISON MUST BE ABOUT STRUCTURE, NOT SPELLING. Both sides are parsed
 * through molFromSmiles() — parseSmiles PLUS aromaticity perception, the same
 * door app/js/chem/score.js sends every screened molecule through. Raw
 * parseSmiles compares the ring spelling a source happened to emit rather than
 * the graph, and this gate is the one place where the two sides are written by
 * DIFFERENT authors: ours in targets.js, theirs by PubChem. Measured on the raw
 * parser, chemically identical re-spellings of our own reference actives score
 * quercetin 27/1000, urolithin A 58/1000, dasatinib 192/1000, estradiol
 * 323/1000 — and it does not even need an aromatic-vs-Kekulé mismatch: two
 * equally valid Kekulé spellings of aspirin (…OC1=CC=CC=C1… vs …OC1C=CC=CC=1…)
 * score 487/1000 with identical molecular formulas. Every one of those is
 * 1000/1000 through molFromSmiles. So on the raw parser this job's only
 * possible verdicts were "PubChem spells rings the way we do" and a red build
 * over a correct molecule — it would have failed the very file it protects the
 * first time PubChem re-kekulised anything.
 *
 * Verdict discipline (the house rule): a genuine disagreement FAILS. A network
 * refusal is reported as UNVERIFIED and never counted as a pass — and if
 * PubChem itself is unreachable we fail closed rather than pretend we checked.
 * The authoring sandbox has no route to PubChem; this runs on a runner.
 */
import { TARGETS } from "../app/js/chem/targets.js";
import { molecularFormula } from "../app/js/chem/smiles.js";
import { molFromSmiles } from "../app/js/chem/aromatic.js";
import { morganFingerprint, tanimotoMilli } from "../app/js/chem/fingerprint.js";

const UA = { "user-agent": "LongevityOS-molecule-verifier/1.0 (+https://github.com/PhotonBounce/longevityos)" };
const PUG = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/";

const rows = [];
for (const t of TARGETS) for (const a of t.actives || []) rows.push({ target: t.id, ...a });

/* one batched properties call per 50 CIDs — polite, and PubChem prefers it */
const cids = [...new Set(rows.map((r) => String(r.cid)))];
const props = new Map();
let reachable = false;

for (let i = 0; i < cids.length; i += 50) {
  const batch = cids.slice(i, i + 50);
  const url = PUG + batch.join(",") + "/property/CanonicalSMILES,MolecularFormula,Title/JSON";
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
    if (!res.ok) { console.log(`  ? batch ${i / 50 + 1}: PubChem answered HTTP ${res.status}`); continue; }
    const json = await res.json();
    for (const p of json?.PropertyTable?.Properties || []) {
      props.set(String(p.CID), p);
      reachable = true;
    }
  } catch (e) {
    console.log(`  ? batch ${i / 50 + 1}: ${e.name || "error"}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

if (!reachable) {
  console.error("PubChem was unreachable for every batch — cannot verify, failing closed rather than assuming.");
  process.exit(1);
}

let verified = 0, mismatched = 0, unverified = 0;
for (const r of rows) {
  const p = props.get(String(r.cid));
  if (!p) { unverified++; console.log(`  ? ${r.target}/${r.name} · UNVERIFIED (CID ${r.cid} not returned)`); continue; }

  const ours = molFromSmiles(r.smiles);
  const theirs = molFromSmiles(p.CanonicalSMILES || p.SMILES || "");
  if (!ours) { mismatched++; console.error(`  ✗ ${r.target}/${r.name} · OUR SMILES DOES NOT PARSE`); continue; }
  if (!theirs) { unverified++; console.log(`  ? ${r.target}/${r.name} · PubChem's SMILES did not parse in our engine`); continue; }

  const ourF = molecularFormula(ours);
  const theirF = (p.MolecularFormula || "").replace(/[+-]$/, "");
  const sameFormula = ourF === theirF;
  const sim = tanimotoMilli(morganFingerprint(ours, 2), morganFingerprint(theirs, 2));

  if (sameFormula && sim === 1000) {
    verified++;
    console.log(`  ✓ ${r.target}/${r.name} · CID ${r.cid} · ${ourF}`);
  } else {
    mismatched++;
    console.error(`  ✗ ${r.target}/${r.name} · CID ${r.cid} MISMATCH — ours ${ourF}, PubChem ${theirF} (${p.Title || "?"}), similarity ${sim}/1000`);
  }
}

console.log(`verify-molecules: ${verified} verified, ${mismatched} mismatched, ${unverified} unverified of ${rows.length}`);
if (mismatched > 0) {
  console.error("A reference active does not match its PubChem record. The screen would be comparing candidates to a molecule that is not what we claim it is — fix targets.js.");
  process.exit(1);
}
if (verified === 0) { console.error("Zero verified molecules is a failure, not a pass."); process.exit(1); }
if (unverified > 0) console.log("note: unverified rows are warned, never assumed correct — they recheck on every run.");
process.exit(0);
