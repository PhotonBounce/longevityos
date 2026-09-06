/* score.js — THE SCREENING CORE.
 *
 * This is the function every volunteer's browser runs and the one place where
 * the swarm's trust model lives: two strangers' machines must produce the same
 * digest for the same work unit, or the result is thrown away. That makes
 * DETERMINISM a correctness requirement here, not a nicety:
 *
 *   - the composite score is INTEGER arithmetic end to end (Tanimoto arrives
 *     as integer per-mille from fingerprint.js, and nothing else is summed);
 *   - descriptor floats (mw, clogp, tpsa) are only ever COMPARED against
 *     thresholds, never accumulated into the score — a comparison of two
 *     IEEE754 doubles is exact everywhere, an accumulation order is not;
 *   - no Math.random, no Date.now, no Math.log/exp/pow, no locale formatting;
 *   - every iteration order that could differ between engines is sorted
 *     explicitly before it reaches the digest.
 *
 * What this actually computes, stated honestly: LIGAND-BASED SIMILARITY
 * SCREENING. "This candidate looks structurally like drugs that did something
 * in a longevity experiment, and it isn't obviously undruggable or obviously
 * reactive." That is a triage shortlist for a human researcher. It is not
 * docking, not a binding prediction, not an efficacy claim, and not evidence
 * that any molecule does anything in any living thing.
 */

import { molecularFormula } from "./smiles.js";
/* molFromSmiles = parse + aromaticity perception. Never call parseSmiles
 * directly on the screening path: an un-normalised graph compares SMILES
 * spellings instead of structures, and benzene stops matching benzene. */
import { molFromSmiles as parseSmiles } from "./aromatic.js";
import { morganFingerprint, tanimotoMilli } from "./fingerprint.js";
import { descriptors } from "./descriptors.js";
import { structuralAlerts } from "./alerts.js";
import { sha256Hex } from "./digest.js";
import { ENGINE_VERSION, TARGETS, targetsDigest } from "./targets.js";

export { ENGINE_VERSION };

/* ————— scoring constants (documented so a reviewer can argue with them) ————— */

/* A candidate's headline signal is its closeness to the single most similar
 * reference active, per-mille. Everything else only ever subtracts from it or
 * adds a small corroboration bonus, so the score can never claim more than the
 * similarity evidence supports. */
const CORROBORATION_DIVISOR = 8;   // second-best target similarity / 8, max +125
const LIPINSKI_PENALTY = 60;       // per violation, out of 1000
const VEBER_PENALTY = 40;          // per violation
const ALERT_PENALTY = 50;          // per structural alert, capped below
const MAX_ALERT_PENALTY = 200;
const MIN_FACTOR = 250;            // a molecule is never penalised below 25% of its similarity

/* Lipinski's rule of five + Veber's oral-bioavailability rules. These are
 * heuristics about drug-likeness, not laws; they are here to push obviously
 * un-oral molecules down a triage list, and they are reported as flags so a
 * human can disagree with any individual call. */
function ruleFlags(d) {
  const flags = [];
  if (d.mw > 500) flags.push("mw");
  if (d.clogp > 5) flags.push("logp");
  if (d.hbd > 5) flags.push("hbd");
  if (d.hba > 10) flags.push("hba");
  if (d.rotb > 10) flags.push("rotb");
  if (d.tpsa > 140) flags.push("tpsa");
  return flags;
}

const LIPINSKI = ["mw", "logp", "hbd", "hba"];
const VEBER = ["rotb", "tpsa"];

/* ————— the reference set ————— */

/* Fingerprinting every reference active on every molecule would be wasteful and
 * — more importantly — a chance for drift. Build it once per worker, keep it
 * ordered by target id and active name so two clients iterate identically. */
export function referenceSet() {
  const targets = [];
  for (const t of [...TARGETS].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const actives = [];
    /* name THEN cid — the same key targetsDigest() sorts by. Sorting on name
     * alone leaves two same-named actives in input order here and in digest
     * order there, so the reference set and the digest that is supposed to
     * describe it could disagree. */
    for (const a of [...(t.actives || [])].sort((x, y) =>
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0) ||
      (String(x.cid) < String(y.cid) ? -1 : String(x.cid) > String(y.cid) ? 1 : 0))) {
      const mol = parseSmiles(a.smiles);
      if (!mol) continue;             // a reference we cannot parse is dropped, never guessed at
      actives.push({ name: a.name, cid: String(a.cid), fp: morganFingerprint(mol, 2) });
    }
    if (actives.length) targets.push({ id: t.id, name: t.name, actives });
  }
  return { engine: ENGINE_VERSION, targetsDigest: targetsDigest(), targets };
}

/* ————— one molecule ————— */

