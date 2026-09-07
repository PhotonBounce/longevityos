/* sound — the instrument sounds and the spoken guide, proven in a real
 * browser (4.0, spec §8 + §9 + §10).
 *
 * The Audio constructor, AudioContext and HTMLMediaElement.play/pause are
 * wrapped at context level so the suite can COUNT constructions and plays;
 * the mock server counts every request under /app/audio/. What is proven:
 * with the sound preference remembered ON, ten seconds after load there are
 * zero Audio constructions, zero AudioContexts and zero audio requests; a
 * synthesised (trusted) gesture arms and spends — the manifest is fetched,
 * the console-wake file is loaded and played; a missing manifest means
 * silence with the captions still rendered; the rate limits hold; room tone
 * loops and stops on a hidden tab; the Lab's client events reach the board;
 * the header speaker toggles; a hostile manifest is ignored; the spoken guide
 * plays only on a press from a file the manifest lists; zero page errors. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";
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

/* a tiny MPEG-1 Layer III frame (silence) repeated — enough bytes to be a
 * file the browser will try; whether it decodes is not what is measured */
const FRAME = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]);
const MP3 = Buffer.concat(Array.from({ length: 8 }, () => FRAME));

const refs = referenceSet();
const MOLS = [{ id: "1", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" }, { id: "2", smiles: "CN(C)C(=N)NC(=N)N" }];

const SFX_NAMES = ["console-wake", "unit-issued", "molecule-lock", "unit-submitted", "confirmed", "conflict", "idle", "link-lost", "wizard-step", "stopped", "room-tone"];
function fullManifest() {
  const sfx = {}; for (const n of SFX_NAMES) sfx[n] = { file: n + ".mp3", sha256: "x", bytes: MP3.length, hash: "h" };
  const voice = {}; for (const n of ["intro", "lab", "atlas"]) voice[n] = { file: n + ".mp3", sha256: "x", bytes: MP3.length, hash: "h" };
  return { generated_at: "2026-09-06T00:00:00Z", voice_id: "test", sfx, voice };
}

/* ————— the mock: app + swarm + audio ————— */

const mock = { audio: [], api: {}, manifest: fullManifest(), manifestRaw: null, units: 0, submitStatus: "pending" };
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
      if (a === "join") return out({ token: "t".repeat(32), contributor: 1, name: "sound" });
      if (a === "work") { mock.units++; return out({ unit: { unit_id: "u" + mock.units, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: MOLS } }); }
      if (a === "submit") return out({ accepted: true, credited: 5, status: mock.submitStatus });
      if (a === "stats") return out({ totals: { harvested: 10, screened: 5, verified: 1, contributors: 1, units_open: 1 }, leaderboard: [], teams: [] });
      if (a === "hits") return out({ hits: [] });
      if (a === "me") return out({ contributor: { id: 1, name: "sound", units: 0, credits: 0, created_at: 1700000000, team: null } });
      if (a === "health") return out({ ok: true, engine: refs.engine, targets_digest: refs.targetsDigest });
      return out({ error: "unknown_action" }, 400);
    });
    return;
  }
  if (p.startsWith("/app/audio/")) {
    mock.audio.push(p);
    if (p === "/app/audio/manifest.json") {
      if (mock.manifestRaw !== null) { res.writeHead(200, { "content-type": "application/json" }); res.end(mock.manifestRaw); return; }
      if (!mock.manifest) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(mock.manifest)); return;
    }
    const m = p.match(/^\/app\/audio\/(sfx|voice)\/([a-z-]+)\.mp3$/);
    if (m && mock.manifest && mock.manifest[m[1]] && mock.manifest[m[1]][m[2]]) { res.writeHead(200, { "content-type": "audio/mpeg" }); res.end(MP3); return; }
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

