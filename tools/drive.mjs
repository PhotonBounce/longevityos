/* drive — THE BULK STORE, AND THE LEDGER THAT KEEPS IT INSIDE ITS LIMIT.
 *
 * LongevityOS 4.1 screens far more molecules than a shared LiteSpeed host can
 * serve. The host stays a coordinator that answers small JSON; the BYTES —
 * partitioned unit files of CID + SMILES — live in the owner's Google Drive,
 * and a volunteer's browser fetches them straight from Drive. This module is
 * the only thing in the project that talks to Drive, and the only thing that
 * decides whether one more byte may be written.
 *
 * THE OWNER'S LIMIT IS THE POINT OF THIS FILE (2026-09-06): never use more
 * than 120 GB, and warn before it. So the cap is not advice printed after the
 * fact — it is a gate every upload passes through, checked against the real
 * total BEFORE the request is made, and a refusal leaves nothing half-written.
 *
 * WHY A LEDGER AND NOT JUST "ask Drive". Both, actually, and the SAFER of the
 * two wins. Drive's own `about.get` reports storage used by the whole account
 * (photos, documents, another project's files), while the ledger knows only
 * what this project put there. Trusting the ledger alone would let the app
 * fill a drive that was already nearly full; trusting Drive alone would make
 * the project's own footprint unknowable. reconcile() takes the larger of the
 * two for the cap decision and reports both, so the number that refuses an
 * upload is never smaller than the truth.
 *
 * WHAT THIS MODULE WILL NOT DO.
 *   * It never deletes a file the ledger did not create. The owner's Drive is
 *     their own; this project cleans up after itself and touches nothing else.
 *   * It never writes a credential anywhere. The refresh token arrives in the
 *     environment, is exchanged for a short-lived access token in memory, and
 *     neither is logged, returned in an error, or written to a file.
 *   * It never reports a partial upload as a success, and never records a
 *     ledger entry for bytes that did not land.
 *   * It never throws at a caller because a remote answered badly. Every
 *     failure is a returned reason.
 *
 * THE SANDBOX HAS NO ROUTE TO GOOGLE. Nothing here may assume a live network:
 * every function takes its `fetchImpl`, and --selftest drives the whole module
 * against a mock with the real fetch replaced by a landmine. That selftest is
 * what CI runs.
 *
 *   node tools/drive.mjs --selftest    offline, no network at all
 *   node tools/drive.mjs --plan        print what a bulk run WOULD upload
 *
 * A CLI FIRST, A MODULE SECOND — importing it must be inert.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

/* ————— the owner's limits, in one place ————— */
export const GB = 1024 * 1024 * 1024;
export const CAP_BYTES = 120 * GB;          // hard stop — the owner's number
export const WARN_BYTES = 100 * GB;         // say something well before the wall
/* Drive's own reported usage can lag a write by seconds. A gap smaller than
 * this is the API catching up, not a lost file; a larger one is reported. */
export const RECONCILE_SLACK = 64 * 1024 * 1024;

/* A unit file is what one volunteer's browser downloads and screens. Small
 * enough that a phone on a slow link finishes one, big enough that the
 * coordinator is not asked for work every few seconds. */
export const UNIT_MOLECULES = 500;
export const UNIT_BYTES_MAX = 2 * 1024 * 1024;   // a refusal, not a target

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const intOf = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);

/* ————————————————————————— the ledger ————————————————————————— */

/* The ledger is a plain, sorted, replayable record: one entry per object this
 * project put in Drive. It is small (a few hundred bytes per unit file), it
 * lives beside the units in Drive, and a fresh clone of this repo can read it
 * and know exactly what is out there. */
export function newLedger() {
  return { version: 1, cap_bytes: CAP_BYTES, files: {}, deleted: 0, updated_at: null };
}

