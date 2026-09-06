/* harvest — THE SUPPLY SIDE OF THE SWARM.
 *
 * Every day this job asks PubChem for molecules that look like the reference
 * actives in app/js/chem/targets.js, filters them through the app's OWN parser
 * and drug-likeness rules, and ingests the survivors into the swarm server as
 * candidates for volunteers to screen.
 *
 * WHY IT LIVES ON A RUNNER. The authoring sandbox has no route to
 * pubchem.ncbi.nlm.nih.gov, so nothing here may assume a live network. The
 * offline selftest drives the ENTIRE pipeline against recorded fixtures with
 * `fetch` replaced by a landmine, which is what CI runs on every push.
 *
 * WHAT THIS JOB WILL NOT DO.
 *   * It never fabricates. A search or property call that fails is logged, the
 *     active is skipped, and the run continues — the harvested count is always
 *     the number of molecules actually retrieved, never a target that was aimed
 *     for. There is no "expected" number anywhere in this file.
 *   * It never silently drops a harvest. EVERY run — delivered, undeliverable
 *     or partial — writes the whole harvest, and the reasons every rejected
 *     molecule was rejected, to data/harvest-latest.json. If the server
 *     endpoint or the ingest key is missing the log says, in those words, that
 *     nothing was ingested; and if one of the two is set and the other is not,
 *     that is a misconfiguration, so the run exits non-zero rather than going
 *     green while the swarm is never fed.
 *   * It never throws on hostile input. PubChem returning HTML, a truncated
 *     body, a null CID, a SMILES made of brackets — every one of those is a
 *     counted rejection, not an exception that kills the run.
 *   * It makes no claim about any molecule. A candidate here is a structure a
 *     volunteer's browser will compare against the reference set. That is all.
 *
 * DETERMINISM. This tool is NOT on the screening path — the swarm's digest is
 * computed in app/js/chem/score.js, in the visitor's browser — so a clock and a
 * network live here quite legally. What it does share with the screening path
 * is THE FRONT DOOR: a candidate is admitted only if molFromSmiles() in
 * app/js/chem/aromatic.js can read it, which is the same call score.js makes,
 * so a molecule that would explode in a worker never reaches a work unit and
 * "the same structure" means the same thing on both sides.
 *
 * Zero dependencies: node: builtins and the app's own ES modules.
 *
 *   node tools/harvest.mjs            live harvest, ingest to $LOS_API
 *   node tools/harvest.mjs --dry-run  live fetches, print what WOULD be ingested
 *   node tools/harvest.mjs --selftest offline, fixtures only, no fetch at all
 *
 * A CLI FIRST, A MODULE SECOND — and importing it must be INERT. Everything
 * below is a named ES export so QA can drive the pipeline offline; the entry
 * block at the bottom runs only when node was pointed at this file directly,
 * and it owns the only process.exit() in the module.
 */

import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { TARGETS, ENGINE_VERSION, targetsDigest } from "../app/js/chem/targets.js";
/* THE FRONT DOOR. molFromSmiles = parseSmiles + aromaticity perception, and it
 * is the SAME door app/js/chem/score.js sends every screened molecule through.
 * Never import parseSmiles here: the harvester would then fingerprint
 * un-normalised graphs and its notion of "the same structure" would stop being
 * the swarm's. Measured before this import was corrected: benzene Kekulé vs
 * benzene aromatic scored 0/1000 on the harvester's path and 1000/1000 on the
 * swarm's, so a reference active spelled the other way was harvested as a
 * novel candidate. */
import { molFromSmiles as parseSmiles } from "../app/js/chem/aromatic.js";
import { molecularFormula, heavyAtomCount } from "../app/js/chem/smiles.js";
import { morganFingerprint, tanimotoMilli, FP_WORDS } from "../app/js/chem/fingerprint.js";
import { descriptors } from "../app/js/chem/descriptors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURES = join(ROOT, "qa", "fixtures");
const OUT_FILE = join(ROOT, "data", "harvest-latest.json");

/* ————————————————————————————— policy ————————————————————————————— */

export const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound";

/* PubChem asks for no more than 5 requests a second and a courteous
 * User-Agent that identifies the caller. We take both seriously: a scheduled
 * job that gets a public data source angry is a job that stops working. */
export const USER_AGENT =
  "LongevityOS-harvester/1.0 (citizen-science molecule screening; " +
  "https://photon-bounce.com/longevityos/; contact via that site)";
export const REQ_PAUSE_MS = 250;   // minimum gap between calls
export const MAX_RPS = 5;          // hard ceiling, enforced with a sliding window
export const REQ_TIMEOUT_MS = 30000;
export const REQ_RETRIES = 1;      // one retry, then give up on that active

export const SIMILARITY_THRESHOLD = 85; // PubChem 2D Tanimoto, percent
export const PROP_BATCH = 100;     // CIDs per property call
export const INGEST_CHUNK = 200;   // molecules per ?a=ingest POST (server cap is 500)

/* Filter thresholds. Deliberately loose: this is a "could a screen say anything
 * useful about it" gate, not a drug-likeness opinion. Salts and fragments below
 * 60 Da carry no shape to compare.
 *
 * THE CEILING IS A MEASURED NUMBER, NOT A HUNCH. It used to be 900 Da with a
 * comment claiming the Morgan fingerprint "saturates" above that. Measured: it
 * does not — rapamycin (914.19 Da) sets 111 of 1024 bits, 11% occupancy. What
 * 900 Da really did was refuse the two mTOR reference actives themselves
 * (rapamycin 914.19, everolimus 958.24), so the target targets.js calls the
 * most replicated pharmacological lifespan result in mammals harvested exactly
 * zero candidates, forever, while still spending its searches every day.
 * 1000 Da clears everolimus with headroom, and selftest section 4c now asserts
 * that NO reference active is ever refused by this gate again — a reference set
 * the harvester's own filter would throw out is a contradiction, and the gate
 * says so out loud instead of printing "60 similar, 0 accepted". */
export const MW_MIN = 60;
export const MW_MAX = 1000;
export const MIN_HEAVY = 5;
export const SMILES_MAX = 200;     // the server stores at most this many chars

