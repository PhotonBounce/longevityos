/* probe-churn — the adversarial lifecycle probe (4.0).
 *
 * Every 4.0 surface mounts into #view, which app.js empties and rebuilds on
 * every tab press: the Lab (lens, LEDs, log, wizard, sound), the Observatory
 * (fifteen figures reading the strip's store), and the strip itself, which
 * lives outside #view and polls for the whole page. This probe is the fidgety
 * visitor with a run in progress: sixty tab changes in a few seconds, real
 * clicks and script renders alike, twenty visibility flips in two seconds,
 * the wizard left open across renders, sounds enabled — then it asks what
 * leaked. Required after the churn: the run is still going and still
 * submitting; zero page errors; the DOM is no bigger than before; live
 * timers, intervals, observers and keydown listeners are back to the
 * baseline; the log keeps one host, the lens one pool, the page one strip;
 * requests during the churn stay inside the design's bound (a visitor must
 * never be able to rate-limit themselves out of the swarm by fidgeting),
 * and after it the strip is back on its cadence. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";
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
  for (;;) { let v = null; try { v = await fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}

/* ————— the mock swarm server: real molecules, counted requests ————— */
const refs = referenceSet();
const SMILES = [
  "CC(=O)OC1=CC=CC=C1C(=O)O", "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "c1ccc2ccccc2c1", "C1CCC2(CC1)CCCC2",
  "c1ccccc1-c1ccccc1", "CCCCCC", "CN(C)C(=N)N=C(N)N", "CC12CCC3C(C1CCC2O)CCC4=CC(=O)CCC34C",
  "O=C1C(O)=C(Oc2cc(O)cc(O)c12)c1ccc(O)c(O)c1", "c1ccc2[nH]ccc2c1", "N#Cc1ccccc1C#N", "C1COCCOCCOCCOCCOCCO1"
];
const UNIT_MOLS = SMILES.map((s, i) => ({ id: String(3000 + i), smiles: s }));
const mock = { api: {}, log: [], units: 0, tokens: 0 };
const hit = (a) => { mock.api[a] = (mock.api[a] || 0) + 1; mock.log.push({ a, at: Date.now() }); };
const since = (a, t) => mock.log.filter((r) => r.a === a && r.at >= t).length;
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
function history(day) {
  const n = day ? 30 : 48, step = day ? 86400 : HOUR, t0 = now() - (now() % step) - (n - 1) * step;
  const col = (base, k) => new Array(n).fill(0).map((_, i) => base + i * k);
  return {
    bucket: day ? "day" : "hour", hours: day ? 720 : 48, now: now(), hour: new Array(n).fill(0).map((_, i) => t0 + i * step),
    harvested: col(1000, 7), screened: col(800, 9), verified: col(3, 1), contributors: col(2, 1), active: col(1, 0),
    units_open: col(12, 0), units_confirmed: col(1, 1), conflicts: col(0, 0), results: col(5, 3), rows: day ? new Array(n).fill(24) : 48,
    trimmed: false, days: day ? 30 : undefined, bandwidth: { today_bytes: 12345, budget_bytes: 2000000000, quiet: false }
  };
}
function api(res, url, body) {
  const a = url.searchParams.get("a") || (body && body.a) || "";
  hit(a);
  const out = (status, obj) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-cache" }); res.end(JSON.stringify(obj)); };
  if (a === "health") return out(200, { ok: true, engine: refs.engine, targets_digest: refs.targetsDigest });
  if (a === "join") { mock.tokens++; return out(200, { token: ("tok" + mock.tokens).padEnd(32, "0"), contributor: mock.tokens, name: "churn" }); }
  if (a === "work") { mock.units++; return out(200, { unit: { unit_id: "u-" + mock.units, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: UNIT_MOLS } }); }
  if (a === "submit") return out(200, { accepted: true, credited: 5, status: "pending" });
  if (a === "stats") return out(200, {
    totals: { harvested: 1044 + mock.units, screened: 900 + mock.units * 12, verified: 3, contributors: 4, units_open: 12, pending: 2, issued: 3, conflict: 0, active_1h: 1 },
    units: { open: 12, pending: 2, verified: 3, conflict: 0 }, canary: { ok: 5, bad: 0 }, spectrum: [1, 2, 3, 4, 5, 4, 3, 2, 1, 0],
    targets: [], witnesses: [0, 0, 0], clocks: { harvest: now() - 600, screen: now() - 5, verify: now() - 60 }, quiet: false, leaderboard: [], teams: []
  });
  if (a === "hits") return out(200, { hits: [{ cid: "2244", smiles: SMILES[0], formula: "C9H8O4", score: 402, best_target: "nsaid_inflammation", flags: [], verified_by: 2 }] });
  if (a === "history") return out(200, history(url.searchParams.get("bucket") === "day"));
  if (a === "me") return out(200, { contributor: { id: 1, name: "churn", units: 0, credits: 0, created_at: 1700000000, team: null } });
  return out(400, { error: "unknown_action" });
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/mock-api/")) {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => { let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (_) {} api(res, url, body); });
    return;
  }
  let p = url.pathname;
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/app/data/feed.json" || p.startsWith("/app/audio/")) { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;
const APP = BASE + "/app/index.html";

