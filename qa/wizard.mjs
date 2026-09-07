/* wizard — the eight-step setup, proven in a real browser (4.0, spec §7).
 *
 * Against a mock swarm that speaks the 3.0 contract: the eight headings in
 * order (verbatim), focus landing on each heading, Escape from every step
 * starting nothing (the mock's ?a=work is never touched), Skip landing on the
 * console, Measure producing a molecules-per-minute figure only on press, the
 * pace / name / team / sound choices reaching the client and the mock, the
 * last step's button being the only path to ?a=work, a keyboard-only
 * completion, Escape during the join starting nothing, the touch default,
 * screenshots to qa/shots/wizard-*.png, and zero page errors. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium, devices } from "playwright";
import { referenceSet } from "../app/js/chem/score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

const HEADINGS = ["What this console does", "What it costs you", "How hard this device works", "Screen and power",
  "Your name on the boards", "A team, if you want one", "Sound and voice", "Consent, and start"];

const refs = referenceSet();
const MOLS = [
  { id: "1", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" },
  { id: "2", smiles: "CN(C)C(=N)NC(=N)N" },
  { id: "3", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C" }
];

/* ————— the mock swarm ————— */

const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const mock = { hits: {}, joins: [], contributors: new Map(), teams: new Map(), nextId: 1, nextTeam: 1, units: 0, slowJoinMs: 0 };
const hit = (a) => { mock.hits[a] = (mock.hits[a] || 0) + 1; };
const reset = () => { mock.hits = {}; mock.joins = []; mock.slowJoinMs = 0; };
const byToken = (t) => [...mock.contributors.values()].find((c) => c.token === t) || null;
function teamView(code) {
  const t = mock.teams.get(code);
  if (!t) return null;
  const m = [...mock.contributors.values()].filter((c) => c.team === code);
  return { code, name: t.name, members: m.length, units: m.reduce((s, c) => s + c.units, 0), credits: m.reduce((s, c) => s + c.credits, 0), created_at: 1700500000 };
}
function api(req, res, url, body) {
  const a = url.searchParams.get("a") || (body && body.a) || "";
  hit(a);
  const out = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const fail = (code, status) => out(status, { error: code });
  const auth = () => { const c = byToken(String((body && body.token) || url.searchParams.get("token") || "")); if (!c) fail("unknown_token", 401); return c; };
  if (a === "join") {
    const id = mock.nextId++;
    const name = String((body && body.name) || "").slice(0, 24) || "anonymous";
    const c = { id, name, token: ("tok" + id).padEnd(32, "0"), units: 0, credits: 0, team: null };
    mock.contributors.set(id, c);
    mock.joins.push(name);
    const answer = () => out(200, { token: c.token, contributor: id, name: c.name });
    if (mock.slowJoinMs) setTimeout(answer, mock.slowJoinMs); else answer();
    return;
  }
  if (a === "work") { const c = auth(); if (!c) return; mock.units++; return out(200, { unit: { unit_id: "u-" + mock.units, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: MOLS } }); }
  if (a === "submit") { const c = auth(); if (!c) return; c.units++; c.credits += 5; return out(200, { accepted: true, credited: 5, status: "pending" }); }
  if (a === "stats") return out(200, { totals: { harvested: 1044, screened: 900, verified: 3, contributors: mock.contributors.size, units_open: 12 }, leaderboard: [], teams: [] });
  if (a === "hits") return out(200, { hits: [{ cid: "2244", smiles: MOLS[0].smiles, score: 412, best_target: "mtor", formula: "C9H8O4", flags: [], verified_by: 2 }] });
  if (a === "health") return out(200, { ok: true, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: 1044, screened: 900, verified: 3, contributors: 1, ingest_armed: true });
  if (a === "me") { const c = auth(); if (!c) return; return out(200, { contributor: { id: c.id, name: c.name, units: c.units, credits: c.credits, created_at: 1700000000, team: c.team ? { code: c.team, name: mock.teams.get(c.team).name } : null } }); }
  if (a === "team_create") {
    const c = auth(); if (!c) return;
    const name = String((body && body.name) || "").trim();
    if (!name || name.length > 24) return fail("bad_name", 400);
    if (c.team) return fail("already_in_team", 409);
    const code = "TEAM" + String(mock.nextTeam++).padStart(4, "2").replace(/0/g, "2").replace(/1/g, "3");
    mock.teams.set(code, { code, name });
    c.team = code;
    return out(200, { team: teamView(code) });
  }
  if (a === "team_join") {
    const c = auth(); if (!c) return;
    const code = String((body && body.code) || "").toUpperCase();
    if (!CODE_RE.test(code)) return fail("bad_code", 400);
    if (!mock.teams.has(code)) return fail("unknown_team", 404);
    if (c.team) return fail("already_in_team", 409);
    c.team = code;
    return out(200, { team: teamView(code) });
  }
  if (a === "team") { const code = String(url.searchParams.get("code") || "").toUpperCase(); const t = teamView(code); return t ? out(200, { team: t, board: [] }) : fail("unknown_team", 404); }
  return fail("unknown_action", 400);
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/mock-api/")) {
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 65536) req.destroy(); });
    req.on("end", () => { let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; } api(req, res, url, body); });
    return;
  }
  let p = url.pathname;
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/data/feed.json" || p === "/app/data/feed.json" || p.startsWith("/app/audio/")) { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;
const APP = BASE + "/app/index.html";