export function readLedger(text) {
  /* Hostile input: a ledger fetched from a remote is untrusted. Anything that
   * is not exactly the shape below degrades to an EMPTY ledger, which is the
   * dangerous direction for the cap — so callers MUST reconcile against
   * Drive's own usage before uploading, and reconcile() is what enforces it. */
  let raw = null;
  try { raw = typeof text === "string" ? JSON.parse(text) : text; } catch (_) { raw = null; }
  if (!isObj(raw) || !isObj(raw.files)) return newLedger();
  const out = newLedger();
  for (const [id, e] of Object.entries(raw.files)) {
    if (typeof id !== "string" || id === "" || !isObj(e)) continue;
    /* A Drive file id is never one of these, but a hostile ledger's key can be:
     * `files["__proto__"] = {...}` REPLACES the object's prototype instead of
     * adding an entry, and every later `{}` in the process inherits it. The
     * selftest caught exactly that. */
    if (id === "__proto__" || id === "constructor" || id === "prototype") continue;
    const bytes = intOf(e.bytes);
    if (!bytes) continue;
    out.files[id] = {
      name: typeof e.name === "string" ? e.name.slice(0, 200) : "",
      bytes,
      sha256: /^[0-9a-f]{64}$/.test(e.sha256) ? e.sha256 : "",
      at: intOf(e.at)
    };
  }
  out.deleted = intOf(raw.deleted);
  out.updated_at = intOf(raw.updated_at) || null;
  return out;
}

export function ledgerTotal(ledger) {
  if (!isObj(ledger) || !isObj(ledger.files)) return 0;
  let total = 0;
  for (const e of Object.values(ledger.files)) total += intOf(e && e.bytes);
  return total;
}

export const ledgerCount = (ledger) => (isObj(ledger) && isObj(ledger.files) ? Object.keys(ledger.files).length : 0);

/* Drive says one number, the ledger says another. For deciding whether one
 * more byte may be written, the LARGER is the only safe answer. */
export function reconcile(ledger, driveUsedBytes) {
  const own = ledgerTotal(ledger);
  const drive = intOf(driveUsedBytes);
  const gap = Math.abs(drive - own);
  return {
    ledger_bytes: own,
    drive_bytes: drive,
    /* what every cap decision is made against */
    effective_bytes: Math.max(own, drive),
    /* Drive counts the whole account; a gap is normal and is NOT an error.
     * It is reported so a run that suddenly diverges is visible in the log. */
    gap_bytes: gap,
    in_slack: gap <= RECONCILE_SLACK,
    source: drive > own ? "drive (the account holds more than this project put there)" : "ledger"
  };
}

/* The gate. Called before every single upload, with the real total. */
export function canAccept(effectiveBytes, addBytes, cap = CAP_BYTES) {
  const now = intOf(effectiveBytes);
  const add = intOf(addBytes);
  const after = now + add;
  if (add <= 0) return { ok: false, reason: "nothing to write", now, after, cap };
  if (after > cap) {
    return {
      ok: false,
      reason: "the owner's " + gb(cap) + " limit would be exceeded: " + gb(now) + " used, this file is "
              + gb(add) + ", which would reach " + gb(after) + ". Nothing was uploaded.",
      now, after, cap
    };
  }
  return { ok: true, reason: "", now, after, cap, warn: after >= WARN_BYTES ? warnLine(after, cap) : "" };
}

export const gb = (b) => (intOf(b) / GB).toFixed(2) + " GB";
const warnLine = (after, cap) =>
  "APPROACHING THE LIMIT: " + gb(after) + " of " + gb(cap) + " after this write ("
  + Math.round(100 * after / cap) + "%). The owner asked to be told before the wall, not at it.";

export function recordUpload(ledger, id, entry) {
  if (!isObj(ledger) || !isObj(ledger.files) || typeof id !== "string" || id === "") return ledger;
  const bytes = intOf(entry && entry.bytes);
  if (!bytes) return ledger;   // bytes that did not land are never recorded
  ledger.files[id] = {
    name: typeof entry.name === "string" ? entry.name.slice(0, 200) : "",
    bytes,
    sha256: /^[0-9a-f]{64}$/.test(entry.sha256) ? entry.sha256 : "",
    at: intOf(entry.at)
  };
  return ledger;
}

/* Only ever forgets what it owns. A caller asking to delete a file the ledger
 * never recorded is refused — that file belongs to the owner, not to us. */
export function ledgerOwns(ledger, id) {
  return isObj(ledger) && isObj(ledger.files) && Object.prototype.hasOwnProperty.call(ledger.files, id);
}

