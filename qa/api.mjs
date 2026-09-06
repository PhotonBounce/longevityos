/* api — the swarm server, exercised as a REAL server.
 *
 * Spawns `php -S` against saas/api with a throwaway database and drives the
 * whole protocol the way volunteers and the harvester will: join, ingest,
 * fetch work, submit, reach consensus, get caught cheating. The redundancy
 * rules are the product here — a server that credits a single unverified
 * submission would turn the hit list into whatever one stranger typed.
 *
 * Everything runs offline against a temp DB and cleans up after itself.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { targetsDigest } from "../app/js/chem/targets.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, "..", "saas", "api");

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

if (!existsSync(join(API, "index.php"))) {
  console.error("saas/api/index.php is missing — the swarm server has not been built");
  process.exit(1);
}

/* ————— a throwaway install: temp data dir + temp private key dir ————— */
const sandbox = mkdtempSync(join(tmpdir(), "los-api-"));
const dataDir = join(API, "data");
const keyDir = join(API, "..", "..", "los-private");
const hadData = existsSync(dataDir);
const hadKey = existsSync(keyDir);
if (hadData) { console.error("refusing to run: saas/api/data already exists (that would be a live database)"); process.exit(1); }

const PORT = 8300 + (process.pid % 400);
const php = spawn("php", ["-S", "127.0.0.1:" + PORT, "-t", API], { stdio: ["ignore", "pipe", "pipe"] });
let phpErr = "";
php.stderr.on("data", (d) => { phpErr += String(d); });
const cleanup = () => {
  try { php.kill("SIGKILL"); } catch (_) {}
  try { rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
  if (!hadData) { try { rmSync(dataDir, { recursive: true, force: true }); } catch (_) {} }
  if (!hadKey) { try { rmSync(keyDir, { recursive: true, force: true }); } catch (_) {} }
};
process.on("exit", cleanup);

const BASE = `http://127.0.0.1:${PORT}/index.php`;
const call = async (qs, body) => {
  const url = BASE + "?" + qs;
  const res = body === undefined
    ? await fetch(url)
    : await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text, bytes: text.length };
};

/* wait for the server to answer */
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await call("a=health"); up = r.status === 200; } catch (_) { await new Promise((r) => setTimeout(r, 150)); }
}
if (!up) { console.error("php -S never came up:\n" + phpErr); cleanup(); process.exit(1); }

