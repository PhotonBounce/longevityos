/* probe-teams — the 3.0 team server under adversarial load.
 *
 * api.mjs proves the contract one call at a time. This probe asks the other
 * questions: what happens when twenty contributors create, switch and leave at
 * the same moment against eight PHP workers (no "database is locked", no
 * duplicate memberships, aggregates that equal the sum of the rows, and no
 * empty team left standing); whether a name typed by an attacker can reach
 * the table or the wire un-cleaned; whether a contributor who left can still
 * be found anywhere; and whether a code-guessing storm meets a 429 rather than
 * a 500.
 *
 * Same harness as api.mjs — a real `php -S`, a throwaway database, a
 * throwaway key dir — on its own port and with PHP_CLI_SERVER_WORKERS=8 so
 * the storm genuinely overlaps. Offline, cleans up after itself.
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
const sandbox = mkdtempSync(join(tmpdir(), "los-probe-teams-"));
const dataDir = join(API, "data");
const keyDir = join(API, "..", "..", "los-private");
const hadData = existsSync(dataDir);
const hadKey = existsSync(keyDir);
if (hadData) { console.error("refusing to run: saas/api/data already exists (that would be a live database)"); process.exit(1); }

const PORT = 8700 + (process.pid % 300);
const php = spawn("php", ["-S", "127.0.0.1:" + PORT, "-t", API], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PHP_CLI_SERVER_WORKERS: "8" },
});
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
const seen = [];                              // every response, for the leak and 500 scans
const call = async (qs, body) => {
  const url = BASE + "?" + qs;
  const res = body === undefined
    ? await fetch(url)
    : await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  const out = { status: res.status, json, text, bytes: text.length, qs };
  seen.push(out);
  return out;
};

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try { const r = await call("a=health"); up = r.status === 200; } catch (_) { await new Promise((r) => setTimeout(r, 150)); }
}
if (!up) { console.error("php -S never came up:\n" + phpErr); cleanup(); process.exit(1); }

/* the throwaway database, read through PHP's own PDO driver (no sqlite3 CLI needed) */
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

/* the structural invariants every phase of the storm must leave true */
const invariants = async (label) => {
  ok(count("teams t WHERE NOT EXISTS (SELECT 1 FROM contributors c WHERE c.team_id = t.id AND c.hidden = 0)") === 0,
     `${label}: no zero-member team is left standing`);
  ok(count("contributors WHERE team_id IS NOT NULL AND team_id NOT IN (SELECT id FROM teams)") === 0,
     `${label}: no membership points at a team that does not exist`);
  ok(count("contributors WHERE hidden = 1 AND team_id IS NOT NULL") === 0,
     `${label}: no hidden contributor stands in a team`);
  const teams = sql("SELECT t.code AS code, COUNT(c.id) AS members, COALESCE(SUM(c.units),0) AS units, COALESCE(SUM(c.credits),0) AS credits FROM teams t LEFT JOIN contributors c ON c.team_id = t.id AND c.hidden = 0 GROUP BY t.id");
  for (const t of teams) {
    const w = await call("a=team&code=" + t.code);
    ok(w.status === 200 && w.json.team.members === Number(t.members) && w.json.team.units === Number(t.units) && w.json.team.credits === Number(t.credits),
       `${label}: ${t.code} wire aggregates equal the sum of its member rows (${JSON.stringify(w.json && w.json.team)} vs ${JSON.stringify(t)})`);
  }
  return teams;
};
const noServerErrors = (rs, label) => {
  ok(rs.every((r) => r.status !== 500), `${label}: no 500 (${rs.filter((r) => r.status === 500).length} of ${rs.length})`);
  ok(rs.every((r) => r.json && (r.status === 200 || typeof r.json.error === "string")), `${label}: every answer is JSON, every failure carries an error code`);
  ok(!rs.some((r) => /locked|PDOException|Fatal|Stack trace/i.test(r.text)), `${label}: no lock error or stack trace on the wire`);
};