/* ————— the browser: constructors wrapped, prefs remembered ————— */

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
function wrap(prefs) {
  window.__LOS_API = "/mock-api/";
  try { localStorage.setItem("los.sound.v1", JSON.stringify(prefs)); } catch (e) {}
  const c = { audio: 0, ctx: 0, plays: 0, pauses: 0, srcs: [], loops: [], paused: [] };
  window.__audio = c;
  const RealAudio = window.Audio;
  window.Audio = function (src) { c.audio++; const a = new RealAudio(src); if (src) c.srcs.push(String(src)); return a; };
  window.Audio.prototype = RealAudio.prototype;
  for (const k of ["AudioContext", "webkitAudioContext"]) {
    const Real = window[k];
    if (!Real) continue;
    window[k] = function (...args) { c.ctx++; return new Real(...args); };
  }
  const play = HTMLMediaElement.prototype.play, pause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.play = function () { c.plays++; c.srcs.push(this.currentSrc || this.src || ""); if (this.loop) c.loops.push(this.src); const p = play.call(this); return p && p.catch ? p.catch(() => {}) : p; };
  HTMLMediaElement.prototype.pause = function () { c.pauses++; c.paused.push(this.src); return pause.call(this); };
}
async function context(prefs) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  await ctx.addInitScript(wrap, prefs);
  return ctx;
}
/* quiet: switch to the Lab through the app's own render(), which is NOT a
 * gesture — used where the test is about the absence of one */
async function openLab(ctx, tag, quiet) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(APP);
  await page.waitForSelector("#nav .tab");
  if (quiet) await page.evaluate(() => { window.__los.state.tab = "lab"; window.__los.render(); });
  else await page.locator('[data-tab="lab"]').click();
  await page.waitForSelector('[data-wizard="open"]');
  return page;
}
const counts = (page) => page.evaluate(() => ({ audio: window.__audio.audio, ctx: window.__audio.ctx, plays: window.__audio.plays, pauses: window.__audio.pauses, srcs: window.__audio.srcs.slice(), loops: window.__audio.loops.slice(), paused: window.__audio.paused.slice() }));
const board = (page) => page.evaluate(() => window.__losSound.counters());
const label = (page) => page.evaluate(() => window.__losSound.label());
const gesture = (page) => page.mouse.click(600, 20);   // an empty spot in the header

/* ————— 1. remembered ON: silence for ten seconds ————— */
suite("sound 1 — a remembered preference arms, it never acts");
reset();
const ctxA = await context({ sfx: true, voice: true, room: false });
const A = await openLab(ctxA, "A", true);
await A.waitForTimeout(10000);
const c1 = await counts(A);
ok(c1.audio === 0 && c1.ctx === 0 && c1.plays === 0, "ten seconds after load: zero Audio constructions, zero AudioContexts, zero plays (" + JSON.stringify({ audio: c1.audio, ctx: c1.ctx, plays: c1.plays }) + ")");
ok(mock.audio.length === 0, "and zero requests under /app/audio/ — not even the manifest");
ok((await label(A)) === "press anywhere to start sound", "the speaker reads 'press anywhere to start sound'");
ok(/press anywhere to start sound/.test(await A.locator('[data-guide="speaker"]').textContent()), "…and the header prints exactly that");
const b1 = await board(A);
ok(b1.armed === true && b1.enabled === false && b1.manifest === "unasked", "the board is armed, not enabled, and has not asked for the manifest");
/* "press anywhere" means a press: tabbing through the page, an arrow key or
 * Escape is navigation and must leave the arming exactly where it was */
for (const key of ["Tab", "Escape", "ArrowDown", "Shift"]) await A.keyboard.press(key);
await A.waitForTimeout(300);
const b1k = await board(A);
const c1k = await counts(A);
ok(b1k.armed === true && b1k.enabled === false && b1k.manifest === "unasked" && c1k.plays === 0 && mock.audio.length === 0, "Tab, Escape, an arrow and a modifier spend nothing: still armed, no manifest, no play (" + JSON.stringify({ armed: b1k.armed, enabled: b1k.enabled, plays: c1k.plays, requests: mock.audio.length }) + ")");