/* ————————————————————————— small pure helpers ————————————————————————— */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Split an array into runs of at most n. Never throws; n<1 is treated as 1. */
export function chunk(arr, n) {
  const size = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const list = Array.isArray(arr) ? arr : [];
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * A finite number or null. Accepts PubChem's stringified weights — but only in
 * the spelling PubChem actually uses. Number() is far more generous than JSON
 * is: it reads "0x10" as 16, "1e3" as 1000, "0b101" as 5 and " 12 " as 12.
 * Anchoring the string form means a garbled weight is reported as unknown
 * rather than quietly becoming a plausible-looking number.
 */
const NUMERIC_RE = /^-?[0-9]+(\.[0-9]+)?$/;
function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || !NUMERIC_RE.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A positive integer CID or null. Rejects floats, negatives, junk, huge ids.
 *
 * A CID is not a quantity, it is an IDENTITY: it is the molecules table's
 * primary key and the PubChem record a researcher will open. Coercing "0x10"
 * into CID 16 attaches a real structure to somebody else's compound record —
 * the quiet wrongness targets.js's preamble is written against. So the string
 * form must be exactly the canonical decimal spelling, with no sign, no
 * exponent, no radix prefix and no surrounding whitespace.
 */
const CID_RE = /^[0-9]{1,12}$/;
function cidOf(v) {
  if (typeof v === "string" && !CID_RE.test(v)) return null;
  const n = num(v);
  if (n === null) return null;
  if (!Number.isInteger(n) || n <= 0 || n > 1e12) return null;
  return n;
}

/**
 * CIDs out of a fastsimilarity_2d response.
 * Real shape: { "IdentifierList": { "CID": [ ... ] } }.
 * Anything else — an error envelope, HTML, null, a string — yields [].
 */
export function parseSimilarityResponse(json) {
  const list = json && json.IdentifierList && json.IdentifierList.CID;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const cid = cidOf(v);
    if (cid === null || seen.has(cid)) continue;
    seen.add(cid);
    out.push(cid);
  }
  return out;
}

/**
 * Rows out of a property response.
 * Real shape: { "PropertyTable": { "Properties": [ { CID, CanonicalSMILES,
 * MolecularFormula, MolecularWeight } ] } }.
 *
 * PubChem has renamed this column before (CanonicalSMILES -> SMILES /
 * ConnectivitySMILES), so all three spellings are read. A row with no usable
 * SMILES still comes back — with smiles:null — so the filter can COUNT it
 * rather than the parser quietly losing it.
 */
export function parsePropertyResponse(json) {
  const rows = json && json.PropertyTable && json.PropertyTable.Properties;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const cid = cidOf(r.CID);
    if (cid === null) continue;
    let smi = r.CanonicalSMILES;
    if (typeof smi !== "string") smi = r.SMILES;
    if (typeof smi !== "string") smi = r.ConnectivitySMILES;
    out.push({
      cid,
      smiles: typeof smi === "string" && smi.trim() !== "" ? smi.trim() : null,
      formula: typeof r.MolecularFormula === "string" ? r.MolecularFormula.trim() : "",
      mw: num(r.MolecularWeight)
    });
  }
  return out;
}

/* ———————————————————— the reference set we filter against ———————————————————— */

/**
 * Every reference active, flattened, with its fingerprint precomputed.
 *
 * Two molecules count as "the same" here if they share a molecular formula AND
 * a 1000/1000 Morgan match on the NORMALISED graph. That is an APPROXIMATION of
 * structural identity, not a canonical form: the fingerprint is stereo-blind by
 * construction, so a candidate that differs from an active only in
 * stereochemistry is dropped as a duplicate. That is the right trade for this
 * job — the screen cannot tell the two apart either, so shipping the epimer
 * would spend a volunteer's CPU proving that an active is similar to itself.
 *
 * THE SAME RULE RUNS IN BOTH DIRECTIONS. It decides whether a candidate IS a
 * reference active, and (in filterCandidates, against the run's own structure
 * index) whether a candidate is a sibling of one already harvested. A notion of
 * identity good enough to throw out an active but not good enough to throw out
 * a duplicate candidate is not a decision, it is an oversight.
 */
export function referenceIndex() {
  const cids = new Set();
  const byFormula = new Map();
  const names = new Map();
  for (const t of TARGETS) {
    for (const a of t.actives) {
      const cid = cidOf(a.cid);
      if (cid !== null) {
        cids.add(cid);
        if (!names.has(cid)) names.set(cid, a.name);
      }
      const mol = parseSmiles(a.smiles);
      if (!mol) continue; // targets.js is CI-verified; a bad row must not kill the harvest
      const f = molecularFormula(mol);
      const entry = { name: a.name, fp: morganFingerprint(mol, 2) };
      if (!byFormula.has(f)) byFormula.set(f, []);
      byFormula.get(f).push(entry);
    }
  }
  return { cids, byFormula, names };
}

/** Name of the reference active this molecule IS, or null. */
function duplicateOfActive(byFormula, fp, formula) {
  const bucket = byFormula.get(formula);
  if (!bucket) return null;
  for (const e of bucket) if (tanimotoMilli(fp, e.fp) === 1000) return e.name;
  return null;
}

/**
 * A stable key for "the graph the swarm will actually screen".
 *
 * Formula plus the normalised Morgan bits, which is the same approximation of
 * structural identity duplicateOfActive() already uses against the reference
 * set — carrying the formula as well is free and stops two molecules that
 * merely happen to fold onto the same bits from being merged.
 */
function structureKey(fp, formula) {
  let hex = "";
  for (let i = 0; i < FP_WORDS; i++) hex += (fp[i] >>> 0).toString(16).padStart(8, "0");
  return formula + ":" + hex;
}

/* Structural dedupe has to live as long as the CID dedupe does — a whole run,
 * across every batch and every target — but filterCandidates' signature is
 * fixed, so the structure index hangs off the caller's own `seen` Set. Same
 * lifetime, same ownership, no new parameter: a fresh `seen` (a test, the next
 * run) automatically gets a fresh index. */
const structureIndex = new WeakMap();
function structuresFor(seen) {
  let s = structureIndex.get(seen);
  if (!s) { s = new Map(); structureIndex.set(seen, s); }
  return s;
}

/* ————————————————————————————— the filter ————————————————————————————— */