/* ————— the browser ————— */

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const pageErrors = [];
function watch(page, tag) {
  page.on("pageerror", (e) => pageErrors.push(tag + ": " + String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const src = (m.location() && m.location().url) || "";
    if (/\/mock-api\/|\/data\/feed\.json$|\/favicon\.ico$|\/audio\//.test(src)) return;
    if (/Failed to load resource/.test(m.text())) return;
    pageErrors.push(tag + ": " + m.text() + " @ " + src);
  });
}
async function context(extra) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1180, height: 900 } }, extra || {}));
  await ctx.addInitScript(() => { window.__LOS_API = "/mock-api/"; });
  return ctx;
}
async function openLab(ctx, tag) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(APP);
  await page.waitForSelector("#nav .tab");
  await page.locator('[data-tab="lab"]').click();
  await page.waitForSelector('[data-wizard="open"]', { timeout: 15000 });
  return page;
}
const snap = (page) => page.evaluate(() => window.__losLab.snapshot());
const stepOf = (page) => page.evaluate(() => { const r = document.querySelector('[data-wizard="region"]'); return r ? Number(r.getAttribute("data-wizard-step")) : 0; });
const headingOf = (page) => page.evaluate(() => { const h = document.querySelector('[data-wizard="heading"]'); return h ? h.textContent : ""; });
const focusedIsHeading = (page) => page.evaluate(() => document.activeElement && document.activeElement.getAttribute("data-wizard") === "heading");
const regionOpen = (page) => page.evaluate(() => !!document.querySelector('[data-wizard="region"]'));
async function open(page) { await page.locator('[data-wizard="open"]').click(); await page.waitForSelector('[data-wizard="region"]'); }
async function next(page) { await page.locator('[data-wizard="next"]').click(); await sleep(60); }
async function goTo(page, n) { while ((await stepOf(page)) < n) await next(page); }

/* ————— 1. eight steps, in order, verbatim, focus on each heading ————— */
suite("wizard 1 — eight steps in order");
const ctxA = await context();
const A = await openLab(ctxA, "A");
ok(!(await regionOpen(A)), "the Lab opens with the wizard closed — it is a press away, never automatic");
await open(A);
ok(await regionOpen(A), "pressing Set up this browser opens the wizard");
ok(await A.evaluate(() => document.querySelector('[data-wizard="region"]').getAttribute("role") === "region"), "the wizard is a labelled region");
for (let i = 0; i < 8; i++) {
  ok((await stepOf(A)) === i + 1, "step " + (i + 1) + " is numbered " + (i + 1));
  ok((await headingOf(A)) === HEADINGS[i], "step " + (i + 1) + " heading verbatim: " + HEADINGS[i]);
  ok(await focusedIsHeading(A), "focus landed on the step " + (i + 1) + " heading");
  ok(/Step \d of 8/.test(await A.locator('[data-wizard="progress"]').textContent()), "the progress line says Step n of 8");
  const body = await A.locator('[data-wizard="body"]').textContent();
  ok(body.length > 60 && !/\bmin(e|er|ing)\b/i.test(body), "step " + (i + 1) + " body ships and never says mining");
  await A.screenshot({ path: join(SHOTS, "wizard-0" + (i + 1) + ".png"), fullPage: false });
  if (i < 7) await next(A);
}
ok((await A.locator('[data-wizard="next"]').count()) === 0 && (await A.locator('[data-wizard="start"]').count()) === 1, "the last step has no Next — one button, named");
ok((await A.locator('[data-wizard="start"]').textContent()) === "Join the swarm and start screening", "the button is 'Join the swarm and start screening'");
ok(!mock.hits.work && !mock.hits.join, "walking all eight steps touched neither ?a=work nor ?a=join (" + JSON.stringify(mock.hits) + ")");
ok(!(await snap(A)).running, "and nothing is running");
await A.locator('[data-wizard="back"]').click();
ok((await stepOf(A)) === 7 && await focusedIsHeading(A), "Back goes to the previous step and focuses its heading");
await A.keyboard.press("Escape");
ok(!(await regionOpen(A)), "Escape closes the wizard");
await A.close();