/* ————— 2. a gesture spends the arming ————— */
suite("sound 2 — the next gesture spends it");
await gesture(A);
const woke = await until(async () => { const c = await counts(A); return c.plays >= 1 ? c : null; }, 8000);
ok(!!woke, "a trusted click spends the arming: a sound is played");
ok(mock.audio[0] === "/app/audio/manifest.json", "the first request after the gesture is the manifest");
ok(mock.audio.includes("/app/audio/sfx/console-wake.mp3"), "the console-wake file is fetched lazily");
ok(woke && woke.audio === 1 && woke.srcs.some((s) => /console-wake\.mp3$/.test(s)), "exactly one Audio was made, and it is the console waking (" + (woke && woke.audio) + ")");
ok((await label(A)) === "sound on", "the speaker now reads 'sound on'");
ok((await board(A)).manifest === "ok", "the manifest was read");
ok(mock.audio.filter((p) => p.endsWith(".mp3")).length === 1, "files are loaded one at a time, only the one needed (" + mock.audio.length + " requests)");
/* and a keyboard press — Enter, with nothing focused — is a press too */
{
  const ctxK = await context({ sfx: true, voice: false, room: false });
  const K = await openLab(ctxK, "K", true);
  await K.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
  ok((await board(K)).armed === true && (await board(K)).enabled === false, "a second armed page, keyboard only");
  await K.keyboard.press("Enter");
  const wokeK = await until(async () => { const c = await counts(K); return c.plays >= 1 ? c : null; }, 8000);
  ok(!!wokeK && (await board(K)).enabled === true, "a trusted Enter spends the arming: the console wakes");
  await K.close();
}

/* ————— 3. rate limits ————— */
suite("sound 3 — rate limits");
const r1 = await A.evaluate(() => { const b = window.__losSound; const before = b.counters().accepted; for (let i = 0; i < 6; i++) b.play("confirmed"); return b.counters().accepted - before; });
ok(r1 === 1, "six confirmations inside 1.5 s are one sound (" + r1 + ")");
await sleep(1600);
const r2 = await A.evaluate(() => { const b = window.__losSound; const before = b.counters().accepted; b.play("confirmed"); return b.counters().accepted - before; });
ok(r2 === 1, "after 1.5 s a confirmation sounds again");
const r3 = await A.evaluate(() => { const b = window.__losSound; const before = b.counters().accepted; for (let i = 0; i < 5; i++) b.play("molecule-lock"); return b.counters().accepted - before; });
ok(r3 === 1, "five specimen locks inside 2 s are one click (" + r3 + ")");
const r4 = await A.evaluate(() => { const b = window.__losSound; const before = b.counters().accepted; b.play("unit-issued"); b.play("unit-issued"); b.play("unit-issued"); return b.counters().accepted - before; });
ok(r4 === 1, "three unit-issued blips inside 120 ms are one (" + r4 + ")");
const r5 = await A.evaluate(() => { const b = window.__losSound; const before = b.counters().accepted; b.play("room-tone"); b.play("no-such-sound"); b.play(42); return b.counters().accepted - before; });
ok(r5 === 0, "room tone is not playable as an event, and unknown keys are refused");
await sleep(600);
ok(mock.audio.filter((p) => /\/sfx\/(confirmed|molecule-lock|unit-issued)\.mp3$/.test(p)).length === 3, "each event's file was fetched exactly once");

/* ————— 4. the spoken guide: press-to-play from a listed file ————— */
suite("sound 4 — the spoken guide plays only on a press");
const audioBefore = (await counts(A)).audio;
ok(await A.locator('[data-guide="panel"]').isVisible(), "with the guide remembered on, the transcript panel is open");
const line = await A.locator('[data-guide="text"]').textContent();
ok(/screening console/i.test(line) && /Nothing is donated until you press the button/.test(line), "the Lab's line is printed as text");
await A.locator('[data-guide="play"]').click();
const spoke = await until(async () => { const c = await counts(A); return c.audio > audioBefore ? c : null; }, 5000);
ok(!!spoke && spoke.srcs.some((s) => /\/voice\/lab\.mp3$/.test(s)), "pressing Play makes one Audio from voice/lab.mp3");
ok(!!(await until(async () => mock.audio.includes("/app/audio/voice/lab.mp3"), 4000)), "…which the server saw");
const g4 = await A.evaluate(() => window.__losGuide.state());
ok(g4.played.includes("lab"), "the guide records the line as played this visit");
await A.locator('[data-tab="atlas"]').click();
await sleep(200);
ok(/immortality drug/.test(await A.locator('[data-guide="text"]').textContent()), "switching tabs switches the transcript");
const audioAfterTab = (await counts(A)).audio;
await sleep(1500);
ok((await counts(A)).audio === audioAfterTab, "a tab change plays nothing");
await A.locator('[data-tab="ladder"]').click();
await sleep(200);
ok(/most honest thing in the app/.test(await A.locator('[data-guide="text"]').textContent()), "the Ladder line renders as text");
await A.locator('[data-guide="play"]').click();
await sleep(600);
ok(/no recording on this build/.test(await A.locator('[data-guide="note"]').textContent()), "a page the manifest does not list says 'no recording on this build' and plays nothing");
await A.screenshot({ path: join(HERE, "shots", "sound-guide.png") });
await A.close();

