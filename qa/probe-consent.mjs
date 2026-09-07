/* probe-consent — the adversarial consent probe (4.0, spec §10).
 *
 * Everything that could be remembered is remembered ON — instrument sounds,
 * the spoken guide, room tone, keep-awake, only-while-charging, a pace, a
 * wizard name — and the page is loaded and walked across every tab for ten
 * seconds. Required: zero Audio constructions, zero AudioContexts, zero
 * requests under /app/audio/, zero ?a=work / ?a=join, zero wake-lock
 * requests. Then the hostile half: script-dispatched events (untrusted),
 * forged event-shaped objects, a defineProperty'd isTrusted, calling the
 * board's enable() directly from script — none may arm or play. Then
 * hostile manifests (huge, non-object, traversal, absolute URLs, a throwing
 * fetch) after a real gesture — no page error, no request outside
 * /app/audio/. Then the wizard with everything remembered: opening it starts
 * nothing, a remembered wake preference requests no wake lock until a run
 * starts, and Escape at step 8 during a slow join starts nothing. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium, devices } from "playwright";
import { referenceSet } from "../app/js/chem/score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
mkdirSync(join(HERE, "shots"), { recursive: true });
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 50) {
  const end = Date.now() + ms;
  for (;;) { let v = null; try { v = await fn(); } catch (_) { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}

const refs = referenceSet();
const MOLS = [{ id: "1", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" }];
const mock = { audio: [], api: {}, manifestRaw: null, manifestStatus: 200, slowJoinMs: 0, units: 0 };
const reset = () => { mock.audio = []; mock.api = {}; };
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;
  if (p.startsWith("/mock-api/")) {
    let raw = ""; req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const a = url.searchParams.get("a") || "";
      mock.api[a] = (mock.api[a] || 0) + 1;
      const out = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (a === "join") { const answer = () => out({ token: "t".repeat(32), contributor: 1, name: "probe" }); return mock.slowJoinMs ? setTimeout(answer, mock.slowJoinMs) : answer(); }
      if (a === "work") { mock.units++; return out({ unit: { unit_id: "u" + mock.units, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: MOLS } }); }
      if (a === "submit") return out({ accepted: true, credited: 5, status: "pending" });
      if (a === "stats") return out({ totals: { harvested: 10, screened: 5, verified: 1, contributors: 1, units_open: 1 }, leaderboard: [], teams: [] });
      if (a === "hits") return out({ hits: [] });
      if (a === "me") return out({ contributor: { id: 1, name: "probe", units: 0, credits: 0, created_at: 1700000000, team: null } });
      if (a === "health") return out({ ok: true, engine: refs.engine, targets_digest: refs.targetsDigest });
      return out({ error: "unknown_action" }, 400);
    });
    return;
  }
  if (p.startsWith("/app/audio/")) {
    mock.audio.push(p);
    if (p === "/app/audio/manifest.json" && mock.manifestRaw !== null) { res.writeHead(mock.manifestStatus, { "content-type": "application/json" }); res.end(mock.manifestRaw); return; }
    if (/\.mp3$/.test(p) && mock.manifestRaw !== null) { res.writeHead(200, { "content-type": "audio/mpeg" }); res.end(Buffer.alloc(2048)); return; }
    res.writeHead(404); res.end(); return;
  }
  let f = p;
  if (f === "/" || f === "/app/") f = "/app/index.html";
  if (f === "/app/data/feed.json") { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, f);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;
const APP = BASE + "/app/index.html";

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
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
/* everything remembered ON, constructors counted, wake lock stubbed and counted */
function arm() {
  window.__LOS_API = "/mock-api/";
  try {
    localStorage.setItem("los.sound.v1", JSON.stringify({ sfx: true, voice: true, room: true }));
    localStorage.setItem("los.phone.v1", JSON.stringify({ wake: true, charging: false, pace: 1000 }));
    localStorage.setItem("los.wizard.v1", JSON.stringify({ name: "Remembered" }));
  } catch (e) {}
  const c = { audio: 0, ctx: 0, plays: 0, wake: 0 };
  window.__audio = c;
  const RealAudio = window.Audio;
  window.Audio = function (src) { c.audio++; return new RealAudio(src); };
  window.Audio.prototype = RealAudio.prototype;
  for (const k of ["AudioContext", "webkitAudioContext"]) { const Real = window[k]; if (Real) window[k] = function (...a) { c.ctx++; return new Real(...a); }; }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () { c.plays++; const p = play.call(this); return p && p.catch ? p.catch(() => {}) : p; };
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => { c.wake++; return { released: false, release: async () => {}, addEventListener() {} }; } } });
}
async function context(extra) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1180, height: 900 } }, extra || {}));
  await ctx.addInitScript(arm);
  return ctx;
}
const counts = (page) => page.evaluate(() => Object.assign({}, window.__audio));
const board = (page) => page.evaluate(() => window.__losSound.counters());

