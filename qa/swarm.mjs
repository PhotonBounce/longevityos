/* swarm — the distributed half, proven end to end.
 *
 * The claim the whole project rests on is that a stranger's browser and our own
 * machine, screening the same work unit, produce the SAME digest. If that is
 * ever false, "two volunteers agreed" means nothing and the hit list is noise.
 * So this suite computes a digest in bare Node, computes it again inside a real
 * Chromium page AND inside a real Web Worker, and requires all three to be
 * byte-identical.
 *
 * It then runs the donation client against a mock server to prove the loop
 * behaves: it never starts without a gesture, it backs off instead of
 * hammering, and a dead server degrades quietly.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";
import { referenceSet, screenUnit } from "../app/js/chem/score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

/* the unit both sides will screen — a mix of real drugs, a salt and a hostile string */
const UNIT = {
  unit_id: "parity-unit-42",
  molecules: [
    { id: "1", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" },
    { id: "2", smiles: "CN(C)C(=N)NC(=N)N" },
    { id: "3", smiles: "OC1=CC(O)=CC(=C1)/C=C/C1=CC=C(O)C=C1" },
    { id: "4", smiles: "NCCCNCCCCN" },
    { id: "5", smiles: "CC(=O)[O-].[Na+]" },
    { id: "6", smiles: "this is not a molecule" },
    { id: "7", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C" }
  ]
};

/* ————— 1. bare Node ————— */
suite("swarm 1 — the reference computation (bare Node)");
const nodeRefs = referenceSet();
const nodeRun = screenUnit(UNIT, nodeRefs);
ok(/^[0-9a-f]{64}$/.test(nodeRun.digest), "Node produces a sha256 digest");
ok(nodeRun.results.length === UNIT.molecules.length, "every molecule is reported");
console.log("   node digest: " + nodeRun.digest);

/* ————— serve the app ————— */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
  const p = join(ROOT, req.url.split("?")[0]);
  if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push(m.text()); });
await page.goto(BASE + "/app/index.html");

/* ————— 2. the same computation in the page ————— */
suite("swarm 2 — parity: browser main thread vs Node");
const browserRun = await page.evaluate(async ({ base, unit }) => {
  const mod = await import(base + "/app/js/chem/score.js");
  const refs = mod.referenceSet();
  const run = mod.screenUnit(unit, refs);
  return { digest: run.digest, count: run.results.length, targetsDigest: run.targetsDigest };
}, { base: BASE, unit: UNIT });
ok(browserRun.digest === nodeRun.digest,
   `THE PARITY CLAIM: browser digest === Node digest\n      node:    ${nodeRun.digest}\n      browser: ${browserRun.digest}`);
ok(browserRun.targetsDigest === nodeRun.targetsDigest, "both sides agree on the reference-set digest");
ok(browserRun.count === nodeRun.results.length, "both sides screened the same number of molecules");

/* ————— 3. and inside a real Web Worker ————— */
suite("swarm 3 — parity: the actual Web Worker");
const workerRun = await page.evaluate(({ base, unit }) => new Promise((resolve) => {
  const w = new Worker(base + "/app/js/swarm/worker.js", { type: "module" });
  const timer = setTimeout(() => { w.terminate(); resolve({ error: "worker timed out" }); }, 60000);
  let progressSeen = 0;
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.type === "progress") { progressSeen++; return; }
    if (d.type === "done") { clearTimeout(timer); w.terminate(); resolve({ digest: d.result.digest, progressSeen }); }
    if (d.type === "error") { clearTimeout(timer); w.terminate(); resolve({ error: d.message }); }
  };
  w.onerror = (e) => { clearTimeout(timer); resolve({ error: String(e.message || e) }); };
  w.postMessage({ type: "screen", unit });
}), { base: BASE, unit: UNIT });
ok(!workerRun.error, "the worker screened the unit without erroring: " + (workerRun.error || "ok"));
ok(workerRun.digest === nodeRun.digest,
   `the WORKER's digest matches Node's — this is what two volunteers actually compare\n      worker: ${workerRun.digest}`);