export function screenMolecule(smiles, refs) {
  if (typeof smiles !== "string" || !smiles.length) {
    return { ok: false, reason: "empty", score: 0, best: null, flags: ["unparseable"] };
  }
  const mol = parseSmiles(smiles);
  if (!mol) return { ok: false, reason: "unparseable", score: 0, best: null, flags: ["unparseable"] };

  const d = descriptors(mol);
  if (!d) return { ok: false, reason: "undescribable", score: 0, best: null, flags: ["unparseable"] };

  const fp = morganFingerprint(mol, 2);

  /* per-target similarity = the best match among that target's actives */
  const perTarget = [];
  for (const t of refs.targets) {
    let bestSim = 0, bestActive = null;
    for (const a of t.actives) {
      const sim = tanimotoMilli(fp, a.fp);
      /* strict > keeps the FIRST active on a tie, and actives are sorted by
       * name in referenceSet(), so ties resolve identically everywhere */
      if (sim > bestSim) { bestSim = sim; bestActive = a.name; }
    }
    perTarget.push({ target: t.id, sim: bestSim, active: bestActive });
  }
  /* sort by similarity desc, then target id asc — never leave a tie to insertion order */
  perTarget.sort((x, y) => (y.sim - x.sim) || (x.target < y.target ? -1 : x.target > y.target ? 1 : 0));

  const top = perTarget[0] || { target: null, sim: 0, active: null };
  const second = perTarget[1] || { sim: 0 };

  const flags = ruleFlags(d);
  const alerts = structuralAlerts(mol);

  const lipinski = flags.filter((f) => LIPINSKI.includes(f)).length;
  const veber = flags.filter((f) => VEBER.includes(f)).length;
  const alertPenalty = Math.min(alerts.length * ALERT_PENALTY, MAX_ALERT_PENALTY);

  let factor = 1000 - lipinski * LIPINSKI_PENALTY - veber * VEBER_PENALTY - alertPenalty;
  if (factor < MIN_FACTOR) factor = MIN_FACTOR;

  const corroboration = Math.floor(second.sim / CORROBORATION_DIVISOR);
  let score = Math.floor((top.sim * factor) / 1000) + corroboration;
  if (score > 1000) score = 1000;
  if (score < 0) score = 0;

  return {
    ok: true,
    score,
    best: top.target,
    bestActive: top.active,
    bestSim: top.sim,
    perTarget,
    desc: d,
    alerts,
    flags,
    formula: molecularFormula(mol)
  };
}

/* ————— one work unit ————— */

/* The digest is the whole trust model in one string. It covers the engine
 * version, the reference set, the unit id and every per-molecule verdict, in a
 * fixed order, so two clients agreeing on the digest have agreed on all of it —
 * and a client running a different engine build can never accidentally
 * "confirm" another's work. */
export function screenUnit(unit, refs) {
  /* A work unit arrives over the network, so it is untrusted data: a hostile or
   * corrupted one can carry throwing getters or a toString that explodes.
   * Reading it must not be able to kill a volunteer's screening loop. */
  let molecules = [], rawId = "";
  try { molecules = Array.isArray(unit && unit.molecules) ? unit.molecules : []; } catch (_) { molecules = []; }
  try { rawId = unit && unit.unit_id !== undefined ? String(unit.unit_id) : ""; } catch (_) { rawId = ""; }
  const results = [];
  for (const m of molecules) {
    let id = "", smi = null;
    try { id = m && m.id !== undefined ? String(m.id) : ""; } catch (_) { id = ""; }
    try { smi = m && m.smiles; } catch (_) { smi = null; }
    const r = screenMolecule(smi, refs);
    results.push({
      id,
      score: r.score,
      best: r.ok ? r.best : null,
      flags: [...r.flags, ...(r.ok ? r.alerts : [])].sort()
    });
  }
  /* Sort by id, then by the rest of the tuple. Ids are supposed to be unique
   * within a unit, but a server bug or a hostile unit could repeat one, and a
   * comparator that returns 0 for those leaves their order to the engine's
   * sort stability — which is exactly the kind of "works on my machine"
   * difference that would make two honest volunteers disagree forever. */
  results.sort((a, b) =>
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
    (a.score - b.score) ||
    (String(a.best) < String(b.best) ? -1 : String(a.best) > String(b.best) ? 1 : 0) ||
    (a.flags.join("+") < b.flags.join("+") ? -1 : a.flags.join("+") > b.flags.join("+") ? 1 : 0)
  );

  const canon = [refs.engine, refs.targetsDigest, rawId].join("|") + "#" + results
    .map((r) => `${r.id}:${r.score}:${r.best === null ? "-" : r.best}:${r.flags.join("+")}`)
    .join(";");

  return {
    engine: refs.engine,
    unitId: rawId,
    targetsDigest: refs.targetsDigest,
    digest: sha256Hex(canon),
    results
  };
}
