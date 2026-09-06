/* worker — the volunteer's screening node, one module Web Worker per page.
 *
 * WHAT RUNS HERE AND WHY IT RUNS HERE. Screening a work unit is pure CPU:
 * parse ~40 SMILES, fingerprint each one, compare it to every reference
 * active, score it, hash the lot. On a phone that is long enough to drop
 * frames, and a page that stutters while it "donates" is a page people close.
 * So the whole computation lives off the main thread, and even here it is cut
 * into chunks with a yield between them — a worker that is wedged inside one
 * enormous synchronous call cannot answer the next message, cannot be told to
 * stop, and cannot report progress.
 *
 * WHAT DOES NOT LIVE HERE. Not one line of chemistry. The engine is
 * ../chem/score.js and this file only ever calls it, because the swarm's trust
 * model is that two strangers' browsers produce a bit-identical digest for the
 * same unit. A second implementation of the scoring or the canonical
 * serialisation — even a "faster" one — is a second engine, and two engines is
 * exactly the bug that makes "two volunteers agreed" mean nothing. That is
 * also why nothing in this file touches Date.now, Math.random, locale
 * formatting or floating-point accumulation: no clock, no chance, no locale
 * ever reaches the digest.
 *
 * PROTOCOL
 *   in :  { type: 'screen', unit }            unit = { unit_id, molecules:[{id,smiles}] }
 *   out:  { type: 'ready' }                   once, when the reference set is built
 *         { type: 'progress', done, total, unitId }
 *         { type: 'done', result }            result === screenUnit(unit, refs), verbatim
 *         { type: 'error', message, unitId }  and the worker STAYS ALIVE for the next unit
 *
 * Nothing in here throws out to the host: a hostile unit (a null SMILES, a
 * 9 kB string of carbons, an empty molecule list, an emoji) must come back as
 * a result or as an error message, never as a dead worker.
 */

import { screenUnit, referenceSet } from "../chem/score.js";

/* Molecules screened between yields. Small enough that the worker stays
 * answerable on a slow phone, large enough that the yields do not dominate. */
const CHUNK = 5;

/* The reference fingerprints are expensive and identical for every unit, so
 * they are built once per worker and reused. Built lazily: constructing a
 * worker should cost nothing until there is actual work. */
let refs = null;
let refsError = null;

function ensureRefs() {
  if (refs || refsError) return refs;
  try {
    refs = referenceSet();
  } catch (err) {
    refsError = message(err);
    refs = null;
  }
  return refs;
}

function message(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  try { return String(err); } catch (_) { return "unknown error"; }
}

function post(msg) {
  try { self.postMessage(msg); } catch (_) { /* host went away mid-unit */ }
}

/* A real yield, not a microtask: setTimeout(0) returns to the worker's event
 * loop, so a queued message (the next unit, a terminate) is actually seen. */
function yieldToLoop() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function moleculesOf(unit) {
  return unit && Array.isArray(unit.molecules) ? unit.molecules : [];
}

function unitIdOf(unit) {
  try {
    return unit && unit.unit_id !== undefined ? String(unit.unit_id) : "";
  } catch (_) {
    return "";
  }
}

/* ————— screening one unit ————— */

/* The authoritative result is ONE call to screenUnit over the whole unit —
 * that call owns the canonical serialisation and therefore the digest, and it
 * is the only thing the server ever compares between two volunteers.
 *
 * Progress and yielding are produced by walking the unit in chunks first,
 * screening each chunk as a sub-unit through the same engine. That is real
 * work — a chunk that reports progress has genuinely been screened — but it is
 * work done twice, and it is a deliberate trade: score.js exposes no
 * per-molecule callback, and re-implementing its loop here to save the second
 * pass would fork the engine, which is the one thing this file may not do. If
 * score.js ever grows an onMolecule hook, delete the pre-pass and use it.
 * Units of a single chunk skip the pre-pass entirely, so the common small unit
 * costs exactly one pass. */
/* The unit being screened right now, so that the two last-resort error
 * emitters below can still name it. They are the paths a host most needs to
 * correlate — an error carrying `unitId: undefined` is an error about nothing
 * in particular — and they are exactly the paths where the id is no longer on
 * any stack. */
let current = "";

async function screen(unit) {
  const id = unitIdOf(unit);
  current = id;
  const mols = moleculesOf(unit);
  const total = mols.length;

  const r = ensureRefs();
  if (!r) {
    post({ type: "error", unitId: id, message: "reference set unavailable: " + (refsError || "unknown") });
    return;
  }

  try {
    if (total > CHUNK) {
      for (let i = 0; i < total; i += CHUNK) {
        const slice = mols.slice(i, i + CHUNK);
        /* screened, then discarded: the pre-pass exists to pace the worker and
         * to report honest progress, never to produce a digest. */
        screenUnit({ unit_id: id, molecules: slice }, r);
        post({ type: "progress", unitId: id, done: Math.min(i + CHUNK, total), total });
        await yieldToLoop();
      }
    }

    const result = screenUnit(unit && typeof unit === "object" ? unit : { unit_id: id, molecules: [] }, r);
    post({ type: "progress", unitId: id, done: total, total });
    post({ type: "done", result });
  } catch (err) {
    /* The engine promises not to throw on hostile input; if it ever does, the
     * volunteer's browser must not lose the worker over it. */
    post({ type: "error", unitId: id, message: message(err) });
  }
}

/* ————— the message pump ————— */

/* Units are screened strictly one at a time and in arrival order. A second
 * unit arriving mid-screen is queued rather than run concurrently: two
 * screenings sharing this thread would only make both slower, and the loop in
 * client.js never has more than one unit outstanding anyway. */
const queue = [];
let busy = false;

async function drain() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const unit = queue.shift();
      await screen(unit);
    }
  } catch (err) {
    post({ type: "error", unitId: current, message: message(err) });
  } finally {
    busy = false;
  }
}

self.onmessage = (ev) => {
  let data = null;
  try { data = ev && ev.data; } catch (_) { data = null; }
  if (!data || typeof data !== "object") return;

  if (data.type === "screen") {
    /* A queue with no ceiling is a memory bomb for a hostile page; 64 pending
     * units is far more than the client will ever have outstanding. */
    if (queue.length >= 64) {
      post({ type: "error", unitId: unitIdOf(data.unit), message: "worker queue full" });
      return;
    }
    queue.push(data.unit);
    drain();
    return;
  }

  if (data.type === "warmup") {
    const r = ensureRefs();
    post(r ? { type: "ready" } : { type: "error", message: "reference set unavailable: " + (refsError || "unknown") });
    return;
  }

  /* Unknown message types are ignored on purpose — a future client speaking a
   * newer protocol must not be able to kill an older worker. */
};

/* A last net: an error that escapes everything above still must not take the
 * worker down silently. */
self.onerror = (e) => {
  post({ type: "error", unitId: current, message: message(e && e.message ? e.message : e) });
  return true;
};