export function recordDelete(ledger, id) {
  if (!ledgerOwns(ledger, id)) return { ok: false, reason: "this project did not upload " + String(id) + " — refusing to delete somebody else's file" };
  delete ledger.files[id];
  ledger.deleted = intOf(ledger.deleted) + 1;
  return { ok: true, reason: "" };
}

/* ————————————————————————— unit files ————————————————————————— */

/* A unit file is the transport shape: gzipped JSON of {cid, smiles} rows, one
 * file per work unit, named by the digest of its contents so a browser can
 * verify what it downloaded and a re-run never uploads the same bytes twice. */
export function packUnit(molecules) {
  const rows = [];
  for (const m of Array.isArray(molecules) ? molecules : []) {
    if (!isObj(m)) continue;
    /* Read the row ONCE, behind a guard. Ordinary rows are plain data from the
     * harvester, but packUnit is exported and a caller's object can carry a
     * property accessor that throws — reading it inline would end a bulk run
     * on somebody else's exception. probe-quota hands it exactly that. */
    let rawCid, rawSmiles;
    try { rawCid = m.cid; rawSmiles = m.smiles; } catch (_) { continue; }
    const cid = typeof rawCid === "string" ? rawCid : (Number.isFinite(rawCid) ? String(rawCid) : "");
    const smiles = typeof rawSmiles === "string" ? rawSmiles : "";
    if (!/^[0-9]{1,12}$/.test(cid) || smiles === "" || smiles.length > 400) continue;
    rows.push({ cid, smiles });
  }
  rows.sort((a, b) => (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));   // sorted before digested
  const json = JSON.stringify({ v: 1, n: rows.length, rows });
  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  const digest = sha256(gz);
  return { rows: rows.length, bytes: gz.length, gz, sha256: digest, name: "unit-" + digest.slice(0, 16) + ".json.gz" };
}

export function planUnits(molecules, perUnit = UNIT_MOLECULES) {
  const list = Array.isArray(molecules) ? molecules : [];
  const size = Number.isFinite(perUnit) && perUnit > 0 ? Math.floor(perUnit) : UNIT_MOLECULES;
  const units = [];
  const oversize = [];
  for (let i = 0; i < list.length; i += size) {
    const packed = packUnit(list.slice(i, i + size));
    if (packed.rows === 0) continue;
    if (packed.bytes > UNIT_BYTES_MAX) { oversize.push(packed.name); continue; }
    units.push(packed);
  }
  /* Identical content is identical bytes is one file. A bulk run that overlaps
   * a previous one must not pay for the same megabytes twice. */
  const seen = new Set();
  const unique = units.filter((u) => (seen.has(u.sha256) ? false : (seen.add(u.sha256), true)));
  return {
    units: unique,
    duplicates: units.length - unique.length,
    oversize,
    total_bytes: unique.reduce((n, u) => n + u.bytes, 0),
    total_rows: unique.reduce((n, u) => n + u.rows, 0)
  };
}

/* ————————————————————————— talking to Drive ————————————————————————— */

/* Exchange the long-lived refresh token for a short-lived access token. The
 * refresh token never leaves this function's arguments and neither token is
 * ever returned in an error string. */
export async function accessToken(fetchImpl, creds) {
  const c = isObj(creds) ? creds : {};
  for (const k of ["clientId", "clientSecret", "refreshToken"]) {
    if (typeof c[k] !== "string" || c[k] === "") return { ok: false, reason: "missing " + k, token: "" };
  }
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no fetch available", token: "" };
  let res = null;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: c.clientId, client_secret: c.clientSecret,
        refresh_token: c.refreshToken, grant_type: "refresh_token"
      }).toString()
    });
  } catch (err) {
    /* never the message: it can carry the request, and the request carries the secret */
    return { ok: false, reason: "token request failed: " + (err && err.code ? err.code : "error"), token: "" };
  }
  const body = await safeText(res);
  if (!res || !res.ok) return { ok: false, reason: "token endpoint answered " + (res && res.status) + redact(body), token: "" };
  let json = null;
  try { json = JSON.parse(body); } catch (_) { json = null; }
  const token = isObj(json) && typeof json.access_token === "string" ? json.access_token : "";
  if (!token) return { ok: false, reason: "token endpoint returned no access_token", token: "" };
  return { ok: true, reason: "", token, expires_in: intOf(json.expires_in) };
}