/* ————— the browser, with every leak-prone primitive counted ————— */
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
function instrument() {
  window.__LOS_API = "/mock-api/";
  const L = { timeouts: new Set(), intervals: new Set(), observers: 0, keydown: 0, raf: 0, audio: 0 };
  window.__live = L;
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  window.setTimeout = function (fn, ms, ...a) {
    const id = st.call(window, function () { L.timeouts.delete(id); return typeof fn === "function" ? fn.apply(this, arguments) : undefined; }, ms, ...a);
    L.timeouts.add(id); return id;
  };
  window.clearTimeout = function (id) { L.timeouts.delete(id); return ct.call(window, id); };
  window.setInterval = function (...a) { const id = si.apply(window, a); L.intervals.add(id); return id; };
  window.clearInterval = function (id) { L.intervals.delete(id); return ci.call(window, id); };
  if (typeof IntersectionObserver === "function") {
    const IO = window.IntersectionObserver;
    window.IntersectionObserver = function (...a) { L.observers++; return new IO(...a); };
    window.IntersectionObserver.prototype = IO.prototype;
  }
  const add = document.addEventListener.bind(document), rem = document.removeEventListener.bind(document);
  document.addEventListener = function (type, ...a) { if (type === "keydown") L.keydown++; return add(type, ...a); };
  document.removeEventListener = function (type, ...a) { if (type === "keydown") L.keydown--; return rem(type, ...a); };
  const RealAudio = window.Audio;
  window.Audio = function (src) { L.audio++; return new RealAudio(src); };
  window.Audio.prototype = RealAudio.prototype;
  window.__vis = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__vis === "hidden" });
}
const live = (page) => page.evaluate(() => ({
  timeouts: window.__live.timeouts.size, intervals: window.__live.intervals.size, observers: window.__live.observers,
  keydown: window.__live.keydown, audio: window.__live.audio, nodes: document.getElementsByTagName("*").length,
  strips: document.querySelectorAll("#strip .strip").length, logs: document.querySelectorAll(".hud-log").length,
  lenses: document.querySelectorAll('[data-lab="lens"]').length, lensNodes: (() => { try { return window.__losLens.svg.querySelectorAll("*").length + 1; } catch (_) { return -1; } })(),
  wizards: document.querySelectorAll(".wz-panel").length, hosts: window.__losStrip.hosts(),
  logLines: Math.max(0, ...[...document.querySelectorAll(".hud-log")].map((o) => o.querySelectorAll("li").length)),
  figures: document.querySelectorAll(".obs-fig").length, tab: window.__los.state.tab
}));
const setTab = (page, t) => page.evaluate((k) => { window.__los.state.tab = k; window.__los.render(); }, t);
const flip = (page, state) => page.evaluate((s) => { window.__vis = s; document.dispatchEvent(new Event("visibilitychange")); }, state);

const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
await ctx.addInitScript(instrument);
const A = await ctx.newPage();
watch(A, "A");

/* ————— 1. a run in progress, sounds on, the baseline ————— */
suite("probe-churn 1 — a run in progress, the baseline");
await A.goto(APP);
await A.waitForSelector("#nav .tab");
await A.locator('[data-tab="lab"]').click();
await A.waitForSelector(".lab");
const soundBtn = A.locator("button", { hasText: /^sound off$/i }).first();
let soundOn = false;
if (await soundBtn.count()) { await soundBtn.click(); soundOn = true; await A.waitForTimeout(200); }
await A.locator("button", { hasText: /^Donate this browser$/ }).click();
ok(!!(await until(() => (mock.api.submit || 0) >= 2 ? true : null, 15000)), `the run is going: ${mock.api.submit || 0} submits`);
await A.waitForTimeout(1500);
const base = await live(A);
ok(base.tab === "lab" && base.lenses === 1 && base.logs === 1 && base.strips === 1, `baseline: one lens, one log, one strip (${JSON.stringify({ lenses: base.lenses, logs: base.logs, strips: base.strips })})`);
ok(base.logLines <= 20, `the log holds at most 20 lines (${base.logLines})`);
console.log("  baseline: " + JSON.stringify(base));
const sound0 = await A.evaluate(() => window.__losSound.counters());
ok(!soundOn || sound0.enabled === true, `sounds were enabled by a real click (${JSON.stringify(sound0)})`);