export const REJECTIONS = [
  "no_smiles",           // PubChem gave us no structure column
  "smiles_too_long",     // longer than the server will store
  "unparseable",         // our own parser refused it
  "no_carbon",           // not an organic candidate
  "too_few_heavy",       // a fragment, nothing to compare
  "mw_out_of_range",     // too small to have shape, or too big for the fingerprint
  "duplicate_cid",       // already harvested this run
  "duplicate_structure", // a different CID carrying a graph we already harvested
  "is_reference"         // it IS a reference active; screening it proves nothing
];

/**
 * Filter raw property rows down to molecules worth a volunteer's CPU.
 *
 * @param {Array} rows      output of parsePropertyResponse
 * @param {object} ref      output of referenceIndex()
 * @param {Set<number>} seen CIDs already accepted this run (mutated)
 * @param {string} target   the target id these rows were found under
 * @returns {{accepted: Array, rejected: object, notes: Array}}
 */
export function filterCandidates(rows, ref, seen, target = "") {
  /* Hostile-input rule: an exported function may not throw because its caller
   * handed it the wrong shape. A malformed reference index degrades to an EMPTY
   * one, which is the safe direction — nothing is silently treated as a
   * reference active, every row is judged on its own structure. */
  const refCids = ref && ref.cids instanceof Set ? ref.cids : new Set();
  const refByFormula = ref && ref.byFormula instanceof Map ? ref.byFormula : new Map();
  const refNames = ref && ref.names instanceof Map ? ref.names : new Map();
  if (!seen || typeof seen.has !== "function" || typeof seen.add !== "function") seen = new Set();
  const seenStructures = structuresFor(seen);

  const accepted = [];
  const rejected = Object.fromEntries(REJECTIONS.map((r) => [r, 0]));
  const notes = [];
  const drop = (cid, reason, detail) => {
    rejected[reason] = (rejected[reason] || 0) + 1;
    if (notes.length < 200) notes.push({ cid, reason, detail: detail || "" });
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;

    /* Read the row ONCE, behind a guard. Ordinary rows come from
     * parsePropertyResponse and are plain data, but filterCandidates is
     * exported and a caller's object can carry a property accessor that throws
     * — reading it inline would end the harvest on somebody else's exception. */
    let rawCid, rawSmiles, rawMw;
    try {
      rawCid = row.cid; rawSmiles = row.smiles; rawMw = row.mw;
    } catch (e) {
      continue;
    }

    const cid = cidOf(rawCid);
    if (cid === null) continue;

    if (seen.has(cid)) { drop(cid, "duplicate_cid"); continue; }
    if (refCids.has(cid)) { drop(cid, "is_reference", "by-cid:" + (refNames.get(cid) || "?")); continue; }
    if (typeof rawSmiles !== "string" || rawSmiles === "") { drop(cid, "no_smiles"); continue; }
    if (rawSmiles.length > SMILES_MAX) { drop(cid, "smiles_too_long"); continue; }

    let mol = null;
    try {
      mol = parseSmiles(rawSmiles);
    } catch (e) {
      // parseSmiles is contracted to return null, never throw. Belt and braces:
      // one malformed row may not end a harvest.
      mol = null;
    }
    if (!mol) { drop(cid, "unparseable"); continue; }

    let formula = "";
    let heavy = 0;
    let ownMw = null;
    try {
      formula = molecularFormula(mol);
      heavy = heavyAtomCount(mol);
      ownMw = num(descriptors(mol).mw);
    } catch (e) {
      drop(cid, "unparseable", "descriptor failure");
      continue;
    }

    if (!mol.atoms.some((a) => a.el === "C")) { drop(cid, "no_carbon"); continue; }
    if (heavy < MIN_HEAVY) { drop(cid, "too_few_heavy", String(heavy)); continue; }

    // PubChem's weight is preferred because it is what a researcher will see in
    // PubChem; our own is the fallback when the column is absent or unreadable.
    const mw = rawMw !== null && rawMw !== undefined ? num(rawMw) : ownMw;
    const useMw = mw === null ? ownMw : mw;
    if (useMw === null || useMw < MW_MIN || useMw > MW_MAX) {
      drop(cid, "mw_out_of_range", useMw === null ? "unknown" : String(useMw));
      continue;
    }

    let fp = null;
    try {
      fp = morganFingerprint(mol, 2);
    } catch (e) {
      drop(cid, "unparseable", "fingerprint failure");
      continue;
    }

    const dupName = duplicateOfActive(refByFormula, fp, formula);
    if (dupName) { drop(cid, "is_reference", "by-structure:" + dupName); continue; }

    /* The same decision, applied in the other direction. The screen is
     * stereo-blind by construction, so a stereoisomer family (catechin /
     * epicatechin / gallocatechin; the 17-alpha / 17-beta estradiol pair
     * targets.js names by hand) collapses to ONE graph — and PubChem's
     * fastsimilarity_2d at 85% returns exactly those families together. If
     * structural identity is good enough to exclude a reference ACTIVE, it is
     * good enough to exclude a sibling CANDIDATE: otherwise volunteers spend
     * CPU screening one molecule N times and ?a=hits fills the researcher's
     * shortlist with N copies of one skeleton. The FIRST CID wins — it is the
     * one a researcher will look up. */
    const skey = structureKey(fp, formula);
    const firstCid = seenStructures.get(skey);
    if (firstCid !== undefined) {
      drop(cid, "duplicate_structure", "same-graph-as-cid:" + firstCid);
      continue;
    }
    seenStructures.set(skey, cid);

    seen.add(cid);
    accepted.push({
      cid: String(cid),
      smiles: rawSmiles,
      // Our formula, not PubChem's: it is what the app will display, and it is
      // computed from the structure the swarm will actually screen.
      formula,
      source: "harvest",
      target
    });
  }

  return { accepted, rejected, notes };
}

/* ————————————————————————————— the network ————————————————————————————— */

/* A sliding-window limiter on top of a flat pause. The pause alone already
 * bounds us at 4/s, but the window is what keeps a future parallel version
 * honest. */
const recent = [];
async function throttle() {
  await sleep(REQ_PAUSE_MS);
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 1000) recent.shift();
    if (recent.length < MAX_RPS) { recent.push(now); return; }
    await sleep(1000 - (now - recent[0]) + 5);
  }
}

/**
 * GET JSON from PubChem, politely. Times out at 30s and retries once. Returns
 * the parsed body, or throws — every caller catches and continues.
 */