/* Google's own numbers for the account, which is what the cap is really about. */
export async function driveUsage(fetchImpl, token) {
  const res = await tryFetch(fetchImpl, ABOUT_URL + "?fields=storageQuota", { headers: auth(token) });
  if (!res.ok) return { ok: false, reason: res.reason, used: 0, limit: 0 };
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) { json = null; }
  const q = isObj(json) && isObj(json.storageQuota) ? json.storageQuota : {};
  return { ok: true, reason: "", used: intOf(q.usage), limit: intOf(q.limit) };
}

/* One file, one request, and the ledger updated only if the bytes landed. */
export async function uploadUnit(fetchImpl, token, unit, opts) {
  const o = isObj(opts) ? opts : {};
  if (!isObj(unit) || !unit.gz || !unit.name) return { ok: false, reason: "not a packed unit", id: "" };
  const meta = { name: unit.name, mimeType: "application/gzip" };
  if (typeof o.folderId === "string" && o.folderId) meta.parents = [o.folderId];
  const boundary = "los" + unit.sha256.slice(0, 24);
  const body = Buffer.concat([
    Buffer.from("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n", "utf8"),
    Buffer.from("--" + boundary + "\r\nContent-Type: application/gzip\r\n\r\n", "utf8"),
    Buffer.from(unit.gz),
    Buffer.from("\r\n--" + boundary + "--\r\n", "utf8")
  ]);
  const res = await tryFetch(fetchImpl, UPLOAD_URL + "?uploadType=multipart&fields=id,size", {
    method: "POST",
    headers: Object.assign(auth(token), { "content-type": "multipart/related; boundary=" + boundary }),
    body
  });
  if (!res.ok) return { ok: false, reason: res.reason, id: "" };
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) { json = null; }
  const id = isObj(json) && typeof json.id === "string" ? json.id : "";
  if (!id) return { ok: false, reason: "upload returned no file id", id: "" };
  /* Drive reports what it stored. If that is not what we sent, the upload is a
   * failure, not a success with a footnote — a half unit would fail a
   * volunteer's digest and look like their fault. */
  const stored = intOf(json.size);
  if (stored && stored !== unit.bytes) {
    return { ok: false, reason: "Drive stored " + stored + " bytes of " + unit.bytes + " — treating as failed", id, partial: true };
  }
  return { ok: true, reason: "", id, bytes: unit.bytes };
}

export async function deleteFile(fetchImpl, token, id, ledger) {
  if (ledger !== undefined && !ledgerOwns(ledger, id)) {
    return { ok: false, reason: "refusing to delete " + String(id) + ": this project's ledger does not own it" };
  }
  const res = await tryFetch(fetchImpl, FILES_URL + "/" + encodeURIComponent(String(id)), { method: "DELETE", headers: auth(token) });
  if (!res.ok) return { ok: false, reason: res.reason };
  if (ledger !== undefined) recordDelete(ledger, id);
  return { ok: true, reason: "" };
}

/* ————————————————————————— the run ————————————————————————— */

/* Upload a planned set, stopping BEFORE the file that would cross the cap.
 * Returns what landed, what did not, and why — never a thrown exception. */