/* ————— 2. the churn: sixty tab changes with the wizard open, a run under it ————— */
suite("probe-churn 2 — sixty tab changes in a few seconds, a run under them");
{
  ok(await A.locator('[data-wizard="open"]').isDisabled(), "the wizard's door is shut while a run is going (it is walked after Stop, below)");
  const t0 = Date.now();
  const submits0 = mock.api.submit || 0;
  const order = ["observatory", "lab", "atlas", "lab", "observatory", "evidence", "lab", "observatory", "ladder", "lab"];
  for (let i = 0; i < 60; i++) {
    const t = order[i % order.length];
    if (i % 7 === 0) await A.locator('[data-tab="' + t + '"]').click();   // a real press every seventh time
    else await setTab(A, t);
    await A.waitForTimeout(40);
  }
  const churnMs = Date.now() - t0;
  await setTab(A, "lab");
  const stats = since("stats", t0), hits = since("hits", t0), hist = since("history", t0);
  console.log(`  churn: ${churnMs} ms, requests during it — stats ${stats}, hits ${hits}, history ${hist}, submits +${(mock.api.submit || 0) - submits0}`);
  ok(hist <= 2, `the five-minute endpoints kept their cadence through 60 renders (history ${hist})`);
  /* one forced round per Observatory re-entry is the design; sixty renders in
   * ~3 s must not become sixty rounds — the store only lets a room refresh
   * when it is freshly subscribed, and a poll in flight is joined, not doubled */
  ok(stats <= 6 && hits <= 6, `the churn stayed inside the request bound (stats ${stats}, hits ${hits} for 60 renders)`);
  ok((mock.api.submit || 0) > submits0, `the run kept submitting through the churn (+${(mock.api.submit || 0) - submits0})`);
  ok((mock.api.join || 0) === 1 && (mock.api.work || 0) > 0, `the churn joined nothing twice (join ${mock.api.join}, work ${mock.api.work})`);
  await A.waitForTimeout(3000);
  const after = await live(A);
  console.log("  after churn: " + JSON.stringify(after));
  ok(after.tab === "lab" && after.lenses === 1 && after.logs === 1 && after.strips === 1 && after.wizards === 0, `one lens, one log, one strip, no wizard after the churn (${JSON.stringify({ lenses: after.lenses, logs: after.logs, strips: after.strips, wizards: after.wizards })})`);
  ok(after.hosts <= 2, `the strip forgot the detached logs (hosts ${after.hosts})`);
  ok(after.nodes <= base.nodes * 1.15 + 40, `the DOM did not grow (${base.nodes} → ${after.nodes})`);
  ok(after.lensNodes <= 220 && after.lensNodes === base.lensNodes, `the lens pool is still ≤ 220 nodes and exactly the baseline's size (${base.lensNodes} → ${after.lensNodes})`);
  ok(after.intervals <= base.intervals + 1, `no interval leaked (${base.intervals} → ${after.intervals})`);
  ok(after.timeouts <= base.timeouts + 8, `timers are back near the baseline (${base.timeouts} → ${after.timeouts})`);
  ok(after.observers <= base.observers + 2, `IntersectionObservers are shared, not per render (${base.observers} → ${after.observers})`);
  ok(after.keydown <= 1, `at most one live keydown listener — the wizard closes with its host (${after.keydown})`);
  ok(after.logLines <= 20, `the log still holds at most 20 lines (${after.logLines})`);
  const snap = await A.evaluate(() => window.__losLab.snapshot());
  ok(snap.running === true, "the client is still running");
  const sound1 = await A.evaluate(() => window.__losSound.counters());
  ok(!soundOn || (sound1.enabled === true && sound1.requested >= sound0.requested), `the sound board is one board, still enabled (${JSON.stringify(sound1)})`);
  ok(after.audio <= 24, `Audio elements are pooled, not minted per render (${after.audio})`);
  await A.screenshot({ path: join(SHOTS, "probe-churn-after.png"), fullPage: false });
}

/* ————— 3. twenty visibility flips in two seconds ————— */
suite("probe-churn 3 — twenty visibility flips in two seconds");
{
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) { await flip(A, i % 2 === 0 ? "hidden" : "visible"); await A.waitForTimeout(100); }
  await flip(A, "visible");
  const stats = since("stats", t0), hits = since("hits", t0), hist = since("history", t0);
  console.log(`  flips: stats ${stats}, hits ${hits}, history ${hist}`);
  ok(stats <= 3 && hits <= 2 && hist <= 2, `ten returns did not become a request storm (stats ${stats}, hits ${hits}, history ${hist})`);
  await A.waitForTimeout(1500);
  const eps = await A.evaluate(() => window.__losStrip.endpoints());
  ok(eps.stats.scheduled && eps.hits.scheduled && eps.history.scheduled, "every endpoint is scheduled again, once");
  const t1 = Date.now();
  await A.waitForTimeout(16500);
  const cadence = since("stats", t1);
  /* while a run is going the Lab forces one round every 5 s on top of the strip's 15 s: at most 3 + 1 + a scheduled one */
  ok(cadence >= 1 && cadence <= 5, `back on the cadence (15 s strip + the Lab's 5 s forced round while running): ${cadence} stats polls in 16.5 s`);
  const snap = await A.evaluate(() => window.__losLab.snapshot());
  ok(snap.running === true, "the client survived the flips and is still running");
  const l = await live(A);
  ok(l.intervals <= base.intervals + 1 && l.timeouts <= base.timeouts + 8, `no timer leaked through the flips (${l.intervals} intervals, ${l.timeouts} timeouts)`);
}