/* ————— 1. the storm: 20 contributors, 8 workers, everything at once ————— */
suite("probe-teams 1 — the create/join/leave storm");
const crew = [];
for (let i = 0; i < 20; i++) crew.push((await call("a=join", { name: "crew" + i })).json);
ok(crew.every((c) => /^[0-9a-f]{32}$/.test(c.token)), "twenty contributors joined");

/* A: everybody founds a team at the same moment */
const creates = await Promise.all(crew.map((c, i) => call("a=team_create", { token: c.token, name: "Squad " + i })));
noServerErrors(creates, "20 parallel creates");
ok(creates.every((r) => r.status === 200), `all twenty creates succeed (${creates.filter((r) => r.status === 200).length}/20)`);
const codes = creates.map((r) => r.json.team && r.json.team.code);
ok(new Set(codes).size === 20 && codes.every((c) => /^[A-HJ-NP-Z2-9]{8}$/.test(c || "")), "twenty distinct, alphabet-valid codes");
ok(count("teams") === 20, "twenty team rows");
await invariants("after creates");

/* B: everybody piles into one of four hub teams at once. The hub founders
   join their own team (idempotent) and never leave, so the sixteen other
   teams empty out and must be swept, race or no race. */
const hubs = codes.slice(0, 4);
const joins = await Promise.all(crew.map((c, i) => call("a=team_join", { token: c.token, code: hubs[i % 4] })));
noServerErrors(joins, "20 parallel joins/switches");
ok(joins.every((r) => r.status === 200), `all twenty joins succeed (${joins.filter((r) => r.status === 200).length}/20)`);
ok(count("teams") === 4, `sixteen emptied teams were swept, four hubs remain (${count("teams")} rows)`);
const perTeam = sql("SELECT team_id, COUNT(*) AS n FROM contributors WHERE name LIKE 'crew%' GROUP BY team_id");
ok(perTeam.length === 4 && perTeam.every((r) => Number(r.n) === 5), `each hub has exactly 5 members, nobody is in two places (${JSON.stringify(perTeam)})`);
await invariants("after the pile-in");

/* C: sixteen leave at once; the founders stay */
const leaves = await Promise.all(crew.slice(4).map((c) => call("a=team_leave", { token: c.token })));
noServerErrors(leaves, "16 parallel leaves");
ok(leaves.every((r) => r.status === 200 && r.json.ok === true), "every leave answers ok");
ok(count("teams") === 4 && count("contributors WHERE team_id IS NOT NULL") === 4, "the four founders are the only members left");
await invariants("after the walk-out");

/* D: give everybody credit, then everybody joins hub 0 at once; hubs 1-3 empty and go */
sql("UPDATE contributors SET credits = id * 3, units = id WHERE name LIKE 'crew%'");
const pileIn = await Promise.all(crew.map((c) => call("a=team_join", { token: c.token, code: hubs[0] })));
noServerErrors(pileIn, "20 parallel joins into one team");
ok(pileIn.every((r) => r.status === 200), "everyone lands in hub 0");
ok(count("teams") === 1, `hubs 1-3 were swept as their founders switched (${count("teams")} team left)`);
const hub0 = await invariants("after the merge");
ok(hub0.length === 1 && Number(hub0[0].members) === 20, "hub 0 holds all twenty");
ok((await call("a=team&code=" + hubs[0])).json.board.length === 20, "its board shows twenty rows");

/* E: a mixed storm — leave-and-found, idempotent re-join, plain leave — all at once */
const mixed = await Promise.all(crew.map((c, i) => {
  if (i % 3 === 0) return call("a=team_leave", { token: c.token }).then(() => call("a=team_create", { token: c.token, name: "Splinter " + i }));
  if (i % 3 === 1) return call("a=team_join", { token: c.token, code: hubs[0] });
  return call("a=team_leave", { token: c.token });
}));
noServerErrors(mixed, "20 parallel mixed operations");
ok(mixed.every((r) => r.status === 200), `every mixed operation succeeds (${mixed.filter((r) => r.status === 200).length}/20)`);
ok(count("teams") === 1 + 7, `hub 0 survives (its i%3==1 members never left) and seven splinters exist (${count("teams")} teams)`);
await invariants("after the mixed storm");
ok(!/database is locked|PDOException|Fatal error/i.test(phpErr), "the server log shows no lock error or exception across the whole storm");

