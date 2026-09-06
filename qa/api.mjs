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
const answer = (u, digest) => ({ unit_id: u.unit_id, digest, results: u.molecules.map((m) => ({ id: String(m.id), score: 321, best: "ampk", flags: [] })) });
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

cleanup();
console.log(failed ? "api: " + failed + " FAILED of " + checks : "api: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