/* ————— 2. Escape from every step starts nothing ————— */
suite("wizard 2 — Escape from every step starts nothing");
reset();
const B = await openLab(ctxA, "B");
for (let n = 1; n <= 8; n++) {
  await open(B);
  await goTo(B, n);
  ok((await stepOf(B)) === n, "reached step " + n);
  await B.keyboard.press("Escape");
  ok(!(await regionOpen(B)), "Escape from step " + n + " leaves");
  const s = await snap(B);
  ok(!s.running && s.donate.phase !== "joining", "step " + n + ": nothing is running after Escape (phase " + s.donate.phase + ")");
}
await sleep(500);
ok(!mock.hits.work && !mock.hits.join && !mock.hits.submit, "eight Escapes: the mock never saw ?a=work, ?a=join or ?a=submit (" + JSON.stringify(mock.hits) + ")");
ok(await B.evaluate(() => document.activeElement && document.activeElement.textContent === "Donate this browser"), "after Escape, focus returns to the console's Donate button");
await B.close();

/* ————— 3. Skip lands on the console ————— */
suite("wizard 3 — Skip");
const C = await openLab(ctxA, "C");
await open(C);
ok((await C.locator('[data-wizard="skip"]').textContent()) === "Skip setup — take me to the console", "step 1 offers Skip, verbatim");
await C.locator('[data-wizard="skip"]').click();
ok(!(await regionOpen(C)), "Skip closes the wizard");
ok(await C.evaluate(() => document.activeElement && document.activeElement.textContent === "Donate this browser"), "Skip lands on the console: the Donate button has focus");
ok(await C.locator('[data-lab="contribute"]').isVisible(), "the contribute panel is on screen");
ok(!mock.hits.work && !mock.hits.join, "Skip started nothing");
await C.close();

/* ————— 4. Measure this device ————— */
suite("wizard 4 — Measure this device");
const D = await openLab(ctxA, "D");
await open(D);
await goTo(D, 3);
const before = await D.locator('[data-wizard="measure-out"]').textContent();
ok(/Not measured yet/.test(before), "before the press: 'Not measured yet' and no figure");
ok((await D.locator("[data-per-minute]").count()) === 0, "no molecules-per-minute figure exists before the press");
await sleep(1500);
ok((await D.locator("[data-per-minute]").count()) === 0, "…and none appears on its own");
await D.locator('[data-wizard="measure"]').click();
const measured = await until(async () => (await D.locator("[data-per-minute]").count()) === 3, 20000);
ok(!!measured, "pressing Measure prints three rates within 20 s");
const rates = await D.evaluate(() => [...document.querySelectorAll("[data-per-minute]")].map((e) => Number(e.getAttribute("data-per-minute"))));
ok(rates.length === 3 && rates.every((r) => r > 0), "every pace has a real molecules-per-minute figure > 0 (" + rates.join(" / ") + ")");
ok(rates[0] >= rates[1] && rates[1] >= rates[2], "Full ≥ Gentle ≥ Trickle");
ok(rates[2] < 40 * 15 + 1, "Trickle cannot exceed one forty-molecule unit per four seconds (" + rates[2] + " ≤ 600)");
const after = await D.locator('[data-wizard="measure-out"]').textContent();
ok(/Measured on this device just now: 200 molecules/.test(after), "the readout says it measured 200 molecules on this device just now");
ok(/Other devices will differ/.test(after), "and that other devices will differ");
await D.screenshot({ path: join(SHOTS, "wizard-03-measured.png") });
await D.close();