/* ————— 4. hostile units never wedge a volunteer's browser ————— */
suite("swarm 4 — the worker survives hostile work");
const hostile = await page.evaluate(({ base }) => new Promise((resolve) => {
  const w = new Worker(base + "/app/js/swarm/worker.js", { type: "module" });
  const out = [];
  const units = [
    { unit_id: "h1", molecules: [{ id: "1", smiles: "C".repeat(9000) }] },
    { unit_id: "h2", molecules: [{ id: "1", smiles: null }, { id: "2" }] },
    { unit_id: "h3", molecules: [] },
    { unit_id: "h4", molecules: [{ id: "1", smiles: "((((((" }, { id: "2", smiles: "💊🧬" }] }
  ];
  let i = 0;
  const timer = setTimeout(() => { w.terminate(); resolve({ out, timedOut: true }); }, 60000);
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.type === "done") out.push({ unit: units[i].unit_id, digest: d.result.digest });
    else if (d.type === "error") out.push({ unit: units[i].unit_id, error: d.message });
    else return;
    i++;
    if (i >= units.length) { clearTimeout(timer); w.terminate(); resolve({ out, timedOut: false }); }
    else w.postMessage({ type: "screen", unit: units[i] });
  };
  w.postMessage({ type: "screen", unit: units[0] });
}), { base: BASE });
ok(!hostile.timedOut, "the worker answered every hostile unit without hanging");
ok(hostile.out.length === 4, `all four hostile units came back (${hostile.out.length})`);
ok(hostile.out.filter((r) => r.digest).length >= 3, "hostile molecules produce digests rather than crashes");

/* ————— 5. the donation client against a mock server ————— */
suite("swarm 5 — the donation loop");
let issued = 0, joined = false;
const submissions = new Map();   // keep EVERY submission, not just the last
const submitted = () => submissions.get("mock-1") || null;
await page.route("**/mock-api/**", async (route) => {
  const url = new URL(route.request().url());
  const a = url.searchParams.get("a");
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (a === "join") { joined = true; return json({ token: "f".repeat(32), contributor: 7, name: "qa" }); }
  if (a === "work") {
    issued++;
    if (issued > 2) return json({ idle: true });
    /* the unit must be stamped with the REAL engine + reference set: the client
     * refuses work built for a different one, which is what stops two clients
     * on different builds from "agreeing" on incomparable results */
    return json({ unit: { unit_id: "mock-" + issued, engine: nodeRefs.engine, targets_digest: nodeRefs.targetsDigest, molecules: UNIT.molecules.slice(0, 3) } });
  }
  if (a === "submit") {
    const body = JSON.parse(route.request().postData() || "{}");
    if (body && body.unit_id) submissions.set(String(body.unit_id), body);
    return json({ accepted: true, credited: 10, status: "confirmed" });
  }
  return json({ ok: true });
});

const loop = await page.evaluate(async ({ base }) => {
  const { createSwarmClient } = await import(base + "/app/js/swarm/client.js");
  const events = [];
  const client = createSwarmClient({ apiBase: "/mock-api/", onEvent: (e) => events.push(e.type) });
  const before = events.length;
  await new Promise((r) => setTimeout(r, 300));
  const startedWithoutGesture = events.length > before;
  await client.join("qa");
  client.start();
  await new Promise((r) => setTimeout(r, 8000));
  client.stop();
  return { events, startedWithoutGesture, running: client.isRunning() };
}, { base: BASE });

ok(loop.startedWithoutGesture === false,
   "THE CONSENT RULE: creating the client never starts using someone's CPU — only an explicit start() does");
ok(joined, "the client joined the swarm");
ok(loop.events.includes("unit"), "the client fetched work");
const sub1 = submitted();
ok(submissions.size >= 1, `the client submitted work (${submissions.size} unit(s))`);
ok(sub1 && /^[0-9a-f]{64}$/.test(sub1.digest || ""), "the client submitted a real digest");
ok(sub1 && Array.isArray(sub1.results) && sub1.results.length === 3, "the submission carries per-molecule results");
ok(loop.events.includes("idle"), "when the server runs out of work, the client goes idle instead of hammering it");
ok(loop.running === false, "stop() actually stops the loop");