export async function uploadPlan(fetchImpl, token, plan, state, opts) {
  const o = isObj(opts) ? opts : {};
  const ledger = isObj(state) && isObj(state.ledger) ? state.ledger : newLedger();
  const rec = reconcile(ledger, isObj(state) ? state.driveUsedBytes : 0);
  let effective = rec.effective_bytes;
  const out = { uploaded: [], refused: [], warnings: [], reconcile: rec, stopped: "" };
  if (!rec.in_slack) {
    out.warnings.push("the ledger and Drive disagree by " + gb(rec.gap_bytes)
      + " (ledger " + gb(rec.ledger_bytes) + ", Drive " + gb(rec.drive_bytes)
      + "). Using the larger for every limit decision.");
  }
  const units = isObj(plan) && Array.isArray(plan.units) ? plan.units : [];
  for (const unit of units) {
    const gate = canAccept(effective, unit.bytes, o.cap || CAP_BYTES);
    if (!gate.ok) {
      out.refused.push({ name: unit.name, bytes: unit.bytes, reason: gate.reason });
      out.stopped = gate.reason;
      break;                       // a cap is a wall, not a filter to squeeze past
    }
    if (gate.warn && !out.warnings.includes(gate.warn)) out.warnings.push(gate.warn);
    const up = await uploadUnit(fetchImpl, token, unit, o);
    if (!up.ok) { out.refused.push({ name: unit.name, bytes: unit.bytes, reason: up.reason }); continue; }
    recordUpload(ledger, up.id, { name: unit.name, bytes: unit.bytes, sha256: unit.sha256, at: intOf(o.now) });
    effective += unit.bytes;
    out.uploaded.push({ id: up.id, name: unit.name, bytes: unit.bytes, sha256: unit.sha256 });
  }
  out.ledger = ledger;
  out.total_after = effective;
  out.headroom_bytes = Math.max(0, (o.cap || CAP_BYTES) - effective);
  return out;
}

/* ————————————————————————— plumbing ————————————————————————— */

const auth = (token) => ({ authorization: "Bearer " + (typeof token === "string" ? token : "") });

async function safeText(res) {
  if (!res || typeof res.text !== "function") return "";
  try { return await res.text(); } catch (_) { return ""; }
}

/* A remote's own error body is the most useful thing in a failure and is safe
 * to print — it describes OUR request back to us — but it is redacted and
 * capped anyway, because a tool should never be the reason a secret escapes. */
export function redact(text) {
  if (typeof text !== "string" || text === "") return "";
  const clean = text
    .replace(/\b(ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9._-]{20,}|[A-Za-z0-9._-]{40,})\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? " — " + clean.slice(0, 240) : "";
}

async function tryFetch(fetchImpl, url, init) {
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no fetch available", body: "" };
  let res = null;
  try { res = await fetchImpl(url, init); } catch (err) {
    return { ok: false, reason: "request failed: " + (err && err.code ? err.code : "error"), body: "" };
  }
  const body = await safeText(res);
  if (!res || !res.ok) return { ok: false, reason: "HTTP " + (res && res.status) + redact(body), body };
  return { ok: true, reason: "", body };
}

/* ————————————————————————— selftest (offline) ————————————————————————— */