/* ————— 5. the choices reach the client and the mock; start is the only door ————— */
suite("wizard 5 — choices reach the client; the last step is the only door");
reset();
const ctxE = await context();
const E = await openLab(ctxE, "E");
await open(E);
await goTo(E, 3);
await E.locator('[data-wizard="pace-trickle"]').check();
ok(await E.evaluate(() => JSON.parse(localStorage.getItem("los.phone.v1")).pace === 4000), "the pace choice is remembered in los.phone.v1");
ok((await snap(E)).running === false, "choosing a pace starts nothing");
await next(E);
ok((await stepOf(E)) === 4, "step 4");
const wakeNote = await E.evaluate(() => document.querySelector('[data-wizard="wake"]').closest("label").textContent);
const chargeNote = await E.evaluate(() => document.querySelector('[data-wizard="charging"]').closest("label").textContent);
const hasBattery = await E.evaluate(() => typeof navigator.getBattery === "function");
const chargeDisabled = await E.evaluate(() => document.querySelector('[data-wizard="charging"]').disabled);
ok(hasBattery ? (!chargeDisabled && /screening continues on battery/.test(chargeNote)) : (chargeDisabled && /does not report charging state/.test(chargeNote)),
  (hasBattery ? "a Battery API ⇒ the charging toggle is live and explains itself" : "no Battery API ⇒ 'Only while charging' is disabled and says why") + " (" + chargeNote.trim().slice(0, 70) + ")");
ok(/cannot keep the screen awake|requested when the run starts|screen sleeps/.test(wakeNote), "the wake toggle explains its state (" + wakeNote.trim().slice(0, 60) + ")");
await next(E);
await E.locator('[data-wizard="name"]').fill("Wren Q");
ok(/Wren Q/.test(await E.locator('[data-wizard="name-preview"]').textContent()), "the name previews live as a board row");
ok(/0 units/.test(await E.locator('[data-wizard="name-preview"]').textContent()), "…with zero units, honestly");
await next(E);
await E.locator('[data-wizard="team-create"]').count();
await E.locator('[data-wizard="team-create"]').click();   // the segment button
await E.locator('[data-wizard="team-name"]').fill("Night shift");
ok(/registers a token; uses no CPU/.test(await E.locator('[data-wizard="panel"]').textContent()), "the team form is labelled 'registers a token; uses no CPU'");
await E.locator('[data-wizard="team-create"]').last().click();
const teamMsg = await until(async () => { const t = await E.locator('[data-wizard="team-msg"]').textContent(); return /Team created/.test(t) ? t : null; }, 8000);
ok(!!teamMsg && /Night shift/.test(teamMsg) && /registers a token; uses no CPU/.test(teamMsg), "Create the team registers a token and says so (" + (teamMsg || "").slice(0, 80) + ")");
ok(mock.hits.join === 1 && mock.joins[0] === "Wren Q", "the join carried the chosen name (" + JSON.stringify(mock.joins) + ")");
ok(mock.hits.team_create === 1 && mock.teams.size === 1, "the mock created exactly one team");
ok(!mock.hits.work, "a team is bookkeeping: still no ?a=work");
await next(E);
ok((await stepOf(E)) === 7, "step 7");
await E.locator('[data-wizard="sfx"]').check();
ok(await E.evaluate(() => JSON.parse(localStorage.getItem("los.sound.v1")).sfx === true), "the sound choice is remembered in los.sound.v1");
ok(await E.evaluate(() => window.__losSound.counters().enabled === false), "checking the box arms; it does not enable — nothing plays until a tap");
await E.locator('[data-wizard="sample"]').click();
ok(await E.evaluate(() => window.__losSound.counters().enabled === true), "Play a sample is the arming gesture: the board is enabled");
ok(/Speaker: sound on/.test(await E.locator('[data-wizard="sound-state"]').textContent()), "the step prints the speaker's state as text");
await next(E);
ok((await stepOf(E)) === 8, "step 8");
const summary = await E.locator('[data-wizard="panel"]').textContent();
ok(/Trickle/.test(summary) && /Wren Q/.test(summary) && /Night shift/.test(summary) && /instrument sounds on/.test(summary), "the summary names the pace, the name, the team and the sound choice");
ok((await E.locator('[data-wizard^="change-"]').count()) === 5, "five Change links");
await E.locator('[data-wizard="change-name"]').click();
ok((await stepOf(E)) === 5, "Change: name goes back to step 5");
await goTo(E, 8);
await sleep(800);
ok(!mock.hits.work, "at the last step, before the press: still no ?a=work");
ok(!(await snap(E)).running, "and the client is not running");
await E.screenshot({ path: join(SHOTS, "wizard-08-consent.png") });
await E.locator('[data-wizard="start"]').click();
const worked = await until(async () => mock.hits.work >= 1, 15000);
ok(!!worked, "pressing the last step's button is what makes the first ?a=work happen");
ok(!(await regionOpen(E)), "the wizard closes once the run starts");
const s5 = await snap(E);
ok(s5.running === true, "the client is running");
ok(s5.pace === 4000, "the client's pace is the chosen Trickle (" + s5.pace + ")");
ok(s5.donate.name === "Wren Q", "the console carries the chosen name");
ok(mock.hits.join === 1, "a token already registered at step 6 is reused — no second contributor is minted");
const status = await E.locator(".lab-status").first().textContent();
ok(/Screening/.test(status), "the console's status line reads Screening");
await E.locator(".lab-btn-stop").first().click();
await sleep(300);
ok(!(await snap(E)).running, "Stop stops");
await E.screenshot({ path: join(SHOTS, "wizard-09-running.png") });
await E.close();