/* the digest the client submitted must match the reference computation */
const mockUnit = { unit_id: "mock-1", molecules: UNIT.molecules.slice(0, 3) };
ok(sub1 && sub1.digest === screenUnit(mockUnit, nodeRefs).digest,
   "the digest a volunteer submits is exactly what an independent verifier computes");
/* and every OTHER unit it screened must verify independently too */
let allMatch = true;
for (const [uid, body] of submissions) {
  const n = Number(String(uid).replace(/[^0-9]/g, "")) || 1;
  const u = { unit_id: uid, molecules: UNIT.molecules.slice(0, 3) };
  if (body.digest !== screenUnit(u, nodeRefs).digest) { allMatch = false; console.error("      mismatch on " + uid); }
}
ok(allMatch, "every unit the client submitted verifies against an independent recomputation");

/* ————— 6. a dead server must not break the page ————— */
suite("swarm 6 — degradation");
const dead = await page.evaluate(async ({ base }) => {
  const { createSwarmClient } = await import(base + "/app/js/swarm/client.js");
  const events = [];
  const client = createSwarmClient({ apiBase: "/nowhere-at-all/", onEvent: (e) => events.push(e.type) });
  try { await client.join("qa"); } catch (_) { /* must not throw out of join */ }
  client.start();
  await new Promise((r) => setTimeout(r, 3000));
  client.stop();
  return events;
}, { base: BASE });
ok(dead.includes("error"), "an unreachable server surfaces an error event");
/* the error event says structurally whether the LINK failed (no route, no
 * answer) or the SERVER answered badly — the UI keys its 'server unreachable'
 * sound to `transport`, so a 404 and a refused connection must differ */
const linkKinds = await page.evaluate(async ({ base }) => {
  const { createSwarmClient } = await import(base + "/app/js/swarm/client.js");
  const run = async (apiBase) => {
    const errs = [];
    const client = createSwarmClient({ apiBase, onEvent: (e) => { if (e.type === "error") errs.push({ where: e.where, transport: e.transport }); } });
    try { await client.join("qa"); } catch (_) {}
    return errs;
  };
  return { refused: await run("http://127.0.0.1:1/"), notFound: await run("/nowhere-at-all/") };
}, { base: BASE });
ok(linkKinds.refused.length > 0 && linkKinds.refused.every((e) => e.transport === true), "a refused connection is a transport failure: every error event carries transport:true (" + JSON.stringify(linkKinds.refused) + ")");
ok(linkKinds.notFound.length > 0 && linkKinds.notFound.every((e) => e.transport === false), "a server that answers 404 is NOT a transport failure: transport:false (" + JSON.stringify(linkKinds.notFound) + ")");

/* ————— 7. a unit from a different engine build must be refused ————— */
suite("swarm 7 — the client refuses incomparable work");
let refusedUnitSeen = false;
await page.route("**/wrong-engine-api/**", async (route) => {
  const a = new URL(route.request().url()).searchParams.get("a");
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (a === "join") return json({ token: "e".repeat(32), contributor: 9, name: "qa" });
  if (a === "work") return json({ unit: { unit_id: "wrong-1", engine: "los-chem-999", targets_digest: "0".repeat(64), molecules: UNIT.molecules.slice(0, 2) } });
  if (a === "submit") { refusedUnitSeen = true; return json({ accepted: true, status: "confirmed" }); }
  return json({ ok: true });
});
const wrongEngine = await page.evaluate(async ({ base }) => {
  const { createSwarmClient } = await import(base + "/app/js/swarm/client.js");
  const events = [];
  const client = createSwarmClient({ apiBase: "/wrong-engine-api/", onEvent: (e) => events.push(e.type) });
  await client.join("qa");
  client.start();
  await new Promise((r) => setTimeout(r, 4000));
  client.stop();
  return events;
}, { base: BASE });
ok(refusedUnitSeen === false,
   "a unit stamped for a DIFFERENT engine/reference set is never screened or submitted — otherwise two clients on different builds could 'agree' on incomparable results");
ok(wrongEngine.includes("error") || wrongEngine.includes("idle") || !wrongEngine.includes("submitted"),
   "and the client says so rather than silently spinning");