export function selftest() {
  let checks = 0, failed = 0;
  const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
  const landmine = () => { throw new Error("the selftest must not touch the network"); };

  /* 1. the ledger */
  const L = newLedger();
  ok(ledgerTotal(L) === 0 && ledgerCount(L) === 0, "a new ledger is empty");
  recordUpload(L, "id-a", { name: "a", bytes: 1000, sha256: "a".repeat(64), at: 1 });
  recordUpload(L, "id-b", { name: "b", bytes: 2000, sha256: "b".repeat(64), at: 2 });
  ok(ledgerTotal(L) === 3000 && ledgerCount(L) === 2, "the ledger totals what it recorded (" + ledgerTotal(L) + ")");
  recordUpload(L, "id-c", { name: "c", bytes: 0 });
  ok(ledgerCount(L) === 2, "bytes that did not land are never recorded");
  ok(recordDelete(L, "not-ours").ok === false, "deleting a file the ledger does not own is refused");
  ok(recordDelete(L, "id-a").ok === true && ledgerTotal(L) === 2000, "deleting one it owns updates the total");

  /* 2. a hostile ledger from a remote */
  const hostile = readLedger('{"files":{"x":{"bytes":"not a number"},"y":{"bytes":5,"sha256":"nope"},"__proto__":{"bytes":9}}}');
  ok(ledgerTotal(hostile) === 5, "a hostile ledger yields only the entries that parse (" + ledgerTotal(hostile) + ")");
  ok(hostile.files.y.sha256 === "", "a malformed digest is dropped, not trusted");
  ok(Object.keys(hostile.files).length === 1 && ({}).bytes === undefined && Object.getPrototypeOf(hostile.files) === Object.prototype,
     "a __proto__ key in a fetched ledger is skipped and pollutes nothing");
  ok(ledgerTotal(readLedger("{{{")) === 0 && ledgerTotal(readLedger(null)) === 0, "unparseable input is an empty ledger, never a throw");

  /* 3. THE CAP — the owner's number, enforced before the write */
  ok(CAP_BYTES === 120 * GB, "the cap is the owner's 120 GB");
  const under = canAccept(10 * GB, 1 * GB);
  ok(under.ok === true && !under.warn, "a write well under the cap is accepted with no warning");
  const warned = canAccept(101 * GB, 1 * GB);
  ok(warned.ok === true && /APPROACHING THE LIMIT/.test(warned.warn), "past 100 GB the write is allowed WITH a warning");
  const over = canAccept(119.5 * GB, 1 * GB);
  ok(over.ok === false && /120\.00 GB limit would be exceeded/.test(over.reason), "a write that would cross 120 GB is refused: " + over.reason.slice(0, 60));
  ok(/Nothing was uploaded/.test(over.reason), "…and the refusal says nothing was uploaded");
  ok(canAccept(0, 0).ok === false, "a zero-byte write is refused");
  ok(canAccept(CAP_BYTES, 1).ok === false, "at exactly the cap, one more byte is refused");
  ok(canAccept(CAP_BYTES - 1, 1).ok === true, "one byte below the cap, that byte is allowed");

  /* 4. reconcile takes the SAFER number */
  const r1 = reconcile({ files: { a: { bytes: 10 * GB } } }, 40 * GB);
  ok(r1.effective_bytes === 40 * GB && /drive/.test(r1.source), "when Drive reports more, Drive decides");
  const r2 = reconcile({ files: { a: { bytes: 50 * GB } } }, 20 * GB);
  ok(r2.effective_bytes === 50 * GB && r2.source === "ledger", "when the ledger knows more, the ledger decides");
  ok(reconcile({ files: {} }, 0).in_slack === true, "no gap is inside the slack");
  ok(reconcile({ files: { a: { bytes: 5 * GB } } }, 0).in_slack === false, "a 5 GB gap is reported, not swallowed");

  /* 5. packing: sorted, deduplicated, digest-named */
  const mols = [
    { cid: "22", smiles: "CCO" }, { cid: "3", smiles: "CC" }, { cid: "7", smiles: "c1ccccc1" },
    { cid: "bad", smiles: "CCO" }, { cid: "9", smiles: "" }, { cid: "11", smiles: "x".repeat(500) }, null
  ];
  const packed = packUnit(mols);
  ok(packed.rows === 3, "only well-formed rows are packed (" + packed.rows + " of " + mols.length + ")");
  ok(/^unit-[0-9a-f]{16}\.json\.gz$/.test(packed.name), "a unit is named by its own digest (" + packed.name + ")");
  const shuffled = packUnit([{ cid: "7", smiles: "c1ccccc1" }, { cid: "22", smiles: "CCO" }, { cid: "3", smiles: "CC" }]);
  ok(shuffled.sha256 === packed.sha256, "the same molecules in a different order are the same bytes");
  ok(packed.bytes > 0 && packed.bytes < UNIT_BYTES_MAX, "a small unit is well under the size refusal");

  const many = [];
  for (let i = 1; i <= 1200; i++) many.push({ cid: String(i), smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" });
  const plan = planUnits(many, 500);
  ok(plan.units.length === 3, "1,200 molecules at 500 each is three unit files (" + plan.units.length + ")");
  ok(plan.total_rows === 1200, "every molecule is in exactly one unit (" + plan.total_rows + ")");
  const block = many.slice(0, 500);
  const dup = planUnits(block.concat(block), 500);
  ok(dup.duplicates === 1 && dup.units.length === 1, "the same 500 molecules twice is ONE unit file (" + dup.duplicates + " duplicate dropped)");
  const straddle = planUnits(many.concat(block), 500);
  ok(straddle.duplicates === 0 && straddle.total_rows === 1700,
     "…but a repeat that does not align to a boundary is different bytes and is kept (" + straddle.total_rows + " rows)");

  /* 6. the upload loop stops AT the wall, and leaves the ledger true */
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push(String(url).split("?")[0]);
    if (String(url).startsWith(UPLOAD_URL)) {
      const id = "file-" + calls.length;
      const size = init && init.body ? Buffer.byteLength(init.body) : 0;
      return { ok: true, status: 200, text: async () => JSON.stringify({ id, size: 0 }) };   // size 0 = "not reported"
    }
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const big = { units: [{ name: "u1", bytes: 60 * GB, gz: Buffer.from("a"), sha256: "1".repeat(64) },
                        { name: "u2", bytes: 55 * GB, gz: Buffer.from("b"), sha256: "2".repeat(64) },
                        { name: "u3", bytes: 30 * GB, gz: Buffer.from("c"), sha256: "3".repeat(64) },
                        { name: "u4", bytes: 1, gz: Buffer.from("d"), sha256: "4".repeat(64) }] };
  return (async () => {
    const run = await uploadPlan(mockFetch, "tok", big, { ledger: newLedger(), driveUsedBytes: 0 }, { now: 1 });
    ok(run.uploaded.length === 2, "two 60+55 GB units fit under 120 GB (" + run.uploaded.length + ")");
    ok(run.refused.length === 1 && /limit would be exceeded/.test(run.refused[0].reason), "the third is refused at the wall");
    ok(run.stopped !== "" && run.uploaded.length + run.refused.length === 3, "the run STOPS at the wall — it does not skip ahead to the 1-byte unit");
    ok(ledgerTotal(run.ledger) === 115 * GB, "the ledger holds exactly what landed (" + gb(ledgerTotal(run.ledger)) + ")");
    ok(/APPROACHING THE LIMIT/.test(run.warnings.join(" ")), "…and the 100 GB warning was raised on the way");
    ok(run.headroom_bytes === 5 * GB, "headroom is reported (" + gb(run.headroom_bytes) + ")");

    /* 7. a partial upload is a failure, never a quiet success */
    const shortFetch = async (url) => String(url).startsWith(UPLOAD_URL)
      ? { ok: true, status: 200, text: async () => JSON.stringify({ id: "f1", size: 5 }) }
      : { ok: true, status: 200, text: async () => "{}" };
    const one = { units: [{ name: "u", bytes: 999, gz: Buffer.from("x"), sha256: "5".repeat(64) }] };
    const part = await uploadPlan(shortFetch, "tok", one, { ledger: newLedger(), driveUsedBytes: 0 }, {});
    ok(part.uploaded.length === 0 && /treating as failed/.test(part.refused[0].reason), "Drive storing fewer bytes than we sent is a failure");
    ok(ledgerTotal(part.ledger) === 0, "…and nothing is recorded for it");

    /* 8. a remote that answers badly is a reason, never an exception */
    const angry = async () => ({ ok: false, status: 403, text: async () => '{"error":{"message":"Rate Limit Exceeded"}}' });
    const bad = await uploadPlan(angry, "tok", one, { ledger: newLedger(), driveUsedBytes: 0 }, {});
    ok(bad.uploaded.length === 0 && /HTTP 403/.test(bad.refused[0].reason) && /Rate Limit/.test(bad.refused[0].reason),
       "a 403 is reported with the service's own words: " + bad.refused[0].reason.slice(0, 70));
    const dead = async () => { const e = new Error("https://oauth2.googleapis.com/token?secret=ya29.LEAK"); e.code = "ECONNREFUSED"; throw e; };
    const off = await uploadPlan(dead, "tok", one, { ledger: newLedger(), driveUsedBytes: 0 }, {});
    ok(/ECONNREFUSED/.test(off.refused[0].reason) && !/ya29/.test(off.refused[0].reason), "a thrown request is reported by CODE, never by message");

    /* 9. the token exchange keeps its secrets */
    const tokFetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ access_token: "ya29.SECRET", expires_in: 3599 }) });
    const t = await accessToken(tokFetch, { clientId: "c", clientSecret: "s", refreshToken: "r" });
    ok(t.ok === true && t.token === "ya29.SECRET", "a refresh token is exchanged for an access token");
    const t2 = await accessToken(tokFetch, { clientId: "c" });
    ok(t2.ok === false && /missing clientSecret/.test(t2.reason), "an incomplete credential is refused by name, before any request");
    const t3 = await accessToken(async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }), { clientId: "c", clientSecret: "s", refreshToken: "r" });
    ok(t3.ok === false && /invalid_grant/.test(t3.reason), "a refused grant says which: " + t3.reason.slice(0, 60));
    ok(redact("token ya29.abcdefghijklmnop and 1//0abcdefghijklmnopqrstuvwx") .includes("[redacted]"), "token-shaped strings are redacted from any body we print");
    ok(!redact("ya29." + "z".repeat(60)).includes("z".repeat(60)), "…including a long one");

    /* 10. delete never touches a stranger's file */
    const del = await deleteFile(landmine, "tok", "someone-elses", newLedger());
    ok(del.ok === false && /does not own it/.test(del.reason), "delete refuses before it fetches when the ledger does not own the id");

    /* 11. usage */
    const usage = await driveUsage(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ storageQuota: { usage: String(7 * GB), limit: String(200 * GB) } }) }), "t");
    ok(usage.ok === true && usage.used === 7 * GB, "Drive's own usage is read as an integer (" + gb(usage.used) + ")");

    console.log(failed ? `drive selftest: ${failed} FAILED of ${checks}` : `drive selftest: ${checks} checks passed ✓`);
    return failed ? 1 : 0;
  })();
}

