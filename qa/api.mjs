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
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { targetsDigest, ENGINE_VERSION, TARGETS } from "../app/js/chem/targets.js";
import { screenUnit, referenceSet } from "../app/js/chem/score.js";
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
  const r2 = u2.molecules.map((m) => ({ id: String(m.id), score: 100, best: "metabolic_ampk", flags: [] }));
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

/* ————— a sqlite3-free way into the throwaway database ————— */
/* The suite seeds and inspects the SQLite file through PHP's own PDO driver, so
   it needs nothing the server itself does not: 499 members to fill a team to
   its cap, 24-character names for the byte budget, and the proof that a
   departed contributor's results rows are still there. Every statement below is
   a literal written here — never a value from a response. They run in one
   BEGIN IMMEDIATE and the last SELECT's rows come back. */
const DB_FILE = join(dataDir, "los.sqlite");
const SQL_RUNNER = [
  '$a = array_slice($argv, -2);',
  '$p = new PDO("sqlite:" . $a[0]);',
  '$p->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);',
  '$p->exec("PRAGMA busy_timeout = 8000");',
  '$p->exec("BEGIN IMMEDIATE");',
  '$rows = array();',
  'foreach (json_decode($a[1], true) as $s) {',
  '  $st = $p->query($s);',
  '  $rows = $st->columnCount() ? $st->fetchAll(PDO::FETCH_ASSOC) : array();',
  '  $st->closeCursor();',
  '}',
  '$p->exec("COMMIT");',
  'echo json_encode($rows);'
].join("\n");
const sql = (...stmts) => {
  const r = spawnSync("php", ["-r", SQL_RUNNER, "--", DB_FILE, JSON.stringify(stmts)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("sql helper failed: " + (r.stderr || r.stdout));
  return JSON.parse(r.stdout);
};
const count = (where) => Number(sql(`SELECT COUNT(*) AS n FROM ${where}`)[0].n);

/* ————— 9. teams ————— */
suite("api 9 — teams");
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const TEAM_KEYS = ["id", "code", "name", "members", "units", "credits"];
const tessa = (await call("a=join", { name: "tessa" })).json;
const toby = (await call("a=join", { name: "toby" })).json;
const tara = (await call("a=join", { name: "tara" })).json;

const c1 = await call("a=team_create", { token: tessa.token, name: "Night Owls" });
ok(c1.status === 200 && c1.json && c1.json.team, `team_create answers 200 with a team (got ${c1.status} ${c1.text.slice(0, 80)})`);
const team1 = c1.json.team || {};
ok(Object.keys(team1).sort().join() === TEAM_KEYS.slice().sort().join(),
   `the private team shape is exactly {${TEAM_KEYS.join(", ")}} (got ${Object.keys(team1).join(",")})`);
ok(Number.isInteger(team1.id) && team1.id > 0, "a team has an integer id");
ok(CODE_RE.test(team1.code || ""), `the join code is 8 characters from A-HJ-NP-Z2-9 (got ${team1.code})`);
ok(team1.name === "Night Owls", "the team name is kept");
ok(team1.members === 1 && team1.units === 0 && team1.credits === 0, "the creator is the one member, with nothing yet to add up");
ok(!c1.text.includes(tessa.token), "team_create never echoes the token");
const c1dup = await call("a=team_create", { token: tessa.token, name: "Second Nest" });
ok(c1dup.status === 409 && c1dup.json.error === "already_in_team", `creating while in a team is 409 already_in_team (got ${c1dup.status} ${c1dup.json && c1dup.json.error})`);
ok((await call("a=team_create", { token: "deadbeef", name: "Ghosts" })).status === 401, "an unknown token cannot create a team");

/* joining by code, lower-case and padded */
const j1 = await call("a=team_join", { token: toby.token, code: " " + team1.code.toLowerCase() + " " });
ok(j1.status === 200 && j1.json.team && j1.json.team.code === team1.code, "a second contributor joins by a lower-case, padded code");
ok(j1.json.team.members === 2, `the team now has 2 members (got ${j1.json.team && j1.json.team.members})`);
const j1again = await call("a=team_join", { token: toby.token, code: team1.code });
ok(j1again.status === 200 && j1again.json.team.members === 2, "joining the team you are already in is an idempotent success");

/* switching teams */
const c2 = await call("a=team_create", { token: tara.token, name: "Day Larks" });
const team2 = c2.json.team;
const sw = await call("a=team_join", { token: toby.token, code: team2.code });
ok(sw.status === 200 && sw.json.team.code === team2.code && sw.json.team.members === 2, "joining a different team switches you");
ok((await call("a=team&code=" + team1.code)).json.team.members === 1, "and the team you left no longer counts you");

/* leaving: idempotent, and the last visible member takes the team with them */
const l1 = await call("a=team_leave", { token: toby.token });
ok(l1.status === 200 && l1.json.ok === true, "team_leave answers ok");
const l2 = await call("a=team_leave", { token: toby.token });
ok(l2.status === 200 && l2.json.ok === true, "team_leave is idempotent");
ok((await call("a=team&code=" + team2.code)).json.team.members === 1, "the left team still stands while its creator is in it");
const c3 = await call("a=team_create", { token: toby.token, name: "Ephemeral" });
ok(c3.status === 200, "a contributor who left can found a new team");
await call("a=team_leave", { token: toby.token });
const gone = await call("a=team&code=" + c3.json.team.code);
ok(gone.status === 404 && gone.json.error === "unknown_team",
   `create -> leave -> ?a=team is 404: a team dies with its last member (got ${gone.status})`);
ok((await call("a=team_join", { token: toby.token, code: c3.json.team.code })).status === 404,
   "and its code cannot be joined afterwards");
ok(count("teams WHERE id = " + c3.json.team.id) === 0, "the emptied team row is really gone from the table");
/* switching out of a team you were alone in sweeps it too */
const swAlone = await call("a=team_join", { token: tessa.token, code: team2.code });
ok(swAlone.status === 200 && swAlone.json.team.members === 2, "tessa switches from her own team into tara's");
ok((await call("a=team&code=" + team1.code)).status === 404, "her old team, now empty, was swept in the same transaction");

/* the public shape and the board's ordering */
const me_tessa = (await call("a=me&token=" + tessa.token)).json.contributor;
const me_tara = (await call("a=me&token=" + tara.token)).json.contributor;
sql(`UPDATE contributors SET credits = 30, units = 3 WHERE id = ${me_tessa.id}`,
    `UPDATE contributors SET credits = 30, units = 2 WHERE id = ${me_tara.id}`);
const pub = await call("a=team&code=" + team2.code);
ok(pub.status === 200 && pub.json.team && Array.isArray(pub.json.board), "?a=team is public and carries a team and a board");
ok(Object.keys(pub.json.team).sort().join() === ["code", "name", "members", "units", "credits", "created_at"].sort().join(),
   `the public team shape is {code, name, members, units, credits, created_at} — no id (got ${Object.keys(pub.json.team).join(",")})`);
ok(Number.isInteger(pub.json.team.created_at) && pub.json.team.created_at > 1700000000, "created_at is an integer timestamp");
ok(pub.json.team.members === 2 && pub.json.team.credits === 60 && pub.json.team.units === 5,
   `members/units/credits are sums over the members (got ${JSON.stringify(pub.json.team)})`);
ok(pub.json.board.length === 2 && pub.json.board.every((r) => Object.keys(r).sort().join() === "credits,name,units"),
   "board rows are exactly {name, units, credits}");
ok(pub.json.board[0].name === "tessa" && pub.json.board[1].name === "tara",
   "equal credits order by units desc (tessa 3 units before tara 2)");
sql(`UPDATE contributors SET units = 3 WHERE id = ${me_tara.id}`);
const pub2 = (await call("a=team&code=" + team2.code)).json;
ok(pub2.board[0].name === (me_tessa.id < me_tara.id ? "tessa" : "tara"), "a full tie orders by id asc");
ok(!pub.text.includes(tessa.token) && !pub.text.includes(tara.token), "the public team page never carries a token");
ok(!/"id"/.test(JSON.stringify(pub.json.board)), "board rows carry no contributor ids");

/* unknown and malformed codes */
for (const [code, want, label] of [
  ["ZZZZZZZ2", 404, "a well-formed code nobody holds"],
  ["OOOO1111", 400, "letters outside the alphabet (O, 1)"],
  ["abc", 400, "too short"],
  ["", 400, "empty"],
  [team2.code + "A", 400, "too long"],
]) {
  const r = await call("a=team&code=" + encodeURIComponent(code));
  ok(r.status === want && typeof r.json.error === "string", `?a=team: ${label} is ${want} (got ${r.status})`);
  const rj = await call("a=team_join", { token: toby.token, code });
  ok(rj.status === want, `team_join: ${label} is ${want} (got ${rj.status})`);
}
ok((await call("a=team_join", { token: toby.token, code: 12345678 })).status === 400, "a numeric code is 400, not a lookup");
ok((await call("a=team_join", { token: toby.token, code: ["A"] })).status === 400, "an array code is 400");

/* name cleaning — the same stranger-typed-string rules as everywhere else */
const namer = (await call("a=join", { name: "namer" })).json;
const dirty = await call("a=team_create", { token: namer.token, name: "  \u200bLab\u0000 <script>alert(1)</script> Rats\u202e & \"Co\"  " });
ok(dirty.status === 200, "a hostile team name is cleaned, not fatal");
const dn = dirty.json.team ? dirty.json.team.name : "";
ok(!/[<>&"'\\`]/.test(dn) && /^[ -~]{2,24}$/.test(dn), `markup, quotes, control bytes and non-ASCII are stripped and 24 chars kept (got ${JSON.stringify(dn)})`);
await call("a=team_leave", { token: namer.token });
ok((await call("a=team_create", { token: namer.token, name: "x" })).json.error === "bad_name", "a one-character name is 400 bad_name");
ok((await call("a=team_create", { token: namer.token, name: "\u00e9\u00e9\u00e9" })).json.error === "bad_name", "a name that cleans to nothing is 400 bad_name");
const longName = await call("a=team_create", { token: namer.token, name: "N".repeat(10240) });
ok(longName.status === 200 && longName.json.team.name === "N".repeat(24), "a 10 KB name is cut to 24 characters");
await call("a=team_leave", { token: namer.token });
ok((await call("a=team_create", { token: namer.token, name: 12345 })).json.error === "bad_name", "a non-string name is 400 bad_name");

/* the create rate limit: 5 an hour per contributor */
const rater = (await call("a=join", { name: "rater" })).json;
let created = 0;
for (let i = 0; i < 5; i++) {
  const r = await call("a=team_create", { token: rater.token, name: "Burst " + i });
  if (r.status === 200) { created++; await call("a=team_leave", { token: rater.token }); }
}
ok(created === 5, `five creates in an hour are allowed (got ${created})`);
const sixth = await call("a=team_create", { token: rater.token, name: "Burst 6" });
ok(sixth.status === 429 && sixth.json.error === "rate_limited", `the sixth is 429 rate_limited (got ${sixth.status})`);
ok(count("teams WHERE name LIKE 'Burst %'") === 0, "every one of the burst teams was swept when its founder left");

/* the size cap: 500 visible members, checked under the write lock */
const capper = (await call("a=join", { name: "capper" })).json;
const capTeam = (await call("a=team_create", { token: capper.token, name: "Full House" })).json.team;
const tuples = [];
for (let i = 1; i < 500; i++) tuples.push(`('captoken${i}', 'cap ${i}', 0, 0, 0, 1, 1, ${capTeam.id}, 0)`);
sql("INSERT INTO contributors(token_hash, name, credits, units, flagged, created_at, last_seen, team_id, hidden) VALUES " + tuples.join(","));
ok((await call("a=team&code=" + capTeam.code)).json.team.members === 500, "a team seeded to 500 members reports 500");
const late = (await call("a=join", { name: "late" })).json;
const full = await call("a=team_join", { token: late.token, code: capTeam.code });
ok(full.status === 409 && full.json.error === "team_full", `the 501st join is 409 team_full (got ${full.status} ${full.json && full.json.error})`);
ok((await call("a=team_join", { token: capper.token, code: capTeam.code })).status === 200, "a member re-joining a full team is still the idempotent success");
ok((await call("a=team&code=" + capTeam.code)).json.board.length === 20, "a full team's board is capped at 20 rows");

/* ————— 10. public contributor records ————— */
suite("api 10 — public contributor records");
ok(Number.isInteger(alice.contributor) && alice.contributor > 0, "?a=join returns the contributor id the client builds its share link from");
const fresh = [
  { cid: "5090", smiles: "CC1=C(C=C(C=C1)NC(=O)C2=CC=C(C=C2)CN3CCN(CC3)C)NC4=NC=CC(=N4)C5=CN=CC=C5", formula: "C29H31N7O", source: "qa" },
  { cid: "4091", smiles: "CN(C)C(=N)N=C(N)N", formula: "C4H11N5", source: "qa" },
  { cid: "3672", smiles: "CC(C)CC1=CC=C(C=C1)C(C)C(=O)O", formula: "C13H18O2", source: "qa" },
];
ok((await call("a=ingest", { key: KEY, targets_digest: targetsDigest(), molecules: fresh })).json.added === 3, "three fresh molecules for the record tests");
const rec = (await call("a=join", { name: "recorder" })).json;
const rec2 = (await call("a=join", { name: "seconder" })).json;
/* draw work; a 1-in-20 draw is the suite-6 canary, whose answer we know */
const drawWork = async (token, wantId) => {
  for (let i = 0; i < 4; i++) {
    const w = await call("a=work&token=" + token);
    if (!w.json || !w.json.unit) return null;
    if (!wantId || w.json.unit.unit_id === wantId) return w.json.unit;
  }
  return null;
};
const answer = (u, digest) => ({ unit_id: u.unit_id, digest, results: u.molecules.map((m) => ({ id: String(m.id), score: 321, best: "metabolic_ampk", flags: [] })) });
const ru = await drawWork(rec.token);
let confirmed = null;
if (ru && ru.unit_id === canaryUnitId) {
  confirmed = await call("a=submit", { token: rec.token, ...answer(ru, "d".repeat(64)) });
} else if (ru) {
  await call("a=submit", { token: rec.token, ...answer(ru, "e".repeat(64)) });
  const ru2 = await drawWork(rec2.token, ru.unit_id);
  if (ru2) confirmed = await call("a=submit", { token: rec2.token, ...answer(ru2, "e".repeat(64)) });
}
ok(confirmed && confirmed.json.status === "confirmed", `the recorder's unit reaches consensus (got ${confirmed && confirmed.json.status})`);
const recPage = await call("a=contributor&id=" + rec.contributor);
ok(recPage.status === 200 && recPage.json.contributor, "?a=contributor is public and answers for a known id");
const rp = recPage.json.contributor || {};
ok(Object.keys(rp).sort().join() === ["id", "name", "units", "credits", "created_at", "rank", "team"].sort().join(),
   `the record shape is {id, name, units, credits, created_at, rank, team} (got ${Object.keys(rp).join(",")})`);
ok(rp.id === rec.contributor && rp.name === "recorder", "id and name match the join");
ok(rp.units === 1 && rp.credits === 10, `one confirmed unit = 1 unit, 10 credits (got ${rp.units}/${rp.credits})`);
const better = count("contributors WHERE hidden = 0 AND credits > 10");
ok(rp.rank === 1 + better, `rank is 1 + the visible contributors with more credits (got ${rp.rank}, expected ${1 + better})`);
ok(rp.team === null, "a contributor in no team shows team: null");
ok(!recPage.text.includes(rec.token), "the public record never carries a token");
await call("a=team_join", { token: rec.token, code: team2.code });
const rpTeam = (await call("a=contributor&id=" + rec.contributor)).json.contributor.team;
ok(rpTeam && rpTeam.code === team2.code && rpTeam.name === "Day Larks" && Object.keys(rpTeam).length === 2,
   "once in a team the record shows exactly {code, name}");

const meNo = await call("a=me");
ok(meNo.status === 401 && meNo.json.error === "unknown_token", "?a=me without a token is 401");
const meRec = await call("a=me&token=" + rec.token);
ok(meRec.status === 200 && Object.keys(meRec.json.contributor).sort().join() === ["id", "name", "units", "credits", "created_at", "team"].sort().join(),
   "?a=me is {id, name, units, credits, created_at, team} — the holder's own record, no rank");
ok(meRec.json.contributor.id === rec.contributor && meRec.json.contributor.credits === 10, "and it is this contributor's");

for (const bad of ["0", "-1", "1e3", "007", "abc", "99999999999999999999", "1.0", "+1", " 1", "1;DROP", ""]) {
  const r = await call("a=contributor&id=" + encodeURIComponent(bad));
  ok((r.status === 400 || r.status === 404) && r.json && typeof r.json.error === "string",
     `id ${JSON.stringify(bad)} is refused with 400/404 and a JSON error, never 500 (got ${r.status})`);
}
ok((await call("a=contributor&id=999999999")).json.error === "unknown_contributor", "a well-formed id nobody holds is 404 unknown_contributor");
ok((await call("a=contributor")).status === 400, "no id at all is 400");

/* ————— 11. leaving the public record ————— */
suite("api 11 — leave: hidden from every public surface, work never deleted");
const before = (await call("a=stats")).json;
ok(before.leaderboard.some((r) => r.name === "recorder"), "before leaving, the recorder is on the leaderboard");
ok((await call("a=team&code=" + team2.code)).json.board.some((r) => r.name === "recorder"), "and on the team board");
const resultsBefore = count(`results WHERE contributor = ${rec.contributor}`);
ok(resultsBefore >= 1, "the recorder has a results row");
const lv = await call("a=leave", { token: rec.token });
ok(lv.status === 200 && lv.json.ok === true, "?a=leave answers ok");
ok((await call("a=contributor&id=" + rec.contributor)).status === 404, "after leaving, the public record is 404");
const after = (await call("a=stats")).json;
ok(!after.leaderboard.some((r) => r.name === "recorder" || r.name === "departed"), "the leaderboard omits them, under either name");
ok(after.totals.contributors === before.totals.contributors - 1, `totals.contributors decrements (${before.totals.contributors} -> ${after.totals.contributors})`);
ok(after.totals.verified === before.totals.verified, "totals.verified is untouched — verified work stays verified");
ok((await call("a=health")).json.contributors === after.totals.contributors, "health and stats agree on the visible contributor count");
const t2after = (await call("a=team&code=" + team2.code)).json;
ok(!t2after.board.some((r) => r.name === "recorder" || r.name === "departed") && t2after.team.members === 2,
   "the team board and totals omit them");
ok(count(`results WHERE contributor = ${rec.contributor}`) === resultsBefore, "their results rows still exist in the database");
const row = sql(`SELECT name, hidden, team_id FROM contributors WHERE id = ${rec.contributor}`)[0];
ok(row.name === "departed" && Number(row.hidden) === 1 && row.team_id === null, `the row is hidden, nameless and teamless (got ${JSON.stringify(row)})`);
const stillWorks = await call("a=work&token=" + rec.token);
ok(stillWorks.status === 200 && (stillWorks.json.unit || stillWorks.json.idle === true), "their token still draws work — leaving the record is not leaving the swarm");
ok((await call("a=leave", { token: rec.token })).json.ok === true, "leave is idempotent");
ok((await call("a=me&token=" + rec.token)).json.contributor.name === "departed", "?a=me shows them what the public would: departed, no team");
ok((await call("a=team_create", { token: rec.token, name: "Ghost Team" })).json.error === "departed", "a departed contributor cannot found a team");
ok((await call("a=team_join", { token: rec.token, code: team2.code })).status === 403, "or join one");
const loner = (await call("a=join", { name: "loner" })).json;
const lonerTeam = (await call("a=team_create", { token: loner.token, name: "Solo" })).json.team;
await call("a=leave", { token: loner.token });
ok((await call("a=team&code=" + lonerTeam.code)).status === 404, "leaving the record as a team's last member sweeps the team too");
ok((await call("a=leave", { token: "deadbeef" })).status === 401, "leave needs a real token");

/* ————— 12. the byte budget and the server lint ————— */
suite("api 12 — budget and lint");
/* the worst case the shape allows: 20 leaderboard rows and 10 teams, every name at its 24-character cap */
const seeds = [];
for (let i = 0; i < 25; i++) seeds.push(`('seedtoken${i}', '${"W".repeat(24)}', ${1000 + i}, ${10 + i}, 0, 1, 1, NULL, 0)`);
sql("INSERT INTO contributors(token_hash, name, credits, units, flagged, created_at, last_seen, team_id, hidden) VALUES " + seeds.join(","),
    `UPDATE contributors SET name = '${"W".repeat(24)}' WHERE hidden = 0`,
    `UPDATE teams SET name = '${"X".repeat(24)}'`);
const teamSeeds = [];
for (let i = 0; i < 12; i++) teamSeeds.push(`('SEED${"ABCDEFGHJKLM"[i].repeat(4)}', '${"X".repeat(24)}', NULL, 1)`);
sql("INSERT INTO teams(code, name, created_by, created_at) VALUES " + teamSeeds.join(","));
const seededTeams = sql("SELECT id FROM teams WHERE code LIKE 'SEED%' ORDER BY id");
const seededIds = sql("SELECT id FROM contributors WHERE token_hash LIKE 'seedtoken%' ORDER BY id");
sql(...seededTeams.map((t, i) => `UPDATE contributors SET team_id = ${t.id} WHERE id IN (${seededIds[i].id}, ${seededIds[(i + 12) % seededIds.length].id})`));
const fat = await call("a=stats");
ok(fat.status === 200 && fat.json.leaderboard.length === 20, `20 leaderboard rows (got ${fat.json.leaderboard.length})`);
ok(fat.json.leaderboard.every((r) => r.name.length === 24), "every leaderboard name is at the 24-character cap");
ok(Array.isArray(fat.json.teams) && fat.json.teams.length === 10, `stats carries the top 10 teams (got ${fat.json.teams && fat.json.teams.length})`);
ok(fat.json.teams.every((t) => Object.keys(t).sort().join() === "code,credits,members,name,units" && t.name.length === 24 && CODE_RE.test(t.code)),
   "team rows are exactly {code, name, members, units, credits}, alphabet-valid codes, 24-character names");
ok(fat.json.teams.every((t) => t.members > 0), "no empty team is ever listed");
for (let i = 1; i < fat.json.teams.length; i++) {
  ok(fat.json.teams[i - 1].credits >= fat.json.teams[i].credits, `teams are ordered by credits desc (row ${i})`);
}
ok(fat.bytes < 9000, `the fattest stats response stays under the 9,000-byte budget (${fat.bytes} bytes)`);
const fatTeam = await call("a=team&code=" + capTeam.code);
ok(fatTeam.bytes < 9000 && fatTeam.json.board.length === 20, `a full team's page with 24-character names stays under budget (${fatTeam.bytes} bytes)`);
ok((await call("a=contributor&id=" + seededIds[0].id)).bytes < 9000, "a contributor record stays under budget");

/* every new action's error path is JSON with an error code and a 4xx */
for (const [qs, body, label] of [
  ["a=team_create", { name: "No Token" }, "team_create without a token"],
  ["a=team_join", { code: team2.code }, "team_join without a token"],
  ["a=team_leave", { token: "deadbeef" }, "team_leave with an unknown token"],
  ["a=team&code=", undefined, "team with an empty code"],
  ["a=contributor&id=x", undefined, "contributor with a bad id"],
  ["a=me", undefined, "me without a token"],
  ["a=leave", {}, "leave without a token"],
  ["a=team_join", { token: toby.token, code: "ZZZZZZZ3" }, "team_join of a code nobody holds"],
  ["a=team_create", { token: tara.token, name: "Already" }, "team_create while in a team"],
]) {
  const r = await call(qs, body);
  ok(r.status >= 400 && r.status < 500 && r.json && typeof r.json.error === "string",
     `${label}: a 4xx with a JSON error (got ${r.status} ${r.text.slice(0, 60)})`);
  ok(!/Fatal error|Stack trace|\/home\/|PDOException/i.test(r.text), `${label}: nothing leaked`);
}
ok((await call("a=health")).json.ok === true, "the server is healthy after the whole 3.0 pass");

/* the server lint in content.mjs section 10 still holds for the grown server */
const lint = spawnSync(process.execPath, [join(HERE, "content.mjs")], { encoding: "utf8" });
ok(lint.status === 0 && /content 10/.test(lint.stdout), `node content.mjs is still green (exit ${lint.status})`);

/* ————— 13. the reference set changes under a live swarm ————— */
suite("api 13 — a re-pinned reference set retires the old units");
{
  const fresh = [
    { cid: "9000001", smiles: "CCCCCCO", formula: "C6H14O", source: "qa" },
    { cid: "9000002", smiles: "CCCCCCCO", formula: "C7H16O", source: "qa" },
    { cid: "9000003", smiles: "CCCCCCCCO", formula: "C8H18O", source: "qa" }
  ];
  const before = (await call("a=health")).json;
  const r1 = await call("a=ingest", { key: KEY, engine: ENGINE_VERSION, targets_digest: targetsDigest(), molecules: fresh });
  ok(r1.json && r1.json.added === 3, "three fresh molecules ingested under the current reference set");
  const x = (await call("a=join", { name: "repin-x" })).json;
  const w1 = await call("a=work&token=" + x.token);
  ok(w1.json && w1.json.unit && w1.json.unit.targets_digest === targetsDigest(), "a volunteer is issued a unit under the current digest");
  const NEW_DIGEST = "0".repeat(63) + "1";
  const r2 = await call("a=ingest", { key: KEY, engine: ENGINE_VERSION, targets_digest: NEW_DIGEST,
                                      molecules: [{ cid: "9000004", smiles: "CCCCCCCCCO", formula: "C9H20O", source: "qa" }] });
  ok(r2.json && r2.json.added === 1, "the harvester re-pins the server with a corrected reference set");
  const h2 = (await call("a=health")).json;
  ok(h2.targets_digest === NEW_DIGEST, "health now reports the new digest");
  if (w1.json && w1.json.unit) {
    const u = w1.json.unit;
    const res = screenUnit(u, referenceSet());
    const sub = await call("a=submit", { token: x.token, unit_id: u.unit_id, digest: res.digest, results: res.results });
    /* Roughly one issue in twenty is a canary, and a canary looks exactly like
     * ordinary work on the wire — deliberately, so a fabricator cannot tell
     * them apart. The two are retired differently: an ordinary unit is marked
     * stale and keeps its row, a canary is DELETED (its known answer was
     * computed under the old reference set). So the expected refusal depends
     * on which kind was drawn, and the test asks the database rather than
     * assuming. Both are a 4xx with a JSON code the client discards the unit
     * on; a 1-in-20 draw must never decide whether this suite passes. */
    const kind = sql(`SELECT canary_digest FROM units WHERE id = '${u.unit_id.replace(/'/g, "''")}'`);
    const wasCanary = kind.length === 0 || kind[0].canary_digest !== null;
    const expected = wasCanary ? { status: 404, error: "unknown_unit" } : { status: 409, error: "unit_stale" };
    ok(sub.status === expected.status && sub.json && sub.json.error === expected.error,
       `the ${wasCanary ? "canary" : "ordinary unit"} issued under the old digest is refused (${expected.status} ${expected.error}; got ${sub.status} ${sub.json && sub.json.error})`);
    ok(sub.status >= 400 && sub.status < 500 && !/Fatal error|PDOException/i.test(sub.text), "…as a 4xx with nothing leaked, whichever kind it was");
    ok(count(`results WHERE unit_id = '${u.unit_id.replace(/'/g, "''")}'`) === 0, "and the refused work was not recorded");
  }
  const w2 = await call("a=work&token=" + x.token);
  ok(w2.json && w2.json.unit && w2.json.unit.targets_digest === NEW_DIGEST, "the next unit carries the new digest");
  ok(h2.molecules === before.molecules + 4, "no molecule was lost in the change (" + before.molecules + " → " + h2.molecules + ")");
  /* an old-digest unit can never be issued again, however many volunteers ask */
  const y = (await call("a=join", { name: "repin-y" })).json;
  const w3 = await call("a=work&token=" + y.token);
  ok(!w3.json || !w3.json.unit || w3.json.unit.targets_digest === NEW_DIGEST, "a second volunteer only ever sees current-digest units");
  /* restore the real pin so the server state stays honest for anything after */
  await call("a=ingest", { key: KEY, engine: ENGINE_VERSION, targets_digest: targetsDigest(), molecules: [] });
  ok((await call("a=health")).json.targets_digest === targetsDigest(), "pin restored");
}

/* ————— 14. the cache split (4.0): reads revalidate, work is never stored ————— */
suite("api 14 — the cache split: ETag + 304 on reads, no-store on work");
{
  const raw = async (qs, headers, body) => {
    const init = body === undefined
      ? { headers: headers || {} }
      : { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers || {}), body: JSON.stringify(body) };
    const res = await fetch(BASE + "?" + qs, init);
    const text = await res.text();
    return { status: res.status, text, cc: res.headers.get("cache-control") || "", etag: res.headers.get("etag") || "" };
  };
  for (const qs of ["a=stats", "a=hits", "a=health"]) {
    const first = await raw(qs);
    ok(first.status === 200, `${qs} answers 200`);
    ok(/^no-cache$/.test(first.cc.trim()), `${qs} is Cache-Control: no-cache (got '${first.cc}')`);
    ok(/^"[0-9a-f]{40}"$/.test(first.etag), `${qs} carries a strong sha1 ETag (got '${first.etag}')`);
    const { createHash } = await import("node:crypto");
    ok(first.etag === '"' + createHash("sha1").update(first.text).digest("hex") + '"', `${qs}'s ETag is the sha1 of the exact body`);
    /* 4.0: health carries the live bandwidth meter, which every answered
     * request advances — its body legitimately differs on every call, so a
     * 304 can never be expected of it; the cacheable reads are stats and hits */
    if (qs === "a=health") { ok(/bandwidth/.test(first.text), "health carries the bandwidth meter (so it never matches its own ETag)"); continue; }
    const again = await raw(qs, { "if-none-match": first.etag });
    ok(again.status === 304 && again.text === "", `${qs} with a matching If-None-Match answers 304 with no body (got ${again.status}, ${again.text.length} bytes)`);
    const weak = await raw(qs, { "if-none-match": "W/" + first.etag });
    ok(weak.status === 304, `${qs} accepts a weak-prefixed validator too (got ${weak.status})`);
    const miss = await raw(qs, { "if-none-match": '"' + "0".repeat(40) + '"' });
    ok(miss.status === 200 && miss.text.length > 2, `${qs} with a stale validator answers 200 with the body`);
  }
  /* a changed board changes the validator */
  const s1 = await raw("a=stats");
  const who = (await call("a=join", { name: "etag-mover" })).json;
  ok(!!(who && who.token), "a new contributor joins");
  const s2 = await raw("a=stats");
  ok(s1.etag !== s2.etag, "one more contributor ⇒ a different stats ETag");
  ok((await raw("a=stats", { "if-none-match": s1.etag })).status === 200, "the old validator no longer matches");
  /* work endpoints: no-store, no ETag, never 304 */
  const w = await raw("a=work&token=" + who.token);
  ok(/no-store/.test(w.cc) && w.etag === "", `?a=work is no-store with no ETag (got '${w.cc}' / '${w.etag}')`);
  const w2 = await raw("a=work&token=" + who.token, { "if-none-match": "*" });
  ok(w2.status !== 304, "?a=work never answers 304, whatever If-None-Match says");
  const sub = await raw("a=submit", { "if-none-match": "*" }, { token: who.token, unit_id: "nope", digest: "0".repeat(64), results: [] });
  ok(/no-store/.test(sub.cc) && sub.etag === "" && sub.status !== 304, `?a=submit is no-store with no ETag and never 304 (got ${sub.status} '${sub.cc}')`);
  const j = await raw("a=join", { "if-none-match": "*" }, { name: "no-store" });
  ok(/no-store/.test(j.cc) && j.etag === "" && j.status === 200, "?a=join is no-store");
  const me = await raw("a=me&token=" + who.token);
  ok(/no-store/.test(me.cc) && me.etag === "", "?a=me (token-bound) is no-store");
  /* error responses from a read action are never revalidatable */
  const bad = await raw("a=contributor&id=x");
  ok(bad.status === 400 && /no-store/.test(bad.cc) && bad.etag === "", "a read action's 4xx is no-store with no ETag");
  /* a read action's POST is not a cache candidate either */
  const post = await raw("a=stats", {}, {});
  ok(post.status === 200 && /no-store/.test(post.cc), "a POSTed read is answered but not made revalidatable");
  /* the comment the spec asks for is above the header code */
  const php = readFileSync(join(API, "index.php"), "utf8");
  ok(/THE CACHE SPLIT/.test(php) && php.indexOf("THE CACHE SPLIT") < php.indexOf("header('Cache-Control"), "the cache split is explained above the header code");
  ok(/two volunteers the same|two "independent" volunteers/.test(php), "and it says why work units are never stored");
}

/* ————— 15. history (4.0): one row per hour, guarded, pruned, bucketed ————— */
suite("api 15 — history: a row per hour, written once a minute at most, pruned past 720 hours");
{
  const HOUR = 3600;
  const nowS = () => Math.floor(Date.now() / 1000);
  const thisHour = () => nowS() - (nowS() % HOUR);
  const HIST_COLS = ["harvested", "screened", "verified", "contributors", "active", "units_open", "units_confirmed", "conflicts", "results"];
  ok(sql("SELECT name FROM sqlite_master WHERE type='table' AND name='history'").length === 1, "the history table exists");
  ok(sql("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_contrib_seen'").length === 1, "ix_contrib_seen ON contributors(last_seen) exists");
  ok(sql("PRAGMA table_info(history)").map((r) => r.name).join() === ["hour", ...HIST_COLS].join(), "history has exactly the nine columns beside hour, in order");
  ok(count("history") === 1, `after the earlier stats calls there is exactly one history row (${count("history")})`);
  sql(`UPDATE meta SET v = '0' WHERE k = 'history:last'`);   // lift the guard so this call's reading is the row's
  const s0 = await call("a=stats");
  const row0 = sql("SELECT * FROM history")[0];
  ok(Number(row0.hour) === thisHour(), `the row is this hour, as unix seconds at the top of the hour (${row0.hour})`);
  ok(Number(row0.harvested) === s0.json.totals.harvested && Number(row0.screened) === s0.json.totals.screened
     && Number(row0.verified) === s0.json.totals.verified && Number(row0.contributors) === s0.json.totals.contributors,
     "the row carries the same running totals stats just reported");
  ok(Number(row0.units_open) === s0.json.totals.units_open && Number(row0.active) === s0.json.totals.active_1h
     && Number(row0.units_confirmed) === s0.json.units.confirmed && Number(row0.conflicts) === s0.json.units.conflict
     && Number(row0.results) === count("results"), "…and the gauges: units_open, active, units_confirmed, conflicts, results");
  await call("a=stats"); await call("a=stats");
  ok(count("history") === 1, "two more stats calls within the minute write nothing new (the 60-second guard)");
  const last = Number(sql("SELECT v FROM meta WHERE k = 'history:last'")[0].v);
  ok(Math.abs(last - nowS()) < 120, "meta history:last is the time of the last write");
  /* an ancient row, a mid-window row, and a forced re-write */
  const old = thisHour() - 800 * HOUR, mid = thisHour() - 100 * HOUR;
  sql(`INSERT INTO history(hour, harvested, screened, verified, contributors, active, units_open, units_confirmed, conflicts, results) VALUES (${old}, 1, 1, 1, 1, 1, 1, 1, 1, 1), (${mid}, 7, 70, 7, 7, 7, 7, 7, 7, 7)`,
      `UPDATE history SET screened = 0 WHERE hour = ${thisHour()}`,
      `UPDATE meta SET v = '0' WHERE k = 'history:last'`);
  ok(count("history") === 3, "seeded: three rows");
  const s1 = await call("a=stats");
  ok(count(`history WHERE hour = ${old}`) === 0, "a row older than 720 hours is pruned by the next write");
  ok(count(`history WHERE hour = ${mid}`) === 1, "a row inside the window stays");
  ok(Number(sql(`SELECT screened FROM history WHERE hour = ${thisHour()}`)[0].screened) === s1.json.totals.screened,
     "the current hour's row is UPDATED to the latest reading, not duplicated (INSERT OR IGNORE + UPDATE)");
  /* the read endpoint */
  const h48 = await call("a=history&hours=48");
  ok(h48.status === 200 && h48.json.bucket === "hour" && h48.json.hours === 48, `?a=history&hours=48 answers with bucket hour (${h48.status})`);
  ok(Array.isArray(h48.json.hour) && HIST_COLS.every((c) => Array.isArray(h48.json[c]) && h48.json[c].length === h48.json.hour.length),
     "parallel integer arrays keyed by column, all the same length as hour");
  ok(h48.json.hour.includes(thisHour()) && !h48.json.hour.includes(mid), "48 hours holds this hour and not the row 100 hours back");
  ok(HIST_COLS.every((c) => h48.json[c].every(Number.isInteger)) && h48.json.hour.every(Number.isInteger), "every value is an integer");
  const i = h48.json.hour.indexOf(thisHour());
  ok(h48.json.screened[i] === s1.json.totals.screened, "the current hour's screened reading equals stats.totals.screened");
  ok(h48.json.rows === h48.json.hour.length && h48.json.trimmed === false, "rows counts the rows served; nothing was trimmed");
  ok(typeof h48.json.now === "number" && Math.abs(h48.json.now - nowS()) < 60, "the reply carries the server's now");
  ok((await call("a=history&hours=0")).json.hours === 1 && (await call("a=history&hours=-5")).json.hours === 1, "hours below 1 clamp to 1");
  const h720 = await call("a=history&hours=99999");
  ok(h720.json.hours === 720 && h720.json.hour.includes(mid), "hours above 720 clamp to 720, and 720 hours reaches the row 100 hours back");
  ok((await call("a=history&hours=abc")).json.hours === 48, "a non-integer hours falls back to 48");
  ok(h48.bytes < 9000 && h720.bytes < 9000, `history stays under 9,000 bytes (${h48.bytes}, ${h720.bytes})`);
  /* bucket=day: MAX per column inside each UTC day, dense, rows per day */
  const today = nowS() - (nowS() % 86400);
  const d1 = today - 86400, d2 = today - 2 * 86400;
  sql(`DELETE FROM history WHERE hour <> ${thisHour()}`,
      `INSERT INTO history(hour, harvested, screened, verified, contributors, active, units_open, units_confirmed, conflicts, results) VALUES
        (${d1 + 3 * HOUR}, 10, 100, 5, 3, 2, 4, 1, 0, 8), (${d1 + 9 * HOUR}, 12, 130, 9, 3, 6, 2, 3, 1, 9), (${d2 + 20 * HOUR}, 8, 80, 3, 2, 1, 5, 0, 0, 6)`);
  const day = await call("a=history&bucket=day&hours=96");
  ok(day.status === 200 && day.json.bucket === "day" && day.json.days === 4 && day.json.hour.length === 4, `bucket=day&hours=96 gives four dense days (${day.json.days}, ${day.json.hour && day.json.hour.length})`);
  ok(day.json.hour.join() === [today - 3 * 86400, d2, d1, today].join(), "days are the UTC day starts, oldest first, today last");
  ok(Array.isArray(day.json.rows) && day.json.rows.join() === [0, 1, 2, 1].join(), `rows counts the hourly readings in each day (${day.json.rows})`);
  ok(day.json.verified.join() === [0, 3, 9, s1.json.totals.verified].join(), `verified is the MAX reading per day (${day.json.verified})`);
  ok(day.json.screened[2] === 130 && day.json.active[2] === 6 && day.json.units_open[2] === 4 && day.json.harvested[1] === 8,
     "every column aggregates as MAX inside its day (screened 130, active 6, units_open 4; day before 8 harvested)");
  ok(day.json.harvested[0] === 0 && day.json.results[0] === 0, "a day with no reading is 0 with rows 0 — the client carries the previous reading forward");
  const dayDefault = await call("a=history&bucket=day");
  ok(dayDefault.json.days === 30 && dayDefault.json.hour.length === 30 && dayDefault.json.hours === 720, "bucket=day without hours is the full 30 days");
  ok(dayDefault.bytes < 9000, `30 daily rows stay under 9,000 bytes (${dayDefault.bytes})`);
  /* 720 hourly rows must never blow the budget: the oldest are dropped and the reply says so */
  const many = [];
  for (let k = 1; k <= 720; k++) { const age = 721 - k; many.push(`(${thisHour() - k * HOUR}, ${100000 + age}, ${9000000 + age * 977}, ${20000 + age}, ${1000 + age}, ${k % 50}, ${k % 30}, ${5000 + age}, ${k % 7}, ${70000 + age})`); }
  sql(`DELETE FROM history WHERE hour <> ${thisHour()}`, "INSERT INTO history(hour, harvested, screened, verified, contributors, active, units_open, units_confirmed, conflicts, results) VALUES " + many.join(","));
  ok(count("history") === 721, "seeded 720 hours of readings beside the current hour");
  const full = await call("a=history&hours=720");
  ok(full.status === 200 && full.bytes < 9000, `720 hours of history answers under 9,000 bytes (${full.bytes})`);
  ok(full.json.trimmed === true && full.json.rows === full.json.hour.length && full.json.rows < 721 && full.json.rows > 60, `the oldest rows were dropped and the reply says trimmed (${full.json.rows} rows kept)`);
  ok(full.json.hour[full.json.hour.length - 1] === thisHour() && full.json.hour.every((v, j) => j === 0 || v > full.json.hour[j - 1]), "what is kept is the newest, ascending");
  const fullDay = await call("a=history&bucket=day&hours=720&bw=1");
  ok(fullDay.bytes < 9000 && fullDay.json.hour.length === 30 && fullDay.json.rows.slice(1, 29).every((r) => r === 24), `the daily view of 720 rows is 30 days of 24 readings under 9,000 bytes (${fullDay.bytes})`);
  // Days 0..28 hold only seeded readings; today (index 29) also holds the LIVE
  // hour's real row, and in the first hour after UTC midnight it holds nothing
  // else — so today's MAX is the real count, not the seed (caught at 00:25 UTC).
  const seededDays = fullDay.json.screened.slice(0, 29);
  ok(seededDays.every((v, j) => j === 0 || v >= seededDays[j - 1]), "a monotone counter aggregated by MAX stays monotone across the seeded days");
  ok(fullDay.json.rows[29] >= 1 && fullDay.json.screened[29] >= 0, `today carries at least the live hour's own reading (${fullDay.json.rows[29]} rows)`);
  sql(`DELETE FROM history WHERE hour <> ${thisHour()}`);
  ok((await call("a=history&hours=48")).status === 200 && (await call("a=health")).json.ok === true, "the server is healthy after the history pass");
}

/* ————— 16. the instrument fields on ?a=stats ————— */
suite("api 16 — stats: integers only, every one a count the server holds");
{
  const st = (await call("a=stats")).json;
  const isInt = (v) => Number.isInteger(v) && v >= 0;
  for (const k of ["pending", "issued", "conflict", "active_1h"]) ok(isInt(st.totals[k]), `totals.${k} is a non-negative integer (${st.totals[k]})`);
  ok(st.totals.pending === count("molecules WHERE state = 'pending'") && st.totals.issued === count("molecules WHERE state = 'issued'")
     && st.totals.verified === count("molecules WHERE state = 'verified'") && st.totals.conflict === count("molecules WHERE state = 'conflict'"),
     "totals.pending/issued/verified/conflict are the molecule state counts");
  ok(st.totals.active_1h === count(`contributors WHERE hidden = 0 AND last_seen >= ${Math.floor(Date.now() / 1000) - 3600}`), `totals.active_1h counts visible contributors seen in the last hour (${st.totals.active_1h})`);
  ok(Object.keys(st.units).sort().join() === "confirmed,conflict,open,stale" && Object.values(st.units).every(isInt), "units{open,confirmed,conflict,stale}, all integers");
  ok(st.units.open === count("units WHERE canary_digest IS NULL AND status = 'open'") && st.units.confirmed === count("units WHERE canary_digest IS NULL AND status = 'confirmed'")
     && st.units.stale === count("units WHERE canary_digest IS NULL AND status = 'stale'") && st.units.conflict === count("units WHERE canary_digest IS NULL AND status = 'conflict'"),
     "units are counted over real work only — canaries are not units of the pool");
  ok(st.totals.units_open === st.units.open + st.units.conflict, "totals.units_open is still open + conflict");
  ok(Object.keys(st.canary).sort().join() === "bad,ok" && isInt(st.canary.ok) && isInt(st.canary.bad), "canary{ok,bad} integers");
  ok(Array.isArray(st.spectrum) && st.spectrum.length === 10 && st.spectrum.every(isInt), "spectrum is ten integers");
  const hitsN = count("hits");
  ok(st.spectrum.reduce((a, b) => a + b, 0) === hitsN, `spectrum sums to the hits count (${hitsN})`);
  ok(Array.isArray(st.witnesses) && st.witnesses.length === 3 && st.witnesses.reduce((a, b) => a + b, 0) === hitsN, "witnesses[3] sums to the hits count");
  ok(Array.isArray(st.targets) && st.targets.length <= 12 && st.targets.every((t) => typeof t.id === "string" && isInt(t.count)), "targets is at most 12 {id, count} rows");
  const TARGET_IDS = new Set(TARGETS.map((t) => t.id));
  ok(st.targets.every((t) => TARGET_IDS.has(t.id)), `every target id is one targets.js knows (${st.targets.map((t) => t.id).join(",")})`);
  ok(st.targets.reduce((a, t) => a + t.count, 0) === hitsN, "target counts sum to the hits count");
  ok(Object.keys(st.clocks).sort().join() === "harvest,issued,verified" && Object.values(st.clocks).every(isInt), "clocks{harvest,verified,issued} integers");
  ok(st.clocks.harvest === Number(sql("SELECT COALESCE(MAX(added_at), 0) AS v FROM molecules")[0].v) && st.clocks.verified === Number(sql("SELECT COALESCE(MAX(verified_at), 0) AS v FROM hits")[0].v)
     && st.clocks.issued === Number(sql("SELECT COALESCE(MAX(issued_at), 0) AS v FROM issued")[0].v), "each clock is the latest timestamp of its table");
  ok(typeof st.quiet === "boolean", "stats carries quiet as a boolean");
  ok(JSON.stringify(st).split('"').every((chunk, j) => j % 2 === 0 || !/token/i.test(chunk)), "no token-shaped key in the new fields");
  /* exact bucketing against seeded hits */
  const before = { spectrum: st.spectrum.slice(), witnesses: st.witnesses.slice() };
  sql(`INSERT INTO hits(cid, smiles, formula, score, best_target, flags, verified_by, verified_at) VALUES
        ('qa-h0', 'C', '', 0, 'senolytic', '[]', 2, 1), ('qa-h99', 'C', '', 99, 'senolytic', '[]', 3, 1), ('qa-h100', 'C', '', 100, 'senolytic', '[]', 4, 1),
        ('qa-h899', 'C', '', 899, 'nad_salvage', '[]', 7, 1), ('qa-h900', 'C', '', 900, 'nad_salvage', '[]', 2, 1), ('qa-h1000', 'C', '', 1000, 'nad_salvage', '[]', 2, 1)`);
  const st2 = (await call("a=stats")).json;
  const diff = st2.spectrum.map((v, j) => v - before.spectrum[j]);
  ok(diff.join() === [2, 1, 0, 0, 0, 0, 0, 0, 1, 2].join(), `scores 0 and 99 bin 0; 100 bins 1; 899 bins 8; 900 and 1000 bin 9 (${diff})`);
  const wd = st2.witnesses.map((v, j) => v - before.witnesses[j]);
  ok(wd.join() === [3, 1, 2].join(), `verified_by 2 → first bucket, 3 → second, 4 and 7 → third (${wd})`);
  const seno = st2.targets.find((t) => t.id === "senolytic"), nad = st2.targets.find((t) => t.id === "nad_salvage");
  ok(seno && seno.count === 3 && nad && nad.count === 3, "targets GROUP BY best_target counts the seeded rows");
  ok(st2.targets.every((t, j) => j === 0 || st2.targets[j - 1].count >= t.count), "targets are ordered by count desc");
  ok(st2.clocks.verified >= st.clocks.verified, "the verified clock never goes backwards");
  sql("DELETE FROM hits WHERE cid LIKE 'qa-h%'");
  ok((await call("a=stats")).json.spectrum.join() === before.spectrum.join(), "removing the seeded hits restores the spectrum exactly");
  /* clocks are monotone under real activity */
  const t0 = Math.floor(Date.now() / 1000);
  await call("a=ingest", { key: KEY, engine: ENGINE_VERSION, targets_digest: targetsDigest(), molecules: [{ cid: "clock-mol-1", smiles: "CCCCCCCCCCO", formula: "C10H22O", source: "qa" }] });
  const st3 = (await call("a=stats")).json;
  ok(st3.clocks.harvest >= t0 && st3.clocks.harvest >= st.clocks.harvest, `a fresh ingest moves the harvest clock forward (${st.clocks.harvest} → ${st3.clocks.harvest})`);
  const zed = (await call("a=join", { name: "clock-z" })).json;
  const wz = await call("a=work&token=" + zed.token);
  const st4 = (await call("a=stats")).json;
  ok(!wz.json.unit || (st4.clocks.issued >= t0 && st4.clocks.issued >= st3.clocks.issued), `a fresh issue moves the issued clock forward (${st3.clocks.issued} → ${st4.clocks.issued})`);
  ok(st4.totals.active_1h >= 1, "the contributor who just drew work counts as active");
}

/* ————— 17. canary counters ————— */
suite("api 17 — canary counters: ok on a matching digest, bad on a fabricated one");
{
  const c0 = (await call("a=stats")).json.canary;
  ok(c0.bad >= 1, `the fabricated canary answer in suite 6 was counted (bad = ${c0.bad})`);
  /* an honest answer: resolve, screen with the real engine, arm, then answer it */
  const unitId = "canary-ok-" + PORT;
  const CMOLS = [{ cid: "cnr-a", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", formula: "C9H8O4", source: "qa" }, { cid: "cnr-b", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", formula: "C8H10N4O2", source: "qa" }];
  const resolved = await call("a=canary", { key: KEY, engine: ENGINE_VERSION, targets_digest: targetsDigest(), unit_id: unitId, molecules: CMOLS });
  ok(resolved.status === 200 && resolved.json.armed === false && Array.isArray(resolved.json.molecules), "the canary resolves to its served molecules");
  const answer = screenUnit(resolved.json, referenceSet());
  const armed = await call("a=canary", { key: KEY, engine: ENGINE_VERSION, targets_digest: targetsDigest(), unit_id: unitId, digest: answer.digest, molecules: CMOLS });
  ok(armed.status === 200 && armed.json.armed === true, "the canary is armed with the engine's own digest");
  const honest = (await call("a=join", { name: "honest-h" })).json;
  sql(`INSERT OR IGNORE INTO issued(unit_id, contributor, issued_at) VALUES ('${unitId}', ${honest.contributor}, ${Math.floor(Date.now() / 1000)})`);
  const good = await call("a=submit", { token: honest.token, unit_id: unitId, digest: answer.digest, results: answer.results });
  ok(good.status === 200 && good.json.status === "confirmed" && good.json.credited === 10, `an honest canary answer is confirmed and credited (${good.status} ${good.json && good.json.status})`);
  const c1 = (await call("a=stats")).json.canary;
  ok(c1.ok === c0.ok + 1 && c1.bad === c0.bad, `canary.ok rose by one and bad did not (${c0.ok}/${c0.bad} → ${c1.ok}/${c1.bad})`);
  const liar = (await call("a=join", { name: "liar-l" })).json;
  const wrong = await call("a=submit", { token: liar.token, unit_id: unitId, digest: "f".repeat(64), results: answer.results });
  ok(wrong.json && wrong.json.status === "canary_failed", "a fabricated answer to the same canary is caught");
  const c2 = (await call("a=stats")).json.canary;
  ok(c2.bad === c1.bad + 1 && c2.ok === c1.ok, `canary.bad rose by one and ok did not (${c1.ok}/${c1.bad} → ${c2.ok}/${c2.bad})`);
  ok(Number(sql("SELECT v FROM meta WHERE k = 'canary:ok'")[0].v) === c2.ok && Number(sql("SELECT v FROM meta WHERE k = 'canary:bad'")[0].v) === c2.bad, "the counters live in meta as canary:ok / canary:bad");
}

/* ————— 18. the bandwidth meter ————— */
suite("api 18 — the bandwidth meter: every body counted, daily keys, pruned, quiet past the budget");
{
  const today = new Date().toISOString().slice(0, 10);
  const metaInt = (k) => { const r = sql(`SELECT v FROM meta WHERE k = '${k}'`); return r.length ? Number(r[0].v) : 0; };
  const dayBefore = metaInt("bw:day:" + today), actBefore = metaInt("bw:act:" + today + ":stats");
  const r = await call("a=stats");
  ok(metaInt("bw:day:" + today) === dayBefore + r.bytes, `bw:day:<today> grew by exactly the response length (${r.bytes} bytes)`);
  ok(metaInt("bw:act:" + today + ":stats") === actBefore + r.bytes, "bw:act:<today>:stats grew by the same amount");
  const hBefore = metaInt("bw:act:" + today + ":health");
  const hr = await call("a=health");
  const dayAfterHealth = metaInt("bw:day:" + today);
  ok(metaInt("bw:act:" + today + ":health") === hBefore + hr.bytes, "each action has its own daily counter");
  const eBefore = metaInt("bw:act:" + today + ":none");
  const err = await call("a=");
  ok(err.status === 404 && metaInt("bw:act:" + today + ":none") === eBefore + err.bytes, "even an error body is counted, under the action 'none'");
  ok(hr.json.bandwidth && hr.json.bandwidth.today_bytes === dayAfterHealth - hr.bytes && hr.json.bandwidth.budget_bytes === 2147483648 && hr.json.bandwidth.quiet === false,
     `health.bandwidth = {today_bytes (before its own body), budget_bytes 2 GB, quiet false} (${JSON.stringify(hr.json.bandwidth)})`);
  /* the daily series on ?a=history&bw=1 */
  const plain = await call("a=history&hours=24");
  ok(plain.json.bandwidth === undefined, "history without &bw=1 carries no bandwidth block");
  const bwBefore = metaInt("bw:day:" + today);
  const withBw = await call("a=history&hours=24&bw=1");
  const bw = withBw.json.bandwidth;
  ok(bw && Array.isArray(bw.days) && bw.days.length >= 1 && bw.days.length <= 14, `history&bw=1 carries bandwidth.days (${bw && bw.days && bw.days.length})`);
  const todayRow = bw && bw.days.find((d) => d.day === today);
  ok(todayRow && todayRow.bytes === bwBefore, "today's row is the counter as it stood before this response's own body");
  ok(bw.today_bytes === bwBefore && bw.budget_bytes === 2147483648 && bw.quiet === false, "…with today_bytes, budget_bytes and quiet beside it");
  ok(bw.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && Number.isInteger(d.bytes)), "every day row is {day: YYYY-MM-DD, bytes: int}");
  /* pruning: counters older than 14 days go once a day */
  sql("INSERT OR REPLACE INTO meta(k, v) VALUES ('bw:day:2000-01-01', '5'), ('bw:act:2000-01-01:stats', '5'), ('bw:pruned', 'never')");
  await call("a=health");
  ok(metaInt("bw:day:2000-01-01") === 0 && metaInt("bw:act:2000-01-01:stats") === 0, "counters older than 14 days are pruned");
  ok(metaInt("bw:day:" + today) > 0 && sql("SELECT v FROM meta WHERE k = 'bw:pruned'")[0].v === today, "today's counter survives and bw:pruned records the sweep");
  const seen = (await call("a=history&bw=1")).json.bandwidth.days.map((d) => d.day);
  ok(!seen.includes("2000-01-01") && seen[seen.length - 1] === today, "the series no longer lists the pruned day and ends on today");
  /* quiet: the budget is exceeded */
  sql("INSERT OR REPLACE INTO meta(k, v) VALUES ('bw:budget', '1')");
  const q = await call("a=health");
  ok(q.json.bandwidth.quiet === true && q.json.bandwidth.budget_bytes === 1, "over the budget, health says quiet");
  ok((await call("a=stats")).json.quiet === true, "…and stats carries quiet:true so clients slow their polling");
  ok((await call("a=history&bw=1")).json.bandwidth.quiet === true, "…and so does history's bandwidth block");
  sql("DELETE FROM meta WHERE k = 'bw:budget'");
  ok((await call("a=health")).json.bandwidth.quiet === false && (await call("a=stats")).json.quiet === false, "with the override gone, quiet is false again");
  sql("INSERT OR REPLACE INTO meta(k, v) VALUES ('bw:budget', 'not a number')");
  ok((await call("a=health")).json.bandwidth.budget_bytes === 2147483648, "a garbage override is ignored in favour of the default");
  sql("DELETE FROM meta WHERE k = 'bw:budget'");
  ok((await call("a=work&token=" + alice.token)).status !== 500, "the meter never breaks a response");
  /* the counters are incremented ATOMICALLY: los_bw_count() runs outside any transaction, and a
     read-then-write there lost 274 of 800 increments under four concurrent PHP workers (php -S is
     single-threaded, which is why only real parallel processes can see it) */
  sql("DELETE FROM meta WHERE k = 'qa:race'");
  const hammer = `require ${JSON.stringify(join(API, "db.php"))}; $db = los_db(); $db->exec('PRAGMA busy_timeout = 5000'); for ($i = 0; $i < 200; $i++) { los_meta_incr($db, 'qa:race', 1); }`;
  const workers = [1, 2, 3, 4].map(() => new Promise((resolve) => { const w = spawn("php", ["-r", hammer], { stdio: ["ignore", "ignore", "pipe"] }); let err = ""; w.stderr.on("data", (d) => { err += d; }); w.on("close", (code) => resolve({ code, err })); }));
  const done = await Promise.all(workers);
  ok(done.every((w) => w.code === 0), "four concurrent PHP workers each ran 200 increments without error: " + JSON.stringify(done.filter((w) => w.code !== 0).map((w) => w.err.slice(0, 120))));
  ok(metaInt("qa:race") === 800, `los_meta_incr landed every increment under four concurrent writers (${metaInt("qa:race")} of 800)`);
  sql("DELETE FROM meta WHERE k = 'qa:race'");
  const bwSrc = readFileSync(join(API, "index.php"), "utf8");
  const bwFn = bwSrc.slice(bwSrc.indexOf("function los_bw_count"), bwSrc.indexOf("4.0: history"));
  ok(/los_meta_incr\(\$db, 'bw:day:'/.test(bwFn) && /los_meta_incr\(\$db, 'bw:act:'/.test(bwFn) && !/los_meta_add\(/.test(bwFn), "los_bw_count() uses the atomic increment for both keys, never the read-then-write");
  ok(/INSERT INTO meta\(k, v\) VALUES\(\?, \?\)\s*ON CONFLICT\(k\) DO UPDATE SET v = /.test(readFileSync(join(API, "db.php"), "utf8")), "los_meta_incr is one UPSERT statement");
}

/* ————— 18b. flags on the wire: a list, or null — never an empty list standing in for a record that could not be read ————— */
suite("api 18b — hits.flags is the stored list, or null when the stored value is not a list");
{
  sql(`INSERT INTO hits(cid, smiles, formula, score, best_target, flags, verified_by, verified_at) VALUES
        ('qa-fl-none', 'C', '', 998, 'mtor', '[]', 2, 1), ('qa-fl-some', 'C', '', 997, 'mtor', '["nitro_aromatic"]', 2, 1),
        ('qa-fl-corrupt', 'C', '', 996, 'mtor', 'not json', 2, 1), ('qa-fl-object', 'C', '', 995, 'mtor', '{"a":1}', 2, 1), ('qa-fl-null', 'C', '', 994, 'mtor', NULL, 2, 1)`);
  const h = (await call("a=hits&limit=50")).json.hits;
  const by = (cid) => h.find((x) => x.cid === cid);
  ok(by("qa-fl-none") && Array.isArray(by("qa-fl-none").flags) && by("qa-fl-none").flags.length === 0, "a stored [] arrives as [] — the record lists no flag");
  ok(by("qa-fl-some") && by("qa-fl-some").flags.join() === "nitro_aromatic", "a stored list arrives intact");
  ok(by("qa-fl-corrupt") && by("qa-fl-corrupt").flags === null, "a stored value that is not JSON arrives as null — not reported, never 'none'");
  ok(by("qa-fl-object") && by("qa-fl-object").flags === null, "a stored JSON object (not a list) arrives as null");
  ok(by("qa-fl-null") && by("qa-fl-null").flags === null, "a NULL column arrives as null");
  ok(h.filter((x) => /^qa-fl-/.test(x.cid)).every((x) => "flags" in x), "every hit carries the flags key, so null is a value the server sent, not an omission");
  sql("DELETE FROM hits WHERE cid LIKE 'qa-fl-%'");
}

/* ————— 19. the byte budget with everything on ————— */
suite("api 19 — every response under 9,000 bytes with full boards and every 4.0 field");
{
  const fat = await call("a=stats");
  ok(fat.json.leaderboard.length === 20 && fat.json.teams.length === 10, "the boards are still full from suite 12");
  ok(fat.bytes < 9000, `stats with 20 + 10 board rows, spectrum, targets, witnesses, clocks, units, canary and quiet stays under 9,000 bytes (${fat.bytes})`);
  for (const qs of ["a=hits&limit=50", "a=history&hours=48&bw=1", "a=history&hours=720&bw=1", "a=history&bucket=day&bw=1", "a=health", "a=team&code=" + capTeam.code]) {
    const r = await call(qs);
    ok(r.status === 200 && r.bytes < 9000, `${qs}: ${r.status}, ${r.bytes} bytes`);
  }
  ok((await call("a=history")).status === 200, "history uses the read bucket and is not rate-limited by the pass");
  const lint2 = spawnSync(process.execPath, [join(HERE, "content.mjs")], { encoding: "utf8" });
  ok(lint2.status === 0, `node content.mjs is still green after the 4.0 server changes (exit ${lint2.status})`);
}

cleanup();
console.log(failed ? "api: " + failed + " FAILED of " + checks : "api: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