/* ————— 5. missing manifest ⇒ silence, captions render ————— */
suite("sound 5 — a missing manifest is silence, not an error");
reset();
mock.manifest = null;
const ctxB = await context({ sfx: true, voice: true, room: true });
const B = await openLab(ctxB, "B", true);
await gesture(B);
await sleep(1500);
const c5 = await counts(B);
ok(mock.audio.length === 1 && mock.audio[0] === "/app/audio/manifest.json", "only the manifest was asked for (404)");
ok(c5.audio === 0 && c5.plays === 0, "no Audio was made for a file that does not exist");
ok((await board(B)).manifest === "missing" && (await board(B)).enabled === true, "the board is enabled and knows the manifest is missing");
ok((await B.locator('[data-guide="text"]').textContent()).length > 50, "the transcript still renders from NARRATION");
await B.locator('[data-guide="play"]').click();
await sleep(500);
ok(/no recording on this build/.test(await B.locator('[data-guide="note"]').textContent()) && (await counts(B)).audio === 0, "the guide says so in text and plays nothing");
await B.close();
mock.manifest = fullManifest();

/* ————— 6. room tone: loops, stops on hidden, resumes only on a gesture ————— */
suite("sound 6 — room tone");
reset();
const ctxC = await context({ sfx: false, voice: false, room: true });
const C = await openLab(ctxC, "C", true);
await sleep(1500);
ok((await counts(C)).audio === 0 && mock.audio.length === 0, "room tone remembered on: nothing before a gesture");
ok((await label(C)) === "press anywhere to start sound", "…and the speaker says so");
await gesture(C);
const room = await until(async () => { const c = await counts(C); return c.loops.length ? c : null; }, 8000);
ok(!!room && room.loops.some((s) => /room-tone\.mp3$/.test(s)), "the gesture starts the room-tone loop");
ok(mock.audio.includes("/app/audio/sfx/room-tone.mp3") && !mock.audio.includes("/app/audio/sfx/console-wake.mp3"), "with instrument sounds off, only the room tone is fetched — no wake sound");
ok((await label(C)) === "room tone on", "label: room tone on");
await C.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
await sleep(200);
const c6 = await counts(C);
ok(c6.pauses >= 1 && c6.paused.some((s) => /room-tone\.mp3$/.test(s)), "a hidden tab pauses the room tone");
ok((await board(C)).suspended === true && /paused/.test(await label(C)), "the board reports it suspended, in words");
await C.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
await sleep(800);
ok((await counts(C)).plays === c6.plays, "coming back does not resume it by itself");
await gesture(C);
await sleep(800);
ok((await counts(C)).plays > c6.plays, "the next gesture resumes it");
await C.evaluate(() => window.__losSound.setPref("room", false));
await sleep(100);
ok((await counts(C)).pauses >= 2 && (await label(C)) === "sound off", "switching room tone off pauses it and the label reads 'sound off'");
await C.close();