/* ————————————————————————— CLI ————————————————————————— */

const invokedDirectly = (() => {
  const entry = process.argv && process.argv[1];
  if (!entry) return false;
  let self;
  try { self = fileURLToPath(import.meta.url); } catch (e) { return false; }
  try { if (realpathSync(entry) === realpathSync(self)) return true; } catch (e) { /* fall through */ }
  try { return resolve(entry) === self; } catch (e) { return false; }
})();

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) {
    Promise.resolve(selftest()).then((code) => process.exit(code || 0));
  } else if (argv.includes("--plan")) {
    /* A capacity figure is only as honest as the sample it is measured on.
     * One molecule repeated N times gzips to almost nothing and would print a
     * capacity of tens of billions, which is a lie about a real corpus — so
     * the sample is deliberately varied, and the line says what it was
     * measured on rather than promising anything about PubChem. */
    const SAMPLE = [
      "CC(=O)OC1=CC=CC=C1C(=O)O", "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "CN(C)C(=N)N=C(N)N",
      "CC12CCC3C(C1CCC2O)CCC4=CC(=O)CCC34C", "O=C1C(O)=C(Oc2cc(O)cc(O)c12)c1ccc(O)c(O)c1",
      "CC1=NC(=CC(=C1Cl)NC(=O)C2=CN=C(S2)NC3=CC(=NC(=N3)C)N4CCN(CC4)CCO)C",
      "CS(=O)(=O)c1ccc(cc1)[N+](=O)[O-]", "c1ccc2[nH]ccc2c1", "C1COCCOCCOCCOCCOCCO1", "N#Cc1ccccc1C#N"
    ];
    const n = Number(argv[argv.indexOf("--plan") + 1]) || 10000;
    const mols = [];
    for (let i = 1; i <= n; i++) {
      /* vary the structure AND the id, the way a real harvest does */
      const base = SAMPLE[i % SAMPLE.length];
      mols.push({ cid: String(1000000 + i), smiles: i % 3 === 0 ? base + ".[Na+]" : base });
    }
    const plan = planUnits(mols);
    const perMolecule = plan.total_bytes / Math.max(1, plan.total_rows);
    console.log("plan: " + plan.units.length + " unit files, " + plan.total_rows.toLocaleString("en-US")
      + " molecules, " + gb(plan.total_bytes) + " (" + plan.total_bytes.toLocaleString("en-US") + " bytes)");
    console.log("measured on this sample: " + perMolecule.toFixed(1) + " bytes per molecule, gzipped, "
      + UNIT_MOLECULES + " per unit file");
    console.log("at that density the owner's " + gb(CAP_BYTES) + " would hold about "
      + Math.floor(CAP_BYTES / Math.max(1, perMolecule)).toLocaleString("en-US")
      + " molecules — a SAMPLE figure, not a promise about PubChem, whose structures are longer and more varied");
  } else {
    console.log("drive.mjs is a module. Try --selftest (offline) or --plan <n>.");
  }
}