async function getJson(url) {
  let lastErr = null;
  for (let attempt = 0; attempt <= REQ_RETRIES; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS)
      });
      // 404 from PUG-REST means "no hits", which is an answer, not a failure.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error("non-JSON body (" + text.slice(0, 60).replace(/\s+/g, " ") + ")");
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("unknown fetch failure");
}

async function similarCids(cid, maxRecords) {
  const url =
    PUBCHEM + "/fastsimilarity_2d/cid/" + cid + "/cids/JSON?Threshold=" +
    SIMILARITY_THRESHOLD + "&MaxRecords=" + maxRecords;
  const json = await getJson(url);
  /* FAIL CLOSED ON THE ASYNC PATH. PUG-REST may answer a similarity search with
   * 202 and a ListKey to poll instead of an IdentifierList. That body parses
   * fine and yields zero CIDs — indistinguishable, in the log, from a genuine
   * "nothing is similar to this molecule". If PubChem ever switched this
   * endpoint to async wholesale, the harvest would go quietly empty while every
   * run stayed green. A queued answer is not an answer: it is a failure, it is
   * counted as one, and the run says so. */
  if (json && typeof json === "object" && !Array.isArray(json) &&
      (json.Waiting || json.ListKey || (json.IdentifierList && json.IdentifierList.ListKey))) {
    throw new Error("PubChem answered asynchronously (ListKey/Waiting); this harvester does not poll");
  }
  return parseSimilarityResponse(json);
}

/* PubChem has renamed the structure column before (CanonicalSMILES -> SMILES /
 * ConnectivitySMILES). parsePropertyResponse READS all three spellings, but the
 * REQUEST only ever asked for one — and an unknown property name is rejected by
 * the endpoint, so the whole call fails with an HTTP error and the reader's
 * three-spelling defence never runs. Then every batch is skipped and the
 * harvest is empty, loudly but uselessly. So the request column falls back too,
 * once, and the working spelling is remembered for the rest of the run. */
const PROP_COLUMNS = ["CanonicalSMILES", "SMILES", "ConnectivitySMILES"];
let propColumn = PROP_COLUMNS[0];

function propertyUrl(cids, column) {
  return PUBCHEM + "/cid/" + cids.join(",") +
    "/property/" + column + ",MolecularFormula,MolecularWeight/JSON";
}

async function propertiesFor(cids) {
  let firstErr = null;
  // The spelling that last worked first, then the others in their stated order.
  const order = [propColumn, ...PROP_COLUMNS.filter((c) => c !== propColumn)];
  for (const column of order) {
    try {
      const rows = parsePropertyResponse(await getJson(propertyUrl(cids, column)));
      if (column !== propColumn) {
        console.log("  (PubChem refused '" + propColumn + "'; the structure column is now '" + column + "')");
        propColumn = column;
      }
      return rows;
    } catch (e) {
      if (firstErr === null) firstErr = e;
    }
  }
  throw firstErr || new Error("property fetch failed");
}

/* ————————————————————————————— delivery ————————————————————————————— */

function ingestUrl(api) {
  const base = api.endsWith("/") ? api : api + "/";
  return base + "?a=ingest";
}

/**
 * POST one chunk to the swarm server. Returns { ok, added, skipped, error }.
 * Never throws: a delivery failure is data, not an exception.
 */
async function postChunk(api, key, molecules) {
  const body = {
    key,
    engine: ENGINE_VERSION,
    targets_digest: targetsDigest(),
    molecules: molecules.map((m) => ({
      cid: m.cid, smiles: m.smiles, formula: m.formula, source: m.source
    }))
  };
  try {
    const res = await fetch(ingestUrl(api), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Key": key,
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok || !json) {
      return { ok: false, added: 0, skipped: 0, error: "HTTP " + res.status + " " + text.slice(0, 120) };
    }
    return {
      ok: true,
      added: Number(json.added) || 0,
      skipped: Number(json.skipped) || 0,
      error: null
    };
  } catch (e) {
    return { ok: false, added: 0, skipped: 0, error: String(e && e.message ? e.message : e) };
  }
}

function writeHarvestFile(payload) {
  try {
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");
    return true;
  } catch (e) {
    console.error("could not write " + OUT_FILE + ": " + (e && e.message));
    return false;
  }
}

/** Merge b's counters into a. */
function addCounts(a, b) {
  for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k];
  return a;
}

/* ————————————————————————————— the selftest ————————————————————————————— */

/**
 * The whole pipeline against recorded fixtures, with the network physically
 * removed. This is what CI runs on every push, so the assertions are about
 * BEHAVIOUR (which molecules survive, and why) and not merely "it did not
 * crash".
 */