/* ————— 6. keyboard only ————— */
suite("wizard 6 — keyboard-only completion");
reset();
const ctxF = await context();
const F = await openLab(ctxF, "F");
await F.locator('[data-wizard="open"]').focus();
await F.keyboard.press("Enter");
await F.waitForSelector('[data-wizard="region"]');
ok(await focusedIsHeading(F), "Enter on the setup button opens the wizard with the heading focused");
async function tabTo(page, attr, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await page.evaluate((a) => document.activeElement && document.activeElement.getAttribute("data-wizard") === a, attr)) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}
for (let n = 1; n < 8; n++) {
  ok(await tabTo(F, "next"), "step " + n + ": Tab reaches Next");
  await F.keyboard.press("Enter");
  await sleep(60);
  ok((await stepOf(F)) === n + 1 && await focusedIsHeading(F), "Enter advances to step " + (n + 1) + " and focuses its heading");
}
ok(!mock.hits.work, "keyboard walk: no ?a=work yet");
ok(await tabTo(F, "start"), "step 8: Tab reaches the start button");
await F.keyboard.press("Enter");
ok(!!(await until(async () => mock.hits.work >= 1, 15000)), "Enter on the start button starts the run");
ok((await snap(F)).running, "…and the client is running");
await F.keyboard.press("Tab");
await F.close();

/* ————— 7. Escape during the join starts nothing ————— */
suite("wizard 7 — Escape mid-join starts nothing");
reset();
mock.slowJoinMs = 1500;
const ctxG = await context();
const G = await openLab(ctxG, "G");
await open(G);
await goTo(G, 8);
await G.locator('[data-wizard="start"]').click();
await sleep(200);
ok(mock.hits.join === 1, "the press began a (slow) join");
await G.keyboard.press("Escape");
ok(!(await regionOpen(G)), "Escape during the join closes the wizard");
await sleep(3000);
ok(!mock.hits.work, "the join landed, but the run never started: no ?a=work");
const s7 = await snap(G);
ok(!s7.running && s7.donate.phase !== "joining", "the console is idle, not stuck in 'joining' (phase " + s7.donate.phase + ")");
ok(/Nothing is using your CPU/.test(await G.locator(".lab-status").first().textContent()), "the status line says nothing is using the CPU");
await G.close();

/* ————— 8. the touch default ————— */
suite("wizard 8 — pace default");
const ctxH = await browser.newContext(devices["Pixel 5"]);
await ctxH.addInitScript(() => { window.__LOS_API = "/mock-api/"; });
const H = await openLab(ctxH, "H");
await open(H);
await goTo(H, 3);
ok(await H.evaluate(() => document.querySelector('[data-wizard="pace-gentle"]').checked), "on a touch device the default pace is Gentle");
await H.screenshot({ path: join(SHOTS, "wizard-phone-03.png") });
await H.close();
const I = await openLab(await context(), "I");
await open(I);
await goTo(I, 3);
ok(await I.evaluate(() => document.querySelector('[data-wizard="pace-full"]').checked), "on a desktop the default pace is Full");
await I.close();