/* ————— 7. the Lab's client events reach the board ————— */
suite("sound 7 — client events");
reset();
const ctxD = await context({ sfx: true, voice: false, room: false });
const D = await openLab(ctxD, "D");
await D.locator(".lab-btn").first().click();   // Donate — a trusted gesture that also spends the arming
const ran = await until(async () => mock.api.submit >= 2, 20000);
ok(!!ran, "the mock swarm ran two units");
await D.locator(".lab-btn-stop").first().click();
await sleep(1200);
const files = mock.audio.filter((p) => p.endsWith(".mp3")).map((p) => p.replace("/app/audio/sfx/", ""));
ok(files.includes("console-wake.mp3"), "the Donate press woke the console");
ok(files.includes("unit-issued.mp3"), "a unit arriving played unit-issued");
ok(files.includes("unit-submitted.mp3"), "a fingerprint sent played unit-submitted");
ok(files.includes("stopped.mp3"), "Stop played stopped");
ok(!files.includes("confirmed.mp3") && !files.includes("conflict.mp3"), "a pending submission is neither a confirmation nor a conflict");
const bd = await board(D);
ok(bd.accepted >= 4, "the board accepted the plays (" + bd.accepted + ")");
mock.submitStatus = "conflict";
await D.locator(".lab-btn").first().click();
await until(async () => mock.api.submit >= 3, 20000);
await D.locator(".lab-btn-stop").first().click();
await sleep(600);
ok(mock.audio.includes("/app/audio/sfx/conflict.mp3"), "a conflict status played the conflict sound");
mock.submitStatus = "confirmed";
await D.locator(".lab-btn").first().click();
await until(async () => mock.api.submit >= 4, 20000);
await D.locator(".lab-btn-stop").first().click();
await sleep(600);
ok(mock.audio.includes("/app/audio/sfx/confirmed.mp3"), "a confirmed status played the confirmed sound");
mock.submitStatus = "pending";
await D.close();

/* ————— 8. the header speaker ————— */
suite("sound 8 — the speaker");
reset();
const ctxE = await context({ sfx: false, voice: false, room: false });
const E = await openLab(ctxE, "E");
await sleep(800);
ok((await label(E)) === "sound off" && mock.audio.length === 0, "off by default: nothing fetched, label 'sound off'");
await E.locator('[data-guide="speaker"]').click();
await until(async () => mock.audio.length >= 2, 5000);
ok((await label(E)) === "sound on" && mock.audio.includes("/app/audio/sfx/console-wake.mp3"), "one press turns sound on and wakes the console");
ok(await E.evaluate(() => JSON.parse(localStorage.getItem("los.sound.v1")).sfx === true), "the choice is remembered");
await E.locator('[data-guide="speaker"]').click();
ok((await label(E)) === "sound off", "a second press turns it off");
const r8 = await E.evaluate(() => { const b = window.__losSound; const before = b.counters().accepted; b.play("unit-issued"); return b.counters().accepted - before; });
ok(r8 === 0, "with sound off, plays are refused");
await E.close();

/* ————— 9. a hostile manifest ————— */
suite("sound 9 — a hostile manifest is ignored");
reset();
mock.manifestRaw = JSON.stringify({ sfx: { "console-wake": { file: "../../index.html" }, "unit-issued": { file: "http://evil.example/x.mp3" }, "../x": { file: "a.mp3" }, "idle": { file: "idle.mp3" } }, voice: "nope" });
const ctxF = await context({ sfx: true, voice: false, room: false });
const F = await openLab(ctxF, "F");
await gesture(F);
await sleep(1500);
ok((await board(F)).manifest === "ok" && (await counts(F)).audio === 0, "traversal and absolute file names are dropped; nothing was made for them");
await F.evaluate(() => window.__losSound.play("idle"));
await sleep(800);
ok(mock.audio.every((p) => p.startsWith("/app/audio/")) && mock.audio.includes("/app/audio/sfx/idle.mp3"), "only the well-formed entry is fetched, under /app/audio/");
mock.manifestRaw = "{not json";
const G = await openLab(await context({ sfx: true, voice: false, room: false }), "G");
await gesture(G);
await sleep(1000);
ok((await board(G)).manifest === "missing" && (await counts(G)).audio === 0, "unparseable manifest ⇒ treated as missing, silent");
mock.manifestRaw = null;
await F.close(); await G.close();

/* ————— 10. zero page errors ————— */
suite("sound 10 — zero page errors");
ok(pageErrors.length === 0, "zero page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "sound: " + failed + " FAILED of " + checks : "sound: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