export function selftest() {
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };
  /* The banner is COMPUTED, never typed. It used to claim "11 of 24 rows" and
   * "every filter bites" as literal text — both of which could drift away from
   * what the run actually did without anything noticing, and one of which was
   * already false. */
  let banner = "";

  // 1. No fetch may execute. Not "should not" — cannot.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error("selftest attempted a network call");
  };

  try {
    const sim = JSON.parse(readFileSync(join(FIXTURES, "pubchem-similarity.json"), "utf8"));
    const props = JSON.parse(readFileSync(join(FIXTURES, "pubchem-properties.json"), "utf8"));

    // 2. Response parsing.
    const cids = parseSimilarityResponse(sim);
    check(cids.length >= 20, "similarity fixture should yield >= 20 CIDs, got " + cids.length);
    check(cids.every((c) => Number.isInteger(c) && c > 0), "similarity CIDs must be positive integers");
    check(new Set(cids).size === cids.length, "parseSimilarityResponse must dedupe");

    const rows = parsePropertyResponse(props);
    check(rows.length >= 20, "property fixture should yield >= 20 rows, got " + rows.length);
    const missing = rows.find((r) => r.cid === 99999903);
    check(!!missing && missing.smiles === null, "a row with no CanonicalSMILES must survive parsing with smiles:null");

    // 3. Hostile shapes must return empty, never throw.
    for (const junk of [null, undefined, 0, "", "<html>error</html>", [], {}, { IdentifierList: {} },
                        { IdentifierList: { CID: "nope" } }, { PropertyTable: { Properties: {} } },
                        { PropertyTable: { Properties: [null, 7, { CID: "x" }, { CID: -3 }] } }]) {
      let threw = false;
      try { parseSimilarityResponse(junk); parsePropertyResponse(junk); } catch (e) { threw = true; }
      check(!threw, "parsers must never throw (input " + JSON.stringify(junk) + ")");
    }
    check(parsePropertyResponse({ PropertyTable: { Properties: [{ CID: "x" }, { CID: -3 }, { CID: 1.5 }] } }).length === 0,
      "non-integer / negative CIDs must be refused");

    // 3b. A CID IS AN IDENTITY, NOT A QUANTITY. Number() reads "0x10" as 16 and
    //     "1e3" as 1000; inventing a CID from a garbled string attaches a real
    //     structure to a stranger's PubChem record. Only the canonical decimal
    //     spelling is a CID. The same anchoring applies to MolecularWeight.
    for (const bad of ["0x10", "1e3", " 12 ", "0b101", "+7", "12.0", "  7\n", "1_0", "Infinity"]) {
      const got = parsePropertyResponse({ PropertyTable: { Properties: [{ CID: bad, CanonicalSMILES: "CCCCC" }] } });
      check(got.length === 0, "CID " + JSON.stringify(bad) + " must be refused, not coerced to " +
        (got[0] ? got[0].cid : "-"));
    }
    check(parsePropertyResponse({ PropertyTable: { Properties: [{ CID: "2519", CanonicalSMILES: "C" }] } })[0].cid === 2519,
      "a plain decimal CID string must still be read");
    check(parsePropertyResponse({ PropertyTable: { Properties: [{ CID: 5, MolecularWeight: "0x10" }] } })[0].mw === null,
      "a MolecularWeight of '0x10' must read as unknown, not as 16 Da");
    check(parsePropertyResponse({ PropertyTable: { Properties: [{ CID: 5, MolecularWeight: "194.19" }] } })[0].mw === 194.19,
      "PubChem's ordinary stringified weight must still parse");

    // 4. The filter, on the real fixture.
    //    `fired` accumulates every rejection counter raised anywhere in this
    //    selftest, so section 11 can assert that EVERY reason in REJECTIONS bit
    //    at least once. The seven hand-written checks this replaces silently
    //    skipped smiles_too_long — the one rule nobody had ever exercised —
    //    while the banner claimed "every filter bites".
    const fired = Object.fromEntries(REJECTIONS.map((k) => [k, 0]));
    const ref = referenceIndex();
    check(ref.cids.size >= 20, "reference index should hold every active CID, got " + ref.cids.size);
    const seen = new Set();
    const r = filterCandidates(rows, ref, seen, "selftest");
    addCounts(fired, r.rejected);
    const keptCids = r.accepted.map((m) => m.cid);

    const mustKeep = ["2519", "1983", "5793", "5281672", "5280443", "65064", "5951", "445639", "5429", "338", "370"];
    for (const c of mustKeep) check(keptCids.includes(c), "CID " + c + " should have been accepted");
    check(r.accepted.length === mustKeep.length,
      "expected exactly " + mustKeep.length + " survivors, got " + r.accepted.length + " (" + keptCids.join(",") + ")");

    check(!!r.notes.find((n) => n.cid === 99999902 && n.reason === "mw_out_of_range"),
      "the 1124 Da molecule must be dropped for weight, not for something else");
    check(r.rejected.is_reference >= 6, "reference actives were not excluded (got " + r.rejected.is_reference + ")");

    // 4b. The MW FLOOR needs a constructed row: no organic molecule with five
    //     heavy atoms weighs under 60 Da, so the heavy-atom floor always fires
    //     first on real data. What the floor really defends against is PubChem
    //     handing back a nonsense weight for a real structure.
    {
      const seen2 = new Set();
      const low = filterCandidates(
        [{ cid: 424242, smiles: "C1=CC=CC=C1", formula: "C6H6", mw: 12 }], ref, seen2, "synthetic");
      addCounts(fired, low.rejected);
      check(low.accepted.length === 0 && low.rejected.mw_out_of_range === 1,
        "a row claiming 12 Da for benzene must be refused by the MW floor");
      const seen3 = new Set();
      const unknown = filterCandidates(
        [{ cid: 424243, smiles: "C1=CC=CC=C1", formula: "C6H6", mw: null }], ref, seen3, "synthetic");
      addCounts(fired, unknown.rejected);
      check(unknown.accepted.length === 1,
        "a missing MolecularWeight must fall back to our own computed weight, not drop the molecule");
    }

    // 4c. THE LENGTH CEILING, which no fixture row is long enough to trip. It
    //     went untested for exactly as long as it existed, and an untested rule
    //     is a rule that may be refusing the wrong things.
    {
      const seenLong = new Set();
      const long = filterCandidates(
        [{ cid: 424244, smiles: "C".repeat(SMILES_MAX + 1), formula: "", mw: 200 }], ref, seenLong, "synthetic");
      addCounts(fired, long.rejected);
      check(long.accepted.length === 0 && long.rejected.smiles_too_long === 1,
        "a SMILES one character past the server's limit must be refused, got " +
        JSON.stringify(long.rejected));
      const seenFit = new Set();
      const fits = filterCandidates(
        [{ cid: 424245, smiles: "C".repeat(SMILES_MAX), formula: "", mw: 200 }], ref, seenFit, "synthetic");
      addCounts(fired, fits.rejected);
      check(fits.accepted.length === 1, "a SMILES of exactly SMILES_MAX characters must still be accepted");
    }

    // 4d. STRUCTURAL DEDUPE AMONG CANDIDATES. The screen is stereo-blind, so a
    //     stereoisomer family is ONE molecule to it. PubChem's similarity search
    //     returns those families whole; without this, volunteers screen the same
    //     graph N times and the researcher-facing shortlist fills with copies.
    {
      const cat = "C1C(C(OC2=CC(=CC(=C21)O)O)C3=CC(=C(C=C3)O)O)O"; // catechin skeleton
      const seenFam = new Set();
      const fam = filterCandidates(
        [{ cid: 9064, smiles: cat, formula: "", mw: 290.27 },
         { cid: 72276, smiles: cat, formula: "", mw: 290.27 },
         { cid: 73160, smiles: cat, formula: "", mw: 290.27 }], ref, seenFam, "synthetic");
      addCounts(fired, fam.rejected);
      check(fam.accepted.length === 1 && fam.accepted[0].cid === "9064",
        "one stereo-blind skeleton under three CIDs must be harvested once, keeping the FIRST CID; got " +
        JSON.stringify(fam.accepted.map((m) => m.cid)));
      check(fam.rejected.duplicate_structure === 2,
        "the two siblings must be counted as duplicate_structure, got " + JSON.stringify(fam.rejected));
      check(!!fam.notes.find((n) => n.reason === "duplicate_structure" && n.detail === "same-graph-as-cid:9064"),
        "a structural duplicate must name the CID it collapsed into");
      // It holds ACROSS calls, the way the CID dedupe does: same run, same `seen`.
      const later = filterCandidates([{ cid: 73161, smiles: cat, formula: "", mw: 290.27 }], ref, seenFam, "synthetic-2");
      addCounts(fired, later.rejected);
      check(later.accepted.length === 0 && later.rejected.duplicate_structure === 1,
        "structural dedupe must survive across batches, not just within one response");
      // ... and a genuinely different molecule is NOT swallowed by it.
      const other = filterCandidates([{ cid: 73162, smiles: "CN1C=NC2=C1C(=O)N(C(=O)N2C)C", formula: "", mw: 194.19 }],
        ref, seenFam, "synthetic-2");
      addCounts(fired, other.rejected);
      check(other.accepted.length === 1, "structural dedupe must not swallow a different structure");
    }

    // 4e. THE GATE MAY NOT REFUSE ITS OWN REFERENCE SET. Every active in
    //     targets.js, offered under a novel CID, must be dropped for exactly one
    //     reason: it IS a reference active. Any other reason means the filter
    //     would also throw away the real candidates that resemble it — which is
    //     precisely how MW_MAX=900 made the mTOR target harvest zero molecules
    //     forever (rapamycin 914.19 Da, everolimus 958.24 Da) while the log
    //     cheerfully printed "60 similar, 0 accepted".
    {
      let novel = 99000000;
      for (const t of TARGETS) {
        for (const a of t.actives) {
          const res = filterCandidates(
            [{ cid: ++novel, smiles: a.smiles, formula: "", mw: null }], ref, new Set(), t.id);
          const note = res.notes[0];
          check(res.accepted.length === 0 && !!note && note.reason === "is_reference",
            "reference active " + a.name + " (" + t.id + ") must be refused ONLY as is_reference, got " +
            (note ? note.reason + " " + note.detail : "accepted"));
        }
      }
    }

    // 4f. Hostile ref / seen: an exported function may not throw because its
    //     caller handed it the wrong shape.
    for (const [label, rf, sn] of [["ref={}", {}, new Set()], ["ref=null", null, new Set()],
                                   ["ref=[]", [], new Set()], ["ref undefined", undefined, new Set()],
                                   ["seen=null", ref, null], ["seen={}", ref, {}],
                                   ["seen=0", ref, 0], ["seen=[]", ref, []]]) {
      let threw = null;
      let out = null;
      try { out = filterCandidates([{ cid: 1, smiles: "CCCCC", formula: "", mw: 100 }], rf, sn, "hostile"); }
      catch (e) { threw = e; }
      check(threw === null, "filterCandidates threw on " + label + ": " + (threw && threw.message));
      check(!!out && Array.isArray(out.accepted) && Array.isArray(out.notes) && !!out.rejected,
        "filterCandidates must still return its shape on " + label);
    }

    // 5. The reference exclusion works BOTH ways: by CID, and structurally.
    const byCid = r.notes.find((n) => n.cid === 2244 && n.reason === "is_reference");
    check(!!byCid && byCid.detail === "by-cid:Aspirin",
      "aspirin (CID 2244) must be dropped by the CID list, got " + (byCid ? byCid.detail : "-"));
    const byStructure = r.notes.find((n) => n.cid === 99999904 && n.reason === "is_reference");
    check(!!byStructure && byStructure.detail === "by-structure:Nicotinamide",
      "a novel CID carrying nicotinamide's structure must be dropped structurally and name the match, got " +
      (byStructure ? byStructure.detail : "-"));

    // 5b. ... AND IT MUST NOT DEPEND ON HOW THE SMILES WAS TYPED. This is the
    //     whole reason the harvester parses through molFromSmiles: PubChem emits
    //     both the Kekulé and the aromatic spelling of the same ring system.
    //     Measured on the raw parser, the harvester's structural exclusion only
    //     fired for the spelling targets.js happened to use — benzene vs benzene
    //     scored 0/1000, nicotinamide vs nicotinamide 121/1000 — so the same
    //     reference active in the other spelling sailed through as a candidate.
    for (const [label, smi] of [["kekule", "C1=CC(=CN=C1)C(=O)N"], ["aromatic", "c1cc(cnc1)C(=O)N"]]) {
      const seenSpell = new Set();
      const spelled = filterCandidates([{ cid: 99000042, smiles: smi, formula: "", mw: 122.12 }], ref, seenSpell, "spelling");
      addCounts(fired, spelled.rejected);
      const n = spelled.notes[0];
      check(spelled.accepted.length === 0 && !!n && n.detail === "by-structure:Nicotinamide",
        "nicotinamide in " + label + " spelling must be recognised as the reference active, got " +
        (n ? n.reason + " " + n.detail : "accepted"));
    }

    // 6. Accepted rows carry exactly what ?a=ingest wants, and nothing hostile.
    for (const m of r.accepted) {
      check(typeof m.cid === "string" && /^[0-9]+$/.test(m.cid), "cid must be a digit string, got " + m.cid);
      check(typeof m.smiles === "string" && m.smiles.length > 0 && m.smiles.length <= SMILES_MAX, "bad smiles for " + m.cid);
      check(typeof m.formula === "string" && /^[A-Za-z0-9+\-]+$/.test(m.formula), "bad formula for " + m.cid + ": " + m.formula);
      check(m.source === "harvest", "source must be 'harvest'");
      check(parseSmiles(m.smiles) !== null, "an accepted molecule must re-parse: " + m.cid);
    }
    const caffeine = r.accepted.find((m) => m.cid === "2519");
    check(!!caffeine && caffeine.formula === "C8H10N4O2",
      "formula must be computed from the structure, got " + (caffeine ? caffeine.formula : "-"));

    // 7. Dedupe is ACROSS targets, not just within one response.
    const again = filterCandidates(rows, ref, seen, "selftest-2");
    addCounts(fired, again.rejected);
    check(again.accepted.length === 0, "a second pass over the same rows must accept nothing, got " + again.accepted.length);
    check(again.rejected.duplicate_cid >= mustKeep.length, "cross-target dedupe did not fire");

    // 8. Chunking, both for property batches and for ingest POSTs.
    const many = Array.from({ length: 450 }, (_, i) => i + 1);
    const c200 = chunk(many, INGEST_CHUNK);
    check(c200.length === 3 && c200[0].length === 200 && c200[2].length === 50,
      "chunk(450, 200) must be [200,200,50], got " + c200.map((x) => x.length).join(","));
    const c100 = chunk(many, PROP_BATCH);
    check(c100.length === 5 && c100[4].length === 50,
      "chunk(450, 100) must be [100x4,50], got " + c100.map((x) => x.length).join(","));
    check(chunk([], 200).length === 0, "chunk of an empty list is empty");
    check(chunk(null, 200).length === 0, "chunk(null) must not throw");
    check(chunk([1, 2, 3], 0).length === 3, "a nonsense chunk size must degrade to 1, not divide by zero");
    check(c200.reduce((n, c) => n + c.length, 0) === 450, "chunking must not lose or duplicate a molecule");
    check(chunk(r.accepted, INGEST_CHUNK).length === 1, "a small harvest is one ingest call");

    // 9. Nothing may be posted without a key: the undeliverable path is the
    //    default, not an error branch nobody walks.
    check(ingestUrl("https://x/api") === "https://x/api/?a=ingest", "ingest URL must be built from LOS_API");
    check(ingestUrl("https://x/api/") === "https://x/api/?a=ingest", "a trailing slash must not double up");

    // 10. Engine identity travels with the molecules.
    check(/^[0-9a-f]{64}$/.test(targetsDigest()), "targetsDigest must be 64 hex chars");
    check(ENGINE_VERSION === "los-chem-2", "unexpected engine version " + ENGINE_VERSION);

    // 11. EVERY reason in REJECTIONS must have bitten somewhere above. Written
    //     as a loop, not as a hand-written list, so the next reason anybody adds
    //     cannot go untested the way smiles_too_long did.
    for (const k of REJECTIONS) {
      check(fired[k] >= 1, "the '" + k + "' rejection never fired anywhere in the selftest — " +
        "an untested filter is a filter nobody has checked bites the right things");
    }
    banner =
      "harvest --selftest: " + r.accepted.length + " of " + rows.length +
      " fixture rows survive filtering; all " + REJECTIONS.length + " rejection reasons bite (" +
      REJECTIONS.map((k) => k + "=" + fired[k]).join(" ") + "); " +
      TARGETS.reduce((n, t) => n + t.actives.length, 0) +
      " reference actives are refused only as references; chunking exact; zero network calls ✓";

    check(fetchCalls === 0, "the selftest executed " + fetchCalls + " network call(s) — it must be fully offline");
  } catch (e) {
    failures.push("selftest threw: " + (e && e.stack ? e.stack : e));
  } finally {
    globalThis.fetch = realFetch;
  }

  if (failures.length) {
    for (const f of failures) console.error("  ✗ " + f);
    console.error("harvest --selftest: FAILED (" + failures.length + " assertion(s))");
    return 1;
  }
  console.log(banner);
  return 0;
}