/* ————— 1. everything remembered ON: ten seconds of silence across every tab ————— */
suite("probe-consent 1 — remembered ON, ten seconds, every tab");
const ctxA = await context();
const A = await ctxA.newPage();
watch(A, "A");
await A.goto(APP);
await A.waitForSelector("#nav .tab");
const tabs = await A.evaluate(() => [...document.querySelectorAll("#nav .tab")].map((t) => t.getAttribute("data-tab")));
/* the walk uses the app's own render(), not clicks: a click IS the visitor's next tap, and the point here is what happens without one */
for (const t of tabs) { await A.evaluate((k) => { window.__los.state.tab = k; window.__los.render(); }, t); await sleep(Math.max(300, Math.floor(9000 / tabs.length))); }
await A.evaluate(() => { window.__los.state.tab = "lab"; window.__los.render(); });
await A.waitForTimeout(1500);
const c1 = await counts(A);
ok(c1.audio === 0 && c1.ctx === 0 && c1.plays === 0, "zero Audio, zero AudioContext, zero plays after ten seconds across " + tabs.length + " tabs (" + JSON.stringify(c1) + ")");
ok(mock.audio.length === 0, "zero requests under /app/audio/");
ok(!mock.api.work && !mock.api.join, "zero ?a=work and ?a=join (" + JSON.stringify(mock.api) + ")");
ok(c1.wake === 0, "a remembered keep-awake requested no wake lock");
ok((await board(A)).armed === true && (await board(A)).enabled === false, "the board is armed and not enabled");
ok((await A.locator('[data-guide="panel"]').isVisible()) && (await A.locator('[data-guide="text"]').textContent()).length > 40, "the guide's transcript is open and printed — text costs nothing");
const g = await A.evaluate(() => window.__losGuide.state());
ok(g.playing === "" && g.played.length === 0, "the guide has played nothing");

/* ————— 2. synthesised events are not gestures ————— */
suite("probe-consent 2 — script-dispatched and forged events arm nothing");
const forged = await A.evaluate(() => {
  const b = window.__losSound;
  const results = {};
  for (const [name, ev] of [
    ["click", new MouseEvent("click", { bubbles: true })],
    ["pointerdown", new PointerEvent("pointerdown", { bubbles: true })],
    ["keydown", new KeyboardEvent("keydown", { key: "Enter", bubbles: true })],
    ["touchend", new Event("touchend", { bubbles: true })]
  ]) {
    document.body.dispatchEvent(ev);
    document.querySelector('[data-guide="speaker"]').dispatchEvent(ev);
    results[name] = b.counters().enabled;
  }
  results.plain = b.enable({ type: "click", isTrusted: true });
  results.null = b.enable(null);
  let defined = "n/a";
  try { const e = new MouseEvent("click"); Object.defineProperty(e, "isTrusted", { value: true }); defined = b.enable(e); } catch (err) { defined = "threw"; }
  results.defined = defined;
  results.enabledAfter = b.counters().enabled;
  try { document.querySelector('[data-guide="speaker"]').click(); } catch (e) {}
  results.afterElementClick = b.counters().enabled;
  try { document.querySelector('[data-guide="play"]').click(); } catch (e) {}
  results.guideState = window.__losGuide.state().playing;
  return results;
});
ok(!forged.click && !forged.pointerdown && !forged.keydown && !forged.touchend, "dispatched click/pointerdown/keydown/touchend do not arm (" + JSON.stringify([forged.click, forged.pointerdown, forged.keydown, forged.touchend]) + ")");
ok(forged.plain === false && forged.null === false, "enable() refuses a forged plain object and null");
ok(forged.defined === false || forged.defined === "threw", "an event with isTrusted forced by defineProperty is refused (" + forged.defined + ")");
ok(forged.afterElementClick === false, "element.click() from script does not spend the arming");
ok(forged.guideState === "", "a scripted press on the guide's Play plays nothing");
await sleep(1500);
const c2 = await counts(A);
ok(c2.audio === 0 && c2.plays === 0 && mock.audio.length === 0, "…and still zero Audio, zero plays, zero audio requests");
/* the speaker's own label was toggled by the scripted element.click() on the
 * preference, but nothing was constructed — set it back for the next probe */
await A.evaluate(() => { window.__losSound.setPref("sfx", true); });