/* ————— 9. a wizard never outlives its tab, nor its successor ————— */
suite("wizard 9 — a wizard never outlives its tab, nor its successor");
reset();
const J = await openLab(await context(), "J");
await open(J);
await goTo(J, 3);
await J.locator('[data-wizard="pace-trickle"]').click();
const phonePrefs = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("los.phone.v1") || "{}"));
ok((await phonePrefs(J)).pace === 4000, "Trickle is persisted the moment it is chosen");
/* (a) the visitor changes tab with the wizard open: an Escape on that other
 * page must neither persist the orphan's stale choices nor relabel the guide */
await J.locator('[data-tab="atlas"]').click();
await until(async () => !(await regionOpen(J)), 5000);
ok(!(await regionOpen(J)), "on Atlas the wizard's region is off the page");
const guideBefore = await J.locator('[data-guide="text"]').textContent();
await J.evaluate(() => localStorage.setItem("los.phone.v1", JSON.stringify({ wake: false, charging: false, pace: 0 })));
await J.keyboard.press("Escape");
await sleep(80);
ok(await J.evaluate(() => window.__losWizard.isClosed()), "Escape on another tab closes the orphaned wizard quietly");
ok((await phonePrefs(J)).pace === 0, "…without writing its stale choices over the visitor's current ones (pace stays 0)");
ok((await J.locator('[data-guide="text"]').textContent()) === guideBefore, "…and without relabelling the guide's transcript for a page the visitor is not on");
/* (b) a tab round-trip rebuilds the Lab: the previous render's wizard is closed, not orphaned */
await J.locator('[data-tab="lab"]').click();
await J.waitForSelector('[data-wizard="open"]');
await open(J);
await J.locator('[data-tab="atlas"]').click();
await J.locator('[data-tab="lab"]').click();
await J.waitForSelector('[data-wizard="open"]');
ok(await J.evaluate(() => window.__losWizard.isClosed()), "rebuilding the Lab closes the wizard of the previous render");
ok(!(await regionOpen(J)), "…and the fresh host is empty");
await J.evaluate(() => localStorage.setItem("los.phone.v1", JSON.stringify({ wake: false, charging: false, pace: 1000 })));
await J.keyboard.press("Escape");
await sleep(80);
ok((await phonePrefs(J)).pace === 1000, "an Escape after the round-trip writes nothing: no listener survived (pace stays 1000)");
/* (c) pressing Set up twice: the first wizard is closed before the second opens */
await open(J);
await J.evaluate(() => { window.__wzFirst = window.__losWizard; });
await J.locator('[data-wizard="open"]').click();
await sleep(80);
ok(await J.evaluate(() => window.__wzFirst.isClosed() && window.__losWizard !== window.__wzFirst && !window.__losWizard.isClosed()), "pressing Set up again closes the first wizard before opening the second");
ok((await J.locator('[data-wizard="region"]').count()) === 1, "exactly one wizard region is on the page");
await J.keyboard.press("Escape");
ok(!(await regionOpen(J)) && await J.evaluate(() => window.__losWizard.isClosed()), "Escape closes the live wizard");
ok(!(await snap(J)).running && !mock.hits.work && !mock.hits.join, "none of it started anything (" + JSON.stringify(mock.hits) + ")");
/* (d) a disabled toggle's note is body text and keeps full-strength --dim: no opacity on the row */
const wizardCss = readFileSync(join(ROOT, "app", "css", "wizard.css"), "utf8");
const offRule = (wizardCss.match(/\.wz-opt-off\s*{[^}]*}/) || [""])[0];
ok(offRule && !/opacity/.test(offRule), "the .wz-opt-off rule carries no opacity — the disabled note stays at 7:1 (" + offRule.replace(/\s+/g, " ") + ")");
await J.close();

/* ————— 10. zero page errors ————— */
suite("wizard 10 — zero page errors");
ok(pageErrors.length === 0, "zero page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "wizard: " + failed + " FAILED of " + checks : "wizard: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