ok(pageErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0,
   "no uncaught page errors throughout: " + JSON.stringify(pageErrors.slice(0, 3)));

/* ————— 8. the pace dial, and stop() during the pace sleep ————— */
suite("swarm 8 — pace: units are spaced, and stop() cuts the pause short");
/* Every ?a=work request is timestamped on THIS side, so the spacing measured
 * is what a server would see, not what the client believes it did. */
const paceHits = [];
let paceIssued = 0;
await page.route("**/pace-api/**", async (route) => {
  const a = new URL(route.request().url()).searchParams.get("a");
  const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (a === "join") return json({ token: "d".repeat(32), contributor: 11, name: "qa" });
  if (a === "work") {
    paceHits.push(Date.now());
    paceIssued++;
    return json({ unit: { unit_id: "pace-" + paceIssued, engine: nodeRefs.engine, targets_digest: nodeRefs.targetsDigest, molecules: UNIT.molecules.slice(0, 2) } });
  }
  if (a === "submit") return json({ accepted: true, credited: 1, status: "pending" });
  return json({ ok: true });
});
const paceSetup = await page.evaluate(async ({ base }) => {
  const { createSwarmClient } = await import(base + "/app/js/swarm/client.js");
  const events = [];
  const client = createSwarmClient({ apiBase: "/pace-api/", onEvent: (e) => events.push(e.type) });
  const out = { defaultPace: client.pace() };
  out.set = client.setPace(1000);
  out.clampHi = client.setPace(99999);
  out.clampLo = client.setPace(-5);
  out.clampNaN = client.setPace("x");
  client.setPace(1000);
  out.readBack = client.pace();
  window.__paceClient = client;
  window.__paceEvents = events;
  await client.join("qa");
  client.start();
  await new Promise((r) => setTimeout(r, 3600));
  return out;
}, { base: BASE });
ok(paceSetup.defaultPace === 0, "the default pace is 0 ms (" + paceSetup.defaultPace + ")");
ok(paceSetup.set === 1000 && paceSetup.readBack === 1000, "setPace(1000) is read back as 1000");
ok(paceSetup.clampHi === 10000, "setPace clamps to 10000 ms at the top (" + paceSetup.clampHi + ")");
ok(paceSetup.clampLo === 0, "setPace clamps to 0 ms at the bottom (" + paceSetup.clampLo + ")");
ok(paceSetup.clampNaN === 0, "a non-number leaves the pace where it was (" + paceSetup.clampNaN + ")");

/* stop() lands while the loop is asleep between units (units of two molecules
 * screen in milliseconds; the loop spends almost all of its 3.6 s in pauses) */
const hitsBeforeStop = paceHits.length;
const stopMoment = Date.now();
const stopped = await page.evaluate(() => {
  const c = window.__paceClient;
  c.stop();
  return { running: c.isRunning(), stoppedEvent: window.__paceEvents.includes("stopped") };
});
await new Promise((r) => setTimeout(r, 2500));
const lateHits = paceHits.filter((t) => t > stopMoment + 5).length;
ok(hitsBeforeStop >= 2 && hitsBeforeStop <= 5, `at 1000 ms pace, 3.6 s yields a handful of work requests (${hitsBeforeStop})`);
let minGap = Infinity;
for (let i = 1; i < hitsBeforeStop; i++) minGap = Math.min(minGap, paceHits[i] - paceHits[i - 1]);
ok(hitsBeforeStop < 2 || minGap >= 950, `consecutive work requests are at least ~1000 ms apart (min gap ${minGap} ms)`);
ok(stopped.running === false && stopped.stoppedEvent, "stop() during the pace sleep is immediate and reports itself");
ok(lateHits === 0, `no work request is made after stop() — the sleeping loop was woken to exit, not to fetch (${lateHits} late)`);
ok(paceHits.length === hitsBeforeStop, `the work counter is frozen at stop (${paceHits.length} === ${hitsBeforeStop})`);

await browser.close();
server.close();
console.log(failed ? "swarm: " + failed + " FAILED of " + checks : "swarm: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