/* ————— 3. a real gesture on a hostile manifest ————— */
suite("probe-consent 3 — hostile manifests after a real gesture");
mock.manifestRaw = "x".repeat(70000);
await A.mouse.click(600, 20);
await sleep(1200);
ok((await board(A)).enabled === true, "a real click spends the arming");
ok((await board(A)).manifest === "missing" && (await counts(A)).audio === 0, "a 70 KB manifest is treated as missing: nothing made");
const B = await ctxA.newPage(); watch(B, "B");
for (const [label, raw] of [
  ["an array", "[1,2,3]"],
  ["a number", "42"],
  ["traversal names", JSON.stringify({ sfx: { "console-wake": { file: "../../../etc/passwd" }, "../../x": { file: "console-wake.mp3" } }, voice: { lab: { file: "/etc/hosts" } } })],
  ["absolute URLs", JSON.stringify({ sfx: { "console-wake": { file: "https://evil.example/a.mp3" } }, voice: { lab: { file: "//evil.example/b.mp3" } } })],
  ["getter bombs", JSON.stringify({ sfx: { "console-wake": { file: { toString: 1 } } }, voice: null })],
  ["a 500", "{\"sfx\":{}}"]
]) {
  reset();
  mock.manifestRaw = raw;
  mock.manifestStatus = label === "a 500" ? 500 : 200;
  await B.goto(APP);
  await B.waitForSelector("#nav .tab");
  await B.mouse.click(600, 20);
  await sleep(900);
  const cB = await counts(B);
  ok(cB.audio === 0 && cB.plays === 0, "manifest = " + label + ": no Audio made, no play");
  ok(mock.audio.every((p) => p === "/app/audio/manifest.json"), "manifest = " + label + ": no file request at all (" + mock.audio.length + " requests)");
}
mock.manifestStatus = 200;
mock.manifestRaw = null;
await B.close();
/* a fetch that throws */
const C = await ctxA.newPage(); watch(C, "C");
await C.addInitScript(() => { window.fetch = () => { throw new TypeError("fetch is poisoned"); }; });
await C.goto(APP);
await C.waitForSelector("#nav .tab");
await C.mouse.click(600, 20);
await sleep(800);
ok((await board(C)).enabled === true && (await board(C)).manifest === "missing" && (await counts(C)).audio === 0, "a throwing fetch ⇒ enabled, manifest missing, silent");
await C.close();
await A.close();

/* ————— 4. the wizard with everything remembered ————— */
suite("probe-consent 4 — the wizard, everything remembered");
reset();
mock.slowJoinMs = 1500;
const ctxD = await context(devices["Pixel 5"]);
const D = await ctxD.newPage();
watch(D, "D");
await D.goto(APP);
await D.waitForSelector("#nav .tab");
await D.locator('[data-tab="lab"]').click();
await D.waitForSelector('[data-wizard="open"]');
await D.locator('[data-wizard="open"]').click();
await D.waitForSelector('[data-wizard="region"]');
await sleep(600);
ok(!mock.api.work && !mock.api.join && (await counts(D)).wake === 0, "opening the wizard starts nothing and requests no wake lock");
const w = await D.evaluate(() => window.__losWizard.choices());
ok(w.name === "Remembered" && w.pace === 1000 && w.wake === true, "remembered choices are read (name, pace, wake)…");
ok(!(await D.evaluate(() => window.__losLab.snapshot().running)), "…and nothing runs because of them");
while ((await D.evaluate(() => Number(document.querySelector('[data-wizard="region"]').getAttribute("data-wizard-step")))) < 8) { await D.locator('[data-wizard="next"]').click(); await sleep(50); }
await sleep(300);
const c4 = await counts(D);
ok(c4.audio === 0 && c4.plays === 0 && !mock.api.work, "walking to step 8 with sound remembered on: still nothing (the detent clicks are refused before a gesture spent the arming — and the wizard's own clicks are gestures, so check the board)");
await D.locator('[data-wizard="start"]').click();
await sleep(200);
ok(mock.api.join === 1, "the start press began a slow join");
ok((await counts(D)).wake === 1, "the wake lock was requested INSIDE the press, before the join");
await D.keyboard.press("Escape");
await sleep(3000);
ok(!mock.api.work, "Escape during the join: the run never started");
const s4 = await D.evaluate(() => window.__losLab.snapshot());
ok(!s4.running && s4.donate.phase !== "joining" && !s4.phone.held, "the console is idle and the wake lock was released");
await D.screenshot({ path: join(HERE, "shots", "probe-consent-wizard.png") });
await D.close();

/* ————— 5. zero page errors ————— */
suite("probe-consent 5 — zero page errors");
ok(pageErrors.length === 0, "zero page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "probe-consent: " + failed + " FAILED of " + checks : "probe-consent: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