/* ————————————————————————————— the live run ————————————————————————————— */

async function run({ dryRun }) {
  const api = (process.env.LOS_API || "").trim();
  const key = (process.env.LOS_INGEST_KEY || "").trim();
  const perActive = (() => {
    const n = Number(process.env.LOS_PER_ACTIVE);
    return Number.isFinite(n) && n >= 1 && n <= 500 ? Math.floor(n) : 60;
  })();

  const ref = referenceIndex();
  const seen = new Set();      // CIDs accepted into the harvest
  const examined = new Set();  // every CID we have already fetched properties for
  const accepted = [];
  const rejected = Object.fromEntries(REJECTIONS.map((r) => [r, 0]));
  const failures = [];
  /* Counters say HOW MANY were dropped; the notes say WHICH, and why. Without
   * them a live run can never answer "why did nothing come back from mTOR" —
   * which is exactly how a filter that refused its own reference actives went
   * unnoticed. Bounded so an artifact stays an artifact. */
  const notes = [];
  const NOTES_MAX = 500;
  let searched = 0;
  let retrieved = 0;

  console.log("harvest: " + TARGETS.length + " targets, engine " + ENGINE_VERSION +
    ", targets digest " + targetsDigest().slice(0, 12) + "…, up to " + perActive + " similars per active");

  for (const t of TARGETS) {
    for (const a of t.actives) {
      const cid = cidOf(a.cid);
      if (cid === null) continue;
      const label = a.name + " (CID " + cid + ", " + t.id + ")";

      let hits = [];
      try {
        hits = await similarCids(cid, perActive);
        searched++;
      } catch (e) {
        // Never fabricate: a failed search contributes zero molecules and says so.
        const msg = "similarity search failed for " + label + ": " + (e && e.message ? e.message : e);
        console.error("  ! " + msg + " (skipping this active)");
        failures.push(msg);
        continue;
      }

      // Cheap win: reference actives and any CID we have already looked at —
      // accepted OR rejected — cost nothing to skip here, and every one skipped
      // is a property call PubChem does not have to serve. Overlap between
      // actives is large (quercetin appears under two targets), so this is the
      // difference between a polite job and a rude one.
      const fresh = hits.filter((c) => !examined.has(c) && !ref.cids.has(c));
      let got = 0;
      for (const batch of chunk(fresh, PROP_BATCH)) {
        let rows = [];
        try {
          rows = await propertiesFor(batch);
        } catch (e) {
          const msg = "property fetch failed for " + label + " (" + batch.length + " CIDs): " +
            (e && e.message ? e.message : e);
          console.error("  ! " + msg + " (skipping this batch)");
          failures.push(msg);
          continue;
        }
        retrieved += rows.length;
        for (const row of rows) examined.add(row.cid);
        for (const c of batch) examined.add(c); // including CIDs PubChem returned nothing for
        const r = filterCandidates(rows, ref, seen, t.id);
        accepted.push(...r.accepted);
        addCounts(rejected, r.rejected);
        for (const n of r.notes) {
          if (notes.length >= NOTES_MAX) break;
          notes.push({ target: t.id, cid: n.cid, reason: n.reason, detail: n.detail });
        }
        got += r.accepted.length;
      }
      console.log("  " + label + ": " + hits.length + " similar, " + got + " accepted");
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    engine: ENGINE_VERSION,
    targets_digest: targetsDigest(),
    threshold: SIMILARITY_THRESHOLD,
    per_active: perActive,
    actives_searched: searched,
    properties_retrieved: retrieved,
    accepted: accepted.length,
    rejected,
    rejection_notes: notes,
    rejection_notes_truncated: notes.length >= NOTES_MAX,
    failures,
    molecules: accepted
  };

  console.log("");
  console.log("harvested " + accepted.length + " candidate molecules from " + retrieved +
    " retrieved records across " + searched + " successful searches" +
    (failures.length ? " (" + failures.length + " call(s) failed and were skipped — the count above is what was really retrieved)" : ""));
  console.log("rejections: " + REJECTIONS.map((k) => k + "=" + (rejected[k] || 0)).join(" "));

  if (dryRun) {
    writeHarvestFile(summary);
    console.log("");
    console.log("--dry-run: NOTHING WAS INGESTED. " + chunk(accepted, INGEST_CHUNK).length +
      " chunk(s) of up to " + INGEST_CHUNK + " would have been POSTed to " + (api || "<LOS_API unset>") + "?a=ingest");
    for (const m of accepted.slice(0, 20)) console.log("   " + m.cid + "  " + m.formula + "  " + m.smiles);
    if (accepted.length > 20) console.log("   … and " + (accepted.length - 20) + " more (all of them in " + OUT_FILE + ")");
    return failures.length && accepted.length === 0 ? 1 : 0;
  }

  if (!api || !key) {
    const names = [!api ? "LOS_API" : null, !key ? "LOS_INGEST_KEY" : null].filter(Boolean);
    const missing = names.join(" and ") + (names.length > 1 ? " are" : " is");
    writeHarvestFile(summary);
    console.log("");
    console.log("NOTHING WAS INGESTED: " + missing + " not set, so there is no server to deliver to.");
    console.log("The full harvest of " + accepted.length + " molecules was written to " + OUT_FILE +
      " instead. An undeliverable harvest is reported, never dropped.");

    /* FAIL CLOSED ON A HALF-CONFIGURED JOB. Neither variable set is the honest
     * "not wired up yet" case and stays green. But harvest.yml passes
     * LOS_INGEST_KEY: ${{ secrets.LOS_INGEST_KEY }}, which is the EMPTY STRING
     * when the secret is unset — so a deployment with LOS_API configured and
     * the key missing used to return 0 and the scheduled job went green
     * indefinitely while the swarm was never fed once. One variable set and
     * the other missing is a misconfiguration, and it goes red. The artifact
     * still uploads: the workflow's upload step is `if: always()`. */
    if (api || key) {
      console.error("::error::harvest is half-configured — " + missing +
        " not set, so " + accepted.length + " molecules could not be delivered to the swarm.");
      return 1;
    }
    return 0;
  }

  let added = 0;
  let skipped = 0;
  const chunks = chunk(accepted, INGEST_CHUNK);
  const bad = [];
  for (let i = 0; i < chunks.length; i++) {
    const res = await postChunk(api, key, chunks[i]);
    if (res.ok) {
      added += res.added;
      skipped += res.skipped;
      console.log("  ingest chunk " + (i + 1) + "/" + chunks.length + ": added " + res.added + ", skipped " + res.skipped);
    } else {
      bad.push("chunk " + (i + 1) + ": " + res.error);
      console.error("  ! ingest chunk " + (i + 1) + "/" + chunks.length + " failed: " + res.error);
    }
  }

  console.log("");
  if (bad.length) {
    summary.ingest = { added, skipped, failed_chunks: bad };
    writeHarvestFile(summary);
    console.log("PARTIAL DELIVERY: " + added + " molecules added, " + bad.length + " of " + chunks.length +
      " chunk(s) failed. The whole harvest was written to " + OUT_FILE + " so nothing is lost.");
    return 1;
  }
  /* A GREEN RUN LEAVES EVIDENCE TOO. Every failure path wrote the harvest
   * file; success was the one case that discarded it, so the run nobody looks
   * at was also the run with no record of which molecules were shipped (the
   * workflow's if-no-files-found: ignore swallowed the empty upload silently).
   * The file is what a researcher reads back to ask "where did this candidate
   * come from" months later. */
  summary.ingest = { added, skipped, failed_chunks: [] };
  writeHarvestFile(summary);
  console.log("ingested " + added + " new molecules (" + skipped + " already known) into " + api);
  console.log("The delivered harvest was written to " + OUT_FILE + ".");
  return 0;
}

/* ————————————————————————————— entry point ————————————————————————————— */

/* A CLI FIRST, A MODULE SECOND — and the module half must be inert.
 *
 * Without this guard, `import`ing harvest.mjs (which QA does, to drive the
 * pipeline offline) started a LIVE HARVEST at module-evaluation time: 27
 * outbound requests to PubChem, a real POST to the production ?a=ingest
 * endpoint whenever LOS_API/LOS_INGEST_KEY were in the environment — they are
 * on the harvest runner — and then process.exit(), which TERMINATED THE
 * IMPORTING PROCESS with code 0. A QA suite that imported this file reported
 * green having run none of its assertions. Only a direct `node
 * tools/harvest.mjs` may do any of that, and only the CLI branch may exit. */
const invokedDirectly = (() => {
  const entry = process.argv && process.argv[1];
  if (!entry) return false;
  let self;
  try { self = fileURLToPath(import.meta.url); } catch (e) { return false; }
  /* realpath first, so a symlinked or ../-relative invocation still counts as
   * direct — the failure mode of getting this wrong is a CLI that does nothing
   * and exits 0, which would be a silently green harvest. */
  try { if (realpathSync(entry) === realpathSync(self)) return true; } catch (e) { /* fall through */ }
  try { return resolve(entry) === self; } catch (e) { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    process.exit(selftest());
  } else {
    run({ dryRun: argv.includes("--dry-run") })
      .then((code) => process.exit(code || 0))
      .catch((e) => {
        console.error("harvest failed: " + (e && e.stack ? e.stack : e));
        process.exit(1);
      });
  }
}