/* ————— 1. health, and the fail-closed ingest key ————— */
suite("api 1 — health and the fail-closed key");
const health = await call("a=health");
ok(health.status === 200 && health.json && health.json.ok === true, "health responds");
ok(typeof health.json.engine === "string", "health reports the engine version");
ok(health.json.ingest_armed === false, "with no key file, health reports the ingest door as unarmed");
ok(!/ingest-key|los-private|\/home\//.test(health.text), "health never leaks a filesystem path");

const noKeyIngest = await call("a=ingest", { key: "guess", molecules: [{ cid: "1", smiles: "CCO" }] });
ok(noKeyIngest.status === 403, `ingest without a configured key is refused, not opened (got ${noKeyIngest.status})`);

/* arm the key the way the deploy does: OUTSIDE the web root */
mkdirSync(keyDir, { recursive: true });
const KEY = "test-ingest-key-" + PORT;
writeFileSync(join(keyDir, "ingest-key.txt"), KEY + "\n");
ok((await call("a=health")).json.ingest_armed === true, "once the key file exists, health reports the door armed");
ok((await call("a=ingest", { key: "wrong-key", molecules: [] })).status === 403, "a wrong key is refused");

/* ————— 2. harvester ingest ————— */
suite("api 2 — harvester ingest");
const MOLS = [
  { cid: "2244", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", formula: "C9H8O4", source: "qa" },
  { cid: "2519", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", formula: "C8H10N4O2", source: "qa" },
  { cid: "1983", smiles: "CC(=O)NC1=CC=C(O)C=C1", formula: "C8H9NO2", source: "qa" },
  { cid: "750",  smiles: "NCC(=O)O", formula: "C2H5NO2", source: "qa" }
];
/* an unpinned server must not hand out work nobody could verify */
const preTok = (await call("a=join", { name: "early" })).json;
const preWork = await call("a=work&token=" + preTok.token);
ok(preWork.json && preWork.json.idle === true,
   "before any harvest pins the reference set, the server issues NO work — an unverifiable unit is worse than no unit");
ok(/pinned|reference set/i.test(preWork.json.message || ""), "and it says why, in plain language");

/* the real harvester always sends the reference digest with its delivery */
const ing = await call("a=ingest", { key: KEY, targets_digest: targetsDigest(), molecules: MOLS });
ok(ing.status === 200 && ing.json.added === 4, `4 molecules ingested (got ${ing.json && ing.json.added})`);
ok((await call("a=health")).json.targets_digest === targetsDigest(),
   "the delivery pinned the server to this engine's reference set");
const again = await call("a=ingest", { key: KEY, targets_digest: targetsDigest(), molecules: MOLS });
ok(again.json.added === 0 && again.json.skipped === 4, "re-ingesting the same CIDs adds nothing (idempotent)");
const hostileIngest = await call("a=ingest", {
  key: KEY, targets_digest: targetsDigest(),
  molecules: [{ cid: "'; DROP TABLE molecules;--", smiles: "CCO" }, { cid: "9999", smiles: "x".repeat(9000) }]
});
ok(hostileIngest.status === 200, "hostile ingest rows are handled, not fatal");
ok((await call("a=health")).json.molecules >= 4, "the molecules table survived a SQL-shaped cid");

/* ————— 3. joining and being issued work ————— */
suite("api 3 — join and work issue");
const alice = (await call("a=join", { name: "alice" })).json;
const bob = (await call("a=join", { name: "bob" })).json;
ok(/^[0-9a-f]{32}$/.test(alice.token || ""), "join returns a 32-hex device token");
ok(alice.token !== bob.token, "two joins get different tokens");
ok(alice.name === "alice", "a display name is kept");
const evil = (await call("a=join", { name: "<script>alert(1)</script>" })).json;
ok(!/[<>]/.test(evil.name || ""), `a script-shaped display name is stripped (got ${JSON.stringify(evil.name)})`);

const wA = await call("a=work&token=" + alice.token);
ok(wA.status === 200 && wA.json.unit && Array.isArray(wA.json.unit.molecules), "alice is issued a work unit");
ok(wA.json.unit.molecules.length > 0, "the unit carries molecules");
ok(typeof wA.json.unit.unit_id === "string" && wA.json.unit.unit_id.length >= 8, "the unit has an id");
ok(typeof wA.json.unit.engine === "string" && typeof wA.json.unit.targets_digest === "string",
   "the unit names the engine and reference set it must be screened with");
ok(wA.bytes < 10240, `a work response stays under 10KB (${wA.bytes} bytes)`);
ok((await call("a=work&token=deadbeef")).status === 401, "an unknown token cannot draw work");

const wB = await call("a=work&token=" + bob.token);
ok(wB.json.unit && wB.json.unit.unit_id === wA.json.unit.unit_id,
   "the SAME unit is issued to a second volunteer — redundancy is how a result gets verified");

/* ————— 4. consensus: one submission is never enough ————— */
suite("api 4 — two independent agreements make a result");
const unit = wA.json.unit;
/* real submissions carry structural-alert flags; the hit list is where a
   chemist reads them, so they have to survive the whole round trip */
const results = unit.molecules.map((m, i) => ({
  id: String(m.id), score: 500 + i, best: "mtor",
  flags: i === 0 ? ["nitro_aromatic", "michael_acceptor"] : []
}));
const DIGEST = "a".repeat(64);

const s1 = await call("a=submit", { token: alice.token, unit_id: unit.unit_id, digest: DIGEST, results });
ok(s1.status === 200 && s1.json.accepted === true, "alice's submission is accepted");
ok(s1.json.status === "pending", `one submission is only PENDING, never verified (got ${s1.json.status})`);
ok((await call("a=hits&limit=10")).json.hits.length === 0, "nothing reaches the hit list on one opinion");

const dup = await call("a=submit", { token: alice.token, unit_id: unit.unit_id, digest: DIGEST, results });
ok(dup.json.accepted === false || dup.json.status !== "confirmed",
   "alice cannot confirm her own work by submitting twice");

const s2 = await call("a=submit", { token: bob.token, unit_id: unit.unit_id, digest: DIGEST, results });
ok(s2.json.status === "confirmed", `two independent agreeing digests confirm the unit (got ${s2.json.status})`);
const hits = await call("a=hits&limit=50");
ok(hits.json.hits.length === unit.molecules.length, "the confirmed molecules reach the hit list");
ok(hits.json.hits.every((h) => Number.isInteger(h.score)), "hit scores are integers");
/* the flags the volunteers computed must arrive intact: this column read
   "not reported" for every row until the hits query started selecting it */
ok(hits.json.hits.every((h) => Array.isArray(h.flags)), "every hit carries a flags array");
const flagged = hits.json.hits.find((h) => h.flags && h.flags.length);
ok(flagged && flagged.flags.includes("nitro_aromatic"),
   "the structural alerts a volunteer computed survive the round trip into the hit list");
ok(hits.bytes < 10240, `the hits response stays under 10KB (${hits.bytes} bytes)`);

/* ————— 5. disagreement is quarantined, not averaged ————— */
suite("api 5 — conflict handling");
const carol = (await call("a=join", { name: "carol" })).json;
const dave = (await call("a=join", { name: "dave" })).json;
const wC = await call("a=work&token=" + carol.token);
if (wC.json.unit) {
  const u2 = wC.json.unit;
  const r2 = u2.molecules.map((m) => ({ id: String(m.id), score: 100, best: "ampk", flags: [] }));
  await call("a=submit", { token: carol.token, unit_id: u2.unit_id, digest: "b".repeat(64), results: r2 });
  const wD = await call("a=work&token=" + dave.token);
  if (wD.json.unit && wD.json.unit.unit_id === u2.unit_id) {
    const conflict = await call("a=submit", { token: dave.token, unit_id: u2.unit_id, digest: "c".repeat(64), results: r2 });
    ok(conflict.json.status === "conflict" || conflict.json.status === "pending",
       `two DIFFERENT digests never confirm (got ${conflict.json.status})`);
    const hits2 = await call("a=hits&limit=50");
    ok(hits2.json.hits.length === unit.molecules.length,
       "a conflicted unit adds nothing to the hit list");
  } else { ok(true, "conflict path: no second issue available (acceptable)"); }
} else { ok(true, "conflict path: no further work pending (acceptable)"); }

/* ————— 6. canaries catch a liar ————— */
suite("api 6 — canary units catch fabricated results");
const canaryUnitId = "canary-" + PORT;
const setC = await call("a=canary", { key: KEY, unit_id: canaryUnitId, digest: "d".repeat(64), molecules: MOLS.slice(0, 2) });
ok(setC.status === 200, "a canary unit with a known-good digest can be stored");
const mallory = (await call("a=join", { name: "mallory" })).json;
const lie = await call("a=submit", {
  token: mallory.token, unit_id: canaryUnitId, digest: "0".repeat(64),
  results: MOLS.slice(0, 2).map((m, i) => ({ id: String(i + 1), score: 999, best: "mtor", flags: [] }))
});
ok(lie.json.status === "canary_failed" || lie.json.credited === 0 || lie.json.accepted === false,
   `a wrong canary digest is refused and uncredited (got ${JSON.stringify(lie.json)})`);

/* ————— 7. hostile input ————— */
suite("api 7 — hostile input");
const bad = [
  ["a=submit", { token: alice.token, unit_id: "nope", digest: "x".repeat(64), results: [] }, "unknown unit"],
  ["a=submit", { token: alice.token, unit_id: unit.unit_id, digest: "not-hex", results: [] }, "non-hex digest"],
  ["a=submit", { token: alice.token, unit_id: unit.unit_id, digest: DIGEST, results: "not-an-array" }, "results not an array"],
  ["a=submit", { token: alice.token, unit_id: unit.unit_id, digest: DIGEST, results: [{ id: "1", score: 99999 }] }, "out-of-range score"],
  ["a=join", { name: 12345 }, "non-string name"],
  ["a=ingest", { key: KEY, molecules: "nope" }, "molecules not an array"],
  ["a=nonsense", undefined, "unknown action"]
];
for (const [qs, body, label] of bad) {
  const r = await call(qs, body);
  ok(r.status >= 200 && r.status < 500, `${label}: answered with a real status, not a 500 (got ${r.status})`);
  ok(!/Fatal error|Stack trace|\/home\/|PDOException/i.test(r.text), `${label}: no stack trace or path leaked`);
}
const sqli = await call("a=work&token=" + encodeURIComponent("' OR 1=1--"));
ok(sqli.status === 401, "a SQL-injection-shaped token is just an unknown token");
ok((await call("a=health")).json.ok === true, "the server is still healthy after the hostile pass");

/* ————— 8. stats ————— */
suite("api 8 — public stats");
const stats = await call("a=stats");
ok(stats.status === 200 && stats.json.totals, "stats responds");
for (const k of ["harvested", "screened", "verified", "contributors"]) {
  ok(typeof stats.json.totals[k] === "number", `stats reports ${k}`);
}
ok(Array.isArray(stats.json.leaderboard), "stats carries a leaderboard");
ok(stats.json.leaderboard.length <= 20, "the leaderboard is capped at 20 rows");
ok(stats.bytes < 10240, `stats stays under 10KB (${stats.bytes} bytes)`);
ok(!JSON.stringify(stats.json).includes(alice.token), "no contributor token is ever echoed in public stats");

cleanup();
console.log(failed ? "api: " + failed + " FAILED of " + checks : "api: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