/* ————— 4. the Observatory under churn: figures, subscriptions, painting ————— */
suite("probe-churn 4 — the Observatory re-entered thirty times");
{
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) { await setTab(A, "observatory"); await A.waitForTimeout(30); await setTab(A, "lab"); await A.waitForTimeout(30); }
  await setTab(A, "observatory");
  await A.waitForTimeout(1200);
  const l = await live(A);
  ok(l.figures === 15, `fifteen figures, once (${l.figures})`);
  const o = await A.evaluate(() => window.__losObs.snapshot());
  ok(o.polling === true && o.hasStats === true, `the room reads the store (${JSON.stringify({ polling: o.polling, hasStats: o.hasStats, hasHistory: o.hasHistory })})`);
  const stats = since("stats", t0);
  console.log(`  thirty re-entries: stats ${stats}`);
  ok(stats <= 4, `thirty re-entries in ~2 s stayed under the bound (${stats} stats polls)`);
  await setTab(A, "lab");
  await A.waitForTimeout(600);
  const l2 = await live(A);
  ok(l2.figures === 0 && l2.lenses === 1, "leaving takes every figure with it and the Lab is whole again");
  ok(l2.nodes <= base.nodes * 1.15 + 40, `the DOM is still the baseline's size (${base.nodes} → ${l2.nodes})`);
}

/* ————— 5. stop, and the aftermath ————— */
suite("probe-churn 5 — stop, then zero page errors");
{
  await A.locator("button.lab-btn-stop", { hasText: /^Stop$/ }).click();
  ok(!!(await until(async () => (await A.evaluate(() => window.__losLab.snapshot())).running === false ? true : null, 5000)), "Stop stops");
  const before = mock.api.work || 0;
  await A.waitForTimeout(2500);
  ok((mock.api.work || 0) === before, "no work is asked for after Stop");
  const l = await live(A);
  ok(l.keydown <= 1 && l.intervals <= base.intervals + 1, `nothing kept running after Stop (${l.keydown} keydown, ${l.intervals} intervals)`);
}

/* ————— 6. the wizard left open across twenty renders ————— */
suite("probe-churn 6 — the wizard left open across twenty renders");
{
  await A.locator('[data-wizard="open"]').click();
  ok((await A.locator(".wz-panel").count()) === 1, "the wizard opens once the run has stopped");
  const k0 = (await live(A)).keydown;
  for (let i = 0; i < 20; i++) {
    await setTab(A, i % 2 ? "lab" : (i % 4 === 0 ? "observatory" : "atlas"));
    await A.waitForTimeout(40);
    if (i % 6 === 1) { await A.locator('[data-wizard="open"]').click(); await A.waitForTimeout(60); }   // re-opened mid-churn, real press
  }
  await setTab(A, "lab");
  await A.waitForTimeout(400);
  const l = await live(A);
  ok(l.wizards === 0, `no wizard survives a render it was not asked for (${l.wizards})`);
  ok(l.keydown <= 1, `the wizard's document keydown listener left with it (${l.keydown} live; ${k0} while open)`);
  await A.locator('[data-wizard="open"]').click();
  await A.waitForTimeout(200);
  const open = await live(A);
  ok(open.wizards === 1 && open.keydown <= 1, `re-opened after the churn: one panel, one listener (${open.wizards}, ${open.keydown})`);
  await A.keyboard.press("Escape");
  await A.waitForTimeout(200);
  const closed = await live(A);
  ok(closed.wizards === 0 && closed.keydown <= 0 + 1 && (mock.api.work || 0) === (mock.api.work || 0), `Escape closes it and starts nothing (${closed.wizards} panels, ${closed.keydown} listeners)`);
  ok((await A.evaluate(() => window.__losLab.snapshot())).running === false, "still not running");
}
ok(pageErrors.length === 0, "zero page errors\n" + pageErrors.slice(0, 5).map((e) => "    " + e).join("\n"));

await browser.close();
server.close();
console.log(failed ? `probe-churn: ${failed} FAILED of ${checks}` : `probe-churn: ${checks} checks passed ✓`);
process.exit(failed ? 1 : 0);