/* ————— 2. the name injection corpus ————— */
suite("probe-teams 2 — names typed by an attacker");
const contributorsBefore = count("contributors");
const teamsBefore = count("teams");
const namers = [];
for (let i = 0; i < 4; i++) namers.push((await call("a=join", { name: "namer" + i })).json);
const corpus = [
  ["'; DROP TABLE teams;--", "SQL: drop"],
  ["\" OR 1=1 --", "SQL: tautology"],
  ["Robert'); DELETE FROM contributors;--", "SQL: delete"],
  ["{\"name\":\"x\",\"code\":\"AAAA\"}", "JSON in a string"],
  ["\u202Eevil\u202C name", "bidi override"],
  ["\u200B\u200B\u200Bab", "zero-width prefix"],
  ["a\u0000b\u0007c\u001bd", "control bytes"],
  ["<img src=x onerror=alert(1)>", "HTML"],
  ["A".repeat(10240), "10 KB name"],
  ["  \t\n  ", "whitespace only"],
  ["x", "one character"],
  ["\u00e9\u00e9\u00e9", "non-ASCII only"],
  [12345, "a number"],
  [null, "null"],
  [["a", "b"], "an array"],
  [{ a: 1 }, "an object"],
  ["${7*7} `id` $(whoami)", "template and shell shapes"],
];
let k = 0;
for (const [name, label] of corpus) {
  const who = namers[k++ % namers.length];
  const r = await call("a=team_create", { token: who.token, name });
  ok(r.status === 200 || r.status === 400, `${label}: 200 (cleaned) or 400 (refused), never anything else (got ${r.status})`);
  ok(r.json && (r.status === 200 ? typeof r.json.team === "object" : typeof r.json.error === "string"), `${label}: JSON either way`);
  if (r.status === 200) {
    const n = r.json.team.name;
    ok(/^[ -~]{2,24}$/.test(n) && !/[<>&"'\\`]/.test(n), `${label}: the stored name is printable ASCII, 2-24 chars, no markup or quotes (got ${JSON.stringify(n)})`);
    const w = await call("a=team&code=" + r.json.team.code);
    ok(w.json.team.name === n, `${label}: the public page shows the same cleaned name`);
    await call("a=team_leave", { token: who.token });
  }
}
ok(count("contributors") === contributorsBefore + 4, "the contributors table was not touched by a SQL-shaped name");
ok(count("teams") === teamsBefore, "every corpus team was swept; the teams table still exists and is unchanged");
ok((await call("a=health")).json.ok === true, "the server is healthy after the corpus");

/* ————— 3. a contributor who left cannot be found — and their work still counts ————— */
suite("probe-teams 3 — the departed");
mkdirSync(keyDir, { recursive: true });
const KEY = "probe-teams-key-" + PORT;
writeFileSync(join(keyDir, "ingest-key.txt"), KEY + "\n");
const MOLS = [
  { cid: "2244", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", formula: "C9H8O4", source: "qa" },
  { cid: "2519", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", formula: "C8H10N4O2", source: "qa" },
  { cid: "1983", smiles: "CC(=O)NC1=CC=C(O)C=C1", formula: "C8H9NO2", source: "qa" },
  { cid: "750",  smiles: "NCC(=O)O", formula: "C2H5NO2", source: "qa" },
];
ok((await call("a=ingest", { key: KEY, targets_digest: targetsDigest(), molecules: MOLS })).json.added === 4, "four molecules to screen");
const gone = (await call("a=join", { name: "gone" })).json;
const helper = (await call("a=join", { name: "helper" })).json;
const wu = (await call("a=work&token=" + gone.token)).json.unit;
const wu2 = (await call("a=work&token=" + helper.token)).json.unit;
ok(wu && wu2 && wu.unit_id === wu2.unit_id, "both draw the same unit");
const answer = (u) => ({ unit_id: u.unit_id, digest: "f".repeat(64), results: u.molecules.map((m) => ({ id: String(m.id), score: 400, best: "mtor", flags: [] })) });
await call("a=submit", { token: gone.token, ...answer(wu) });
const conf = await call("a=submit", { token: helper.token, ...answer(wu2) });
ok(conf.json.status === "confirmed", `the unit is confirmed by two strangers (got ${conf.json.status})`);
ok((await call("a=team_join", { token: gone.token, code: hubs[0] })).status === 200, "the departing contributor is on a team first");
const statsBefore = (await call("a=stats")).json;
ok(statsBefore.leaderboard.some((r) => r.name === "gone"), "before leaving they are on the leaderboard");
ok(statsBefore.totals.verified >= 4, `the verified total counts their unit (${statsBefore.totals.verified})`);

ok((await call("a=leave", { token: gone.token })).json.ok === true, "they leave the public record");
ok((await call("a=contributor&id=" + gone.contributor)).status === 404, "their id is unknown to the public record");
const statsAfter = (await call("a=stats")).json;
ok(!statsAfter.leaderboard.some((r) => r.name === "gone" || r.name === "departed"), "the leaderboard has no trace of them");
ok(statsAfter.totals.contributors === statsBefore.totals.contributors - 1, "totals.contributors dropped by one");
ok(statsAfter.totals.verified === statsBefore.totals.verified, "totals.verified did NOT drop — their confirmed unit still counts");
ok((await call("a=health")).json.verified === statsAfter.totals.verified, "health agrees");
const everyTeam = sql("SELECT code FROM teams");
let onABoard = false;
for (const t of everyTeam) {
  const w = await call("a=team&code=" + t.code);
  if (w.json.board.some((r) => r.name === "gone" || r.name === "departed")) onABoard = true;
}
ok(!onABoard, `they are on none of the ${everyTeam.length} team boards`);
ok(count(`results WHERE contributor = ${gone.contributor}`) === 1, "their results row is still in the database");
ok(count(`issued WHERE contributor = ${gone.contributor}`) === 1, "and their issued row");
ok((await call("a=work&token=" + gone.token)).status === 200, "their token still draws work (anonymously)");
await invariants("after a departure");

/* ————— 4. the code-guessing storm ————— */
suite("probe-teams 4 — guessing codes");
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const guess = () => Array.from({ length: 8 }, () => ALPHA[Math.floor(Math.random() * 32)]).join("");
const guesser = (await call("a=join", { name: "guesser" })).json;
const storm = await Promise.all(Array.from({ length: 200 }, () => call("a=team_join", { token: guesser.token, code: guess() })));
noServerErrors(storm, "200 parallel guesses");
const statuses = storm.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
ok(storm.every((r) => r.status === 404 || r.status === 429), `every guess is 404 or 429 — never a hit, never a 500 (${JSON.stringify(statuses)})`);
ok((statuses[429] || 0) >= 80, `the limiter kicked in (${statuses[429] || 0} of 200 were 429)`);
ok((statuses[404] || 0) >= 1, "and the first guesses were honest 404s");
const blind = await Promise.all(Array.from({ length: 50 }, () => call("a=team_join", { code: guess() })));
noServerErrors(blind, "50 unauthenticated guesses");
ok(blind.every((r) => r.status === 401 || r.status === 429), "an unauthenticated guess is 401 or 429 — the per-address limit is spent before any token is looked up");
ok(!/database is locked|PDOException|Fatal error/i.test(phpErr), "the server log is still clean");
ok((await call("a=health")).json.ok === true, "the server is healthy after the storm");
ok((await call("a=me&token=" + crew[1].token)).json.contributor.team.code === hubs[0], "a legitimate member's own record is still served");

/* ————— 5. nothing on the wire ever carried a token ————— */
suite("probe-teams 5 — no token ever echoed");
const tokens = [...crew, ...namers, gone, helper, guesser].map((c) => c.token);
const leaked = seen.filter((r) => !/^a=join/.test(r.qs) && tokens.some((t) => r.text.includes(t)));
ok(leaked.length === 0, `no response other than the join itself ever carries a token (${leaked.length} of ${seen.length} did)`);
ok(seen.every((r) => r.bytes < 9000), `every one of ${seen.length} responses is under the 9,000-byte budget`);

cleanup();
console.log(failed ? "probe-teams: " + failed + " FAILED of " + checks : "probe-teams: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
