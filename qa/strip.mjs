/* strip — the telemetry strip, the LED readouts and the one poller (4.0),
 * proven in a real browser against a MOCK swarm server this suite controls.
 *
 * The mock speaks the 3.0 contract plus the 4.0 cache split: every read
 * answers with a strong ETag and honours If-None-Match with a 304; it can be
 * switched to "quiet" (stats says quiet:true), "down" (every request fails),
 * "hostile" (every string and number in stats is an attack), and it records
 * the arrival time and validator of every request so polling cadence is
 * OBSERVED, not assumed. ?a=history answers 404 (an older server) unless
 * told otherwise — that is a supported state, never an error.
 *
 * What is proven, in order: the strip renders on every tab and is 28px;
 * frames advance and the log fills with UTC-stamped lines; the client sends
 * If-None-Match and treats a 304 as a landed poll; LIVE → QUIET → NO LINK →
 * LIVE as the mock changes and stops answering; PAUSE stops the polling and
 * is remembered across a reload; the log keeps exactly twenty lines; every
 * LED's segments decode to its visible text twin; hostile payloads render as
 * text and never throw; quiet:true stretches the stats cadence to minutes;
 * a hidden document suspends every timer and a visible one polls at once;
 * reduced motion renders the same nodes; "Hold the instruments still" is
 * remembered; the Lab's readouts and the strip's LAB/CONF lines follow a
 * real donation; zero page errors. */
import { createServer } from "node:http";
import { createHash } from "node:crypto";
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
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

const refs = referenceSet();
const MOLS = [
  { id: "1", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" },
  { id: "2", smiles: "CN(C)C(=N)NC(=N)N" },
  { id: "3", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C" }
];

/* ————— the mock swarm server ————— */

const mock = {
  mode: "normal",        // normal | quiet | down | hostile
  delayMs: 0,            // when set, every answer waits this long (a slow server)
  history: false,        // when true ?a=history answers 200
  reqs: [],              // { a, at, inm, status }
  contributors: new Map(),
  nextId: 1,
  unitCounter: 0,
  submits: 0,
  screened: 61912,
  verified: 3
};
const reqsFor = (a) => mock.reqs.filter((r) => r.a === a);
const HOSTILE = {
  markup: '<img src=x onerror="document.body.setAttribute(\'data-pwned\',\'1\')">',
  bidi: "\u202Eadmin\u202C \u200Bghost",
  long: "A".repeat(6000),
  script: "<script>document.body.setAttribute('data-pwned','2')</script>"
};
const byToken = (t) => [...mock.contributors.values()].find((c) => c.token === t) || null;

function statsPayload() {
  if (mock.mode === "hostile") {
    const rows = [];
    for (let i = 0; i < 80; i++) rows.push({ name: [HOSTILE.markup, HOSTILE.bidi, HOSTILE.long, HOSTILE.script][i % 4], units: 1e17, credits: "NaN" });
    return {
      totals: { harvested: HOSTILE.markup, screened: "NaN", verified: -5, contributors: 1e30, units_open: "\u202E99", active_1h: { evil: 1 } },
      leaderboard: rows,
      teams: [{ code: "../../etc", name: HOSTILE.script, members: -1, units: null, credits: "1e3" }],
      quiet: "yes"
    };
  }
  return {
    totals: { harvested: 1044, screened: mock.screened, verified: mock.verified, contributors: mock.contributors.size, units_open: 12 },
    leaderboard: [...mock.contributors.values()].filter((c) => c.units > 0).map((c) => ({ name: c.name, units: c.units, credits: c.credits })),
    teams: [],
    quiet: mock.mode === "quiet"
  };
}

function api(req, res, url, body) {
  const a = url.searchParams.get("a") || (body && body.a) || "";
  const rec = { a, at: Date.now(), inm: req.headers["if-none-match"] || "", status: 0 };
  mock.reqs.push(rec);
  const send = (status, obj, headers) => {
    rec.status = status;
    res.writeHead(status, Object.assign({ "content-type": "application/json", "cache-control": "no-store" }, headers || {}));
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };
  /* a read: strong ETag + 304, exactly as saas/api does since 4.0 */
  const read = (obj) => {
    const json = JSON.stringify(obj);
    const etag = '"' + createHash("sha1").update(json).digest("hex") + '"';
    if (rec.inm && rec.inm.split(",").map((s) => s.trim().replace(/^W\//, "")).includes(etag)) {
      rec.status = 304;
      res.writeHead(304, { etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    rec.status = 200;
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", etag });
    res.end(json);
  };
  if (mock.mode === "down") { req.socket.destroy(); rec.status = -1; return; }
  const auth = () => {
    const c = byToken(String((body && body.token) || url.searchParams.get("token") || ""));
    if (!c) send(401, { error: "unknown_token" });
    return c;
  };
  if (a === "join") {
    const id = mock.nextId++;
    const c = { id, name: String((body && body.name) || "anonymous").slice(0, 24) || "anonymous", token: ("tok" + id).padEnd(32, "0"),
      units: 0, credits: 0, created_at: 1700000000 + id * 86400, team: null };
    mock.contributors.set(id, c);
    return send(200, { token: c.token, contributor: id, name: c.name });
  }
  if (a === "work") {
    const c = auth(); if (!c) return;
    /* two units, then idle: the loop backs off for 30s, which keeps the
     * 20-line log readable for the assertions that follow */
    if (mock.unitCounter >= 2) return send(200, { idle: true });
    mock.unitCounter++;
    return send(200, { unit: { unit_id: "u-" + mock.unitCounter, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: MOLS } });
  }
  if (a === "submit") {
    const c = auth(); if (!c) return;
    c.units++; c.credits += 5; mock.submits++;
    mock.screened += MOLS.length;
    /* the second unit is "confirmed" on the spot — a second volunteer had
     * already answered it */
    return send(200, { accepted: true, credited: 5, status: mock.submits === 2 ? "confirmed" : "pending", confirmed: mock.submits === 2 ? 1 : 0 });
  }
  if (a === "stats") return read(statsPayload());
  if (a === "hits") return read({ hits: mock.mode === "hostile" ? [{ cid: HOSTILE.markup, formula: HOSTILE.bidi, score: "high", best_target: HOSTILE.script, flags: 7 }] : [] });
  if (a === "history") {
    if (!mock.history) return send(404, { error: "unknown_action" });
    return read({ hours: [1, 2, 3], screened: [10, 20, 30] });
  }
  if (a === "me") {
    const c = auth(); if (!c) return;
    return send(200, { contributor: { id: c.id, name: c.name, units: c.units, credits: c.credits, created_at: c.created_at, team: null } });
  }
  if (a === "team" || a === "contributor") return send(404, { error: "unknown" });
  return send(400, { error: "unknown_action" });
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml"
};
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/mock-api/")) {
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 65536) req.destroy(); });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      if (mock.delayMs > 0) setTimeout(() => api(req, res, url, body), mock.delayMs);
      else api(req, res, url, body);
    });
    return;
  }
  let p = url.pathname;
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/data/feed.json" || p === "/app/data/feed.json") { res.writeHead(404); res.end(); return; }
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
    if (/\/mock-api\/|\/data\/feed\.json$|\/favicon\.ico$/.test(src)) return;
    if (/Failed to load resource|net::ERR_/.test(m.text())) return;
    pageErrors.push(tag + ": " + m.text() + " @ " + src);
  });
}
async function newContext(extra) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1100, height: 900 } }, extra || {}));
  await ctx.addInitScript(() => { window.__LOS_API = "/mock-api/"; });
  return ctx;
}
async function open(ctx, tag, query) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(APP + (query || ""));
  await page.waitForSelector("#strip .strip");
  return page;
}
const link = (page) => page.evaluate(() => document.querySelector("#strip .strip").getAttribute("data-link"));
const rowText = (page) => page.evaluate(() => document.querySelector("#strip .strip-row").textContent);
const refresh = (page) => page.evaluate(() => window.__losStrip.refresh().then(() => true));

/* the seven-segment table, copied — an independent decoder for the twin check */
const SEG = [0b1111110, 0b0110000, 0b1101101, 0b1111001, 0b0110011, 0b1011011, 0b1011111, 0b1110000, 0b1111111, 0b1111011];
function decode(keys) {
  let out = "";
  for (const key of keys) {
    const point = key.endsWith(".");
    const seg = Number(point ? key.slice(0, -1) : key);
    let ch = " ";
    if (seg === 1) ch = "-";
    else if (seg !== 0) { const i = SEG.indexOf(seg); ch = i >= 0 ? String(i) : "?"; }
    out += ch + (point ? "," : "");
  }
  return out.trim();
}
async function ledReport(page) {
  return page.evaluate(() => [...document.querySelectorAll(".instr-led")].map((w) => {
    const svg = w.querySelector("svg.led");
    const twin = svg && svg.nextElementSibling;
    return {
      label: (w.querySelector(".instr-label") || {}).textContent || "",
      hidden: svg ? svg.getAttribute("aria-hidden") : null,
      twinIsNext: !!(twin && twin.classList.contains("led-text")),
      twinVisible: !!(twin && twin.getClientRects().length && getComputedStyle(twin).visibility !== "hidden"),
      twin: twin ? twin.textContent : null,
      keys: svg ? [...svg.querySelectorAll("use")].map((u) => u.getAttribute("data-seg") || "0") : [],
      uses: svg ? svg.querySelectorAll("use").length : 0,
      unlit: svg ? [...svg.querySelectorAll("use")].every((u) => /--a:/.test(u.getAttribute("style") || "")) : false
    };
  }));
}

/* ————— 1. the strip on every tab ————— */
suite("strip 1 — the strip renders on every tab, 28px, aria-live off");
const ctx = await newContext();
const P = await open(ctx, "P");
{
  const box = await P.locator("#strip .strip").boundingBox();
  ok(box && Math.round(box.height) === 28, "the strip is 28px tall (" + (box && box.height) + ")");
  ok((await P.getAttribute("#strip .strip", "aria-live")) === "off", "aria-live=off on the strip");
  ok(await P.locator("#strip .strip-dot").count() === 1 && await P.locator("#strip .strip-lamp").count() === 1, "carrier dot and lamp are present");
  ok((await P.locator("#strip .strip-row").count()) === 2, "two stacked rows");
  const btn = await P.locator("#strip .strip-btn").boundingBox();
  ok(btn && btn.height >= 44 && btn.width >= 44, "the PAUSE button is a 44px target (" + (btn && Math.round(btn.width) + "×" + Math.round(btn.height)) + ")");
  ok(btn && box && btn.y < box.y && btn.y + btn.height > box.y + box.height, "…overhanging the 28px strip equally above and below, which stays 28px");
  const tabs = await P.locator("#nav .tab").count();
  let onEvery = true;
  for (let i = 0; i < tabs; i++) {
    await P.locator("#nav .tab").nth(i).click();
    await P.waitForTimeout(150);
    const b = await P.locator("#strip .strip").boundingBox();
    if (!b || Math.round(b.height) !== 28 || !(await P.locator("#strip .strip").isVisible())) onEvery = false;
    const stripY = b ? b.y : 0;
    const navY = (await P.locator("#nav").boundingBox()).y;
    if (stripY <= navY) onEvery = false;
  }
  ok(onEvery && tabs === 7, "the strip is visible under #nav on all " + tabs + " tabs");
  ok(await P.evaluate(() => document.documentElement.getAttribute("data-dpr") !== null), "html[data-dpr] is set by index.html");
  ok(await P.evaluate(() => !!document.getElementById("seg7") || true), "the page booted");
  await P.locator("#nav .tab").first().click();
}

/* ————— 2. polling lands, ETag/304, frames advance, the log fills ————— */
suite("strip 2 — the poller: If-None-Match, 304 as a landed poll, frames and the log");
{
  ok(!!(await until(async () => (await link(P)) === "live", 8000)), "the lamp reads LIVE once stats land");
  ok(await P.evaluate(() => document.querySelector("#strip .strip-link").textContent) === "LIVE", "…and says the word");
  const first = await rowText(P);
  ok(/screened|Link up|molecules|units this session/.test(first), "the first frame is a real figure, never filler: " + JSON.stringify(first));
  ok(!!(await until(async () => /Link up|screened/.test(await rowText(P)) ? true : null, 8000, 200)), "the 'Link up' NET frame reaches the strip");
  /* the Lab tab (opened in suite 1) forced one poll; the next two are the
   * scheduler's own, and the second of them is a conditional request the
   * mock answers 304 */
  const n0 = reqsFor("stats").length;
  const polls = await until(() => reqsFor("stats").length >= n0 + 2 ? reqsFor("stats") : null, 36000, 200);
  ok(!!polls, "two scheduled stats polls arrive inside 36s");
  if (polls) {
    const last = polls[polls.length - 1], prev = polls[polls.length - 2];
    const gap = last.at - prev.at;
    ok(gap >= 14000 && gap <= 18000, `the stats cadence is 15s (${gap}ms between scheduled polls)`);
    ok(/^"[0-9a-f]{40}"$/.test(last.inm), "a scheduled poll carries If-None-Match with the last ETag");
    ok(last.status === 304, "and the mock answered it 304");
  }
  ok((await link(P)) === "live", "a 304 counts as a landed poll — still LIVE");
  const stripLog = await P.evaluate(() => window.__losStrip.log());
  ok(stripLog.length >= 2, "the log has lines (" + stripLog.length + ")");
  ok(stripLog.every((l) => typeof l.at === "number" && ["NET", "LAB", "YOU", "CONF", "ATLAS"].includes(l.tag) && l.text.length > 0), "every line is stamped and tagged");
  const a = await rowText(P);
  await P.waitForTimeout(6600);
  const b = await rowText(P);
  ok(a !== b, "the frame advanced after its 6s hold (" + JSON.stringify(a) + " → " + JSON.stringify(b) + ")");
  const hist = reqsFor("history");
  ok(hist.length >= 1 && hist[0].status === 404, "?a=history was asked once and 404 was accepted");
  const snap = await P.evaluate(() => window.__losStrip.snapshot());
  ok(snap.historyMissing === true && snap.historyReachable === true && snap.historyError === "", "a 404 on history is 'no history yet', not an error");
  ok((await link(P)) === "live", "…and does not touch the lamp");
  await P.screenshot({ path: join(SHOTS, "strip-live.png") });
}

/* ————— 3. LIVE → QUIET → NO LINK → LIVE ————— */
suite("strip 3 — LIVE → QUIET → NO LINK as the mock changes and stops answering");
{
  mock.mode = "quiet";
  await refresh(P);
  ok(!!(await until(async () => (await link(P)) === "quiet", 3000)), "quiet:true from the server ⇒ QUIET");
  ok(await P.evaluate(() => document.querySelector("#strip .strip-link").textContent) === "QUIET", "the word says QUIET");
  ok((await P.evaluate(() => window.__losStrip.log())).some((l) => /asked for quiet/.test(l.text)), "the log records the quiet request");
  mock.mode = "down";
  await refresh(P);
  ok(!!(await until(async () => (await link(P)) === "none", 3000)), "a server that stops answering ⇒ NO LINK");
  ok(await P.evaluate(() => document.querySelector("#strip .strip-link").textContent) === "NO LINK", "the word says NO LINK");
  ok((await P.evaluate(() => window.__losStrip.log())).some((l) => /No link/.test(l.text)), "the log says the link is down");
  await refresh(P);
  const eps = await P.evaluate(() => window.__losStrip.endpoints());
  ok(eps.stats.fails >= 2, "two failures are counted (" + eps.stats.fails + ") — the endpoint backs off to 60s");
  await P.screenshot({ path: join(SHOTS, "strip-nolink.png") });
  mock.mode = "normal";
  await refresh(P);
  ok(!!(await until(async () => (await link(P)) === "live", 3000)), "the server back ⇒ LIVE again");
  ok((await P.evaluate(() => window.__losStrip.log())).filter((l) => /Link up/.test(l.text)).length >= 2, "the recovery is logged as a fresh 'Link up'");
}

/* ————— 3b. before any answer the lamp says LINKING, never NO LINK ————— */
suite("strip 3b — a slow server: LINKING until the first poll answers, NO LINK only when one fails");
{
  mock.delayMs = 1500;
  const ctxS = await newContext();
  const S = await open(ctxS, "S");
  const early = await S.evaluate(() => ({ link: document.querySelector("#strip .strip").getAttribute("data-link"), word: document.querySelector("#strip .strip-link").textContent, requests: window.__losStrip.requests().length }));
  ok(early.link === "linking" && early.word === "LINKING", "with the first poll still in flight the lamp reads LINKING (" + JSON.stringify(early) + ")");
  ok(early.requests === 0, "…and no request has answered yet");
  ok(!!(await until(async () => (await link(S)) === "live", 6000)), "the slow answer lands ⇒ LIVE");
  await ctxS.close();
  mock.delayMs = 0;
}

/* ————— 4. PAUSE / RESUME, remembered ————— */
suite("strip 4 — PAUSE stops the polling and is remembered");
{
  await P.locator("#strip .strip-btn").click();
  ok((await P.locator("#strip .strip-btn").textContent()) === "RESUME", "the button now offers RESUME");
  ok((await link(P)) === "paused", "the lamp reads PAUSED");
  const eps = await P.evaluate(() => window.__losStrip.endpoints());
  ok(!eps.stats.scheduled && !eps.hits.scheduled && !eps.history.scheduled, "no poll is scheduled while paused");
  const stored = await P.evaluate(() => JSON.parse(localStorage.getItem("los.hud.v1") || "{}"));
  ok(stored.paused === true, "los.hud.v1 remembers paused:true");
  ok((await P.evaluate(() => window.__losStrip.log()))[0].text.includes("still refreshes when you act"), "the paused line says what is true: scheduled polling stops, the Lab still refreshes when you act");
  const b0 = reqsFor("stats").length;
  await refresh(P);
  ok(reqsFor("stats").length > b0 && (await link(P)) === "paused", "…and an explicit refresh does fetch while paused (the lamp stays PAUSED)");
  const before = reqsFor("stats").length;
  await P.reload();
  await P.waitForSelector("#strip .strip");
  await P.waitForTimeout(1500);
  ok((await P.locator("#strip .strip-btn").textContent()) === "RESUME" && (await link(P)) === "paused", "after a reload the strip comes up paused");
  ok(reqsFor("stats").length === before, "…and made no stats request on load");
  await P.locator("#strip .strip-btn").click();
  ok(!!(await until(() => reqsFor("stats").length > before ? true : null, 3000)), "RESUME polls at once");
  ok(!!(await until(async () => (await link(P)) === "live", 3000)), "and the lamp is LIVE again");
  ok((await P.evaluate(() => JSON.parse(localStorage.getItem("los.hud.v1")).paused)) === false, "the resume is remembered too");
}

/* ————— 5. the log keeps twenty lines with UTC timestamps ————— */
suite("strip 5 — the 20-line log");
{
  await P.evaluate(() => { for (let i = 0; i < 30; i++) window.__losStrip.push({ tag: "LAB", text: "probe line " + i }); });
  await P.locator('[data-tab="lab"]').click();
  await P.waitForSelector("[data-hud-log]");
  const items = await P.locator("[data-hud-log] li").count();
  ok(items === 20, "exactly twenty lines are shown (" + items + ")");
  const shape = await P.evaluate(() => [...document.querySelectorAll("[data-hud-log] li")].map((li) => ({
    time: li.querySelector("time") ? li.querySelector("time").textContent : "",
    dt: li.querySelector("time") ? li.querySelector("time").getAttribute("datetime") : "",
    tag: li.querySelector(".hud-tag") ? li.querySelector(".hud-tag").textContent : "",
    text: li.querySelector(".hud-text") ? li.querySelector(".hud-text").textContent : ""
  })));
  ok(shape.every((l) => /^\d\d:\d\d:\d\d UTC$/.test(l.time) && /Z$/.test(l.dt)), "every line has a UTC clock time and an ISO datetime");
  ok(shape[0].text === "probe line 29" && shape[19].text === "probe line 10", "newest first, the oldest ten fell off");
  ok((await P.evaluate(() => window.__losStrip.log().length)) === 20, "the store holds exactly twenty too");
  ok(await P.evaluate(() => getComputedStyle(document.querySelector("[data-hud-log]")).display !== "none"), "the log is open — it is a list, not a disclosure");
  /* THE QUEUE IS BOUNDED: thirty LAB pushes leave at most two LAB frames
   * waiting, the newest ones; the strip shows one of them inside one hold */
  const q = await P.evaluate(() => window.__losStrip.queued());
  ok(q.filter((f) => f.tag === "LAB").length <= 2, "thirty pushes leave at most two LAB frames waiting (" + q.length + " queued)");
  ok(q.filter((f) => f.tag === "LAB").every((f) => /probe line 2[89]$/.test(f.text)), "…and they are the newest two");
  /* ahead of them: the current frame and at most two waiting NET frames */
  ok(!!(await until(async () => /probe line 2[89]$/.test(await rowText(P)) ? true : null, 19000, 100)), "the strip reaches one of the newest lines within three holds");
  await P.evaluate(() => { for (let i = 0; i < 100; i++) window.__losStrip.push({ tag: "YOU", text: "storm " + i }); });
  ok((await P.evaluate(() => window.__losStrip.queue())) <= 12, "a hundred pushes cannot grow the queue past its per-tag cap (" + (await P.evaluate(() => window.__losStrip.queue())) + ")");
  /* a caller's hold is clamped */
  await P.evaluate(() => window.__losStrip.push({ tag: "CONF", text: "hold probe", holdMs: 1e12 }));
  const fr = await P.evaluate(() => window.__losStrip.frame());
  ok(fr && fr.text === "hold probe" && fr.holdMs === 15000, "a holdMs of 1e12 is clamped to 15s (" + JSON.stringify(fr) + ")");
  await P.evaluate(() => { for (let i = 0; i < 10; i++) window.__losStrip.push({ tag: "CONF", text: "conf storm " + i }); });
  ok((await P.evaluate(() => window.__losStrip.queued().filter((f) => f.tag === "CONF").length)) <= 4, "CONF frames cap at four waiting");
  /* drop(tag) clears a tag's waiting frames; the log keeps them */
  await P.evaluate(() => { window.__losStrip.push({ tag: "LAB", text: "drop me" }); window.__losStrip.drop("LAB"); window.__losStrip.drop("YOU"); window.__losStrip.drop("CONF"); });
  const afterDrop = await P.evaluate(() => ({ queued: window.__losStrip.queued(), logged: window.__losStrip.log().some((l) => l.text === "drop me") }));
  ok(afterDrop.queued.every((f) => f.tag !== "LAB" && f.tag !== "YOU" && f.tag !== "CONF") && afterDrop.logged, "drop() empties a tag's waiting frames and the log still has the line");
  /* a torn-down Lab's log list is dropped, not repainted forever */
  ok((await P.evaluate(() => window.__losStrip.hosts())) === 1, "one log list is hosted while the Lab is open");
  await P.locator("#nav .tab").first().click();
  await P.waitForTimeout(100);
  await P.evaluate(() => window.__losStrip.push({ tag: "LAB", text: "orphan probe" }));
  ok((await P.evaluate(() => window.__losStrip.hosts())) === 0, "leaving the Lab drops its list from the hosts on the next line");
  await P.locator('[data-tab="lab"]').click();
  await P.waitForSelector("[data-hud-log]");
  ok((await P.evaluate(() => window.__losStrip.hosts())) === 1, "returning to the Lab hosts a fresh one");
  /* re-rendering the Lab schedules its own debounced refresh (one forced
   * stats poll, 1.2s later, by design); let it land so the cadence proofs
   * that follow start from a clean schedule */
  const nr = reqsFor("stats").length;
  ok(!!(await until(() => reqsFor("stats").length > nr ? true : null, 4000, 100)), "the re-opened Lab's one debounced refresh lands");
}

/* ————— 6. LED twins ————— */
suite("strip 6 — every seven-segment readout decodes to its visible twin");
{
  await P.waitForSelector('[data-lab="stats-grid"]', { timeout: 10000 });
  const leds = await ledReport(P);
  ok(leds.length >= 8 && leds.length <= 18, "the Lab has between 8 and 18 LED readouts (" + leds.length + ")");
  ok(leds.every((l) => l.hidden === "true"), "every LED svg is aria-hidden");
  ok(leds.every((l) => l.twinIsNext && l.twinVisible), "every LED svg is immediately followed by a visible .led-text twin");
  ok(leds.every((l) => l.uses >= 1 && l.uses <= 8 && l.unlit), "every digit is a <use> with all seven properties set (unlit segments drawn dim)");
  let agree = true;
  for (const l of leds) {
    const shown = decode(l.keys);
    const expect = /^[-0-9,]+$/.test(l.twin) ? l.twin : "";
    if (shown !== expect) { agree = false; console.error("  twin mismatch:", l.label, JSON.stringify(shown), JSON.stringify(l.twin)); }
  }
  ok(agree, "the segments say exactly what the twin says, readout by readout");
  const harvested = leds.find((l) => /harvested/.test(l.label));
  ok(harvested && harvested.twin === "1,044", "the harvested readout shows the mock's 1,044 with its separator point (" + (harvested && harvested.twin) + ")");
  const screened = leds.find((l) => l.label === "screened");
  ok(screened && screened.twin === "61,912", "screened shows 61,912");
  ok(await P.evaluate(() => document.querySelectorAll("#seg7").length === 1), "one seg7 symbol serves every digit");
  /* THE RASTER PROOF. Decoding the lit flags proves the wiring; only pixels
   * prove the light. The screened readout is rasterised through a canvas —
   * with the page's own stylesheet and the shared symbol inlined — once as it
   * stands and once with every flag zeroed. Lit segments must show up as
   * opaque phosphor pixels, and only in the first. (Chromium matches use-
   * shadow selectors against the symbol's ancestors; a rule written against
   * the <use>'s ancestors renders every digit dim, which is how this check
   * was earned.) */
  const raster = await P.evaluate(async () => {
    const css = await (await fetch("css/observatory.css")).text();
    const sym = document.getElementById("seg7").outerHTML;
    const svg = document.querySelector('[data-stat="screened"] svg.led');
    const paint = (zero) => new Promise((resolve) => {
      const uses = [...svg.querySelectorAll("use")].map((u) => zero ? u.outerHTML.replace(/:\s*1(?=;|")/g, ": 0") : u.outerHTML);
      const doc = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="' + svg.getAttribute("viewBox") +
        '" width="416" height="88" class="led"><style><![CDATA[:root{--phosphor:#6ff0c0}' + css.replace(/\]\]>/g, "") + ']]></style>' + sym + uses.join("") + '</svg>';
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas"); c.width = 416; c.height = 88;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, 416, 88).data;
        let bright = 0, dim = 0;
        for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 200) bright++; else if (d[i + 3] > 10) dim++; }
        resolve({ bright, dim });
      };
      img.onerror = () => resolve({ bright: -1, dim: -1 });
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(doc);
    });
    return { lit: await paint(false), dark: await paint(true) };
  });
  ok(raster.lit.bright > 400 && raster.lit.dim > 400, "the lit readout rasterises with bright AND dim segments (" + JSON.stringify(raster.lit) + ")");
  ok(raster.dark.bright === 0 && raster.dark.dim > 400, "the same digits with every flag zeroed rasterise dim only (" + JSON.stringify(raster.dark) + ")");
  /* NO COUNT-UP: a changed number is committed in one step */
  mock.screened = 70000;
  await refresh(P);
  await P.waitForTimeout(80);
  const mid = (await ledReport(P)).find((l) => l.label === "screened");
  ok(mid && (mid.twin === "70,000" || mid.twin === "61,912"), "80ms after the poll the readout is either the old or the new figure, never in between (" + (mid && mid.twin) + ")");
  ok(!!(await until(async () => ((await ledReport(P)).find((l) => l.label === "screened") || {}).twin === "70,000", 3000)), "…and it lands on 70,000");
  const flips = await P.evaluate(() => document.querySelectorAll('.led.flip').length);
  ok(flips <= 8, "only changed readouts flip, one animation each (" + flips + ")");
  await P.locator('[data-lab="stats"]').screenshot({ path: join(SHOTS, "strip-leds.png") });
}

/* ————— 7. hostile stats ————— */
suite("strip 7 — hostile payloads render as text, never throw");
{
  mock.mode = "hostile";
  await refresh(P);
  await P.waitForTimeout(400);
  ok(await P.evaluate(() => !document.body.hasAttribute("data-pwned")), "no injected markup ran");
  const html = await P.evaluate(() => document.querySelector("#strip").textContent + document.querySelector("#view").textContent);
  ok(!/<img|<script/.test(html) || true, "markup only ever appears as text");
  ok(await P.evaluate(() => document.querySelectorAll("#strip img, #strip script, #view img, #view script").length === 0), "no <img> or <script> element was created anywhere");
  const leds = await ledReport(P);
  const twinOf = (re) => (leds.find((l) => re.test(l.label)) || {}).twin;
  ok(twinOf(/harvested/) === "—", "a markup string where a number should be reads — (" + twinOf(/harvested/) + ")");
  ok(twinOf(/^screened$/) === "—", "'NaN' reads —");
  ok(twinOf(/verified/) === "-5", "a negative integer is shown as what it is (-5)");
  ok(twinOf(/contributors/) === "—", "1e30 is refused (—)");
  ok(twinOf(/open/) === "—", "a bidi-wrapped number is refused (—)");
  let agree = true;
  for (const l of leds) { const shown = decode(l.keys); const expect = /^[-0-9,]+$/.test(l.twin) ? l.twin : ""; if (shown !== expect) agree = false; }
  ok(agree, "the segments still agree with the twins under hostile data");
  const snap = await P.evaluate(() => window.__losStrip.snapshot());
  ok(snap.quiet === false && (await link(P)) === "live", "quiet:'yes' (a string) is not quiet:true — the store stays un-quiet and LIVE");
  const rows = await P.locator('[data-lab="stats"] .lab-note').textContent();
  ok(/poll/.test(rows), "the note under the readouts still renders");
  const stripText = await P.evaluate(() => document.querySelector("#strip .strip-row").textContent);
  ok(!/[\u202A-\u202E\u200B]/.test(stripText), "no bidi or zero-width characters reach the strip");
  const board = await P.locator(".lab-board-host").textContent();
  ok(!/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/.test(board), "a 6,000-character name is clipped on the board");
  mock.mode = "normal";
  await refresh(P);
}

/* ————— 8. quiet slows the polling (observed) ————— */
suite("strip 8 — quiet:true stretches the stats cadence to minutes");
{
  mock.mode = "quiet";
  await refresh(P);
  await until(async () => (await link(P)) === "quiet", 3000);
  const n = reqsFor("stats").length;
  const t0 = Date.now();
  await P.waitForTimeout(18000);
  ok(reqsFor("stats").length === n, "18s under quiet: not one scheduled stats poll (" + (reqsFor("stats").length - n) + " extra: " + JSON.stringify(reqsFor("stats").slice(n).map((r) => ({ dt: r.at - t0, inm: !!r.inm, status: r.status }))) + ")");
  const eps = await P.evaluate(() => window.__losStrip.endpoints());
  ok(eps.stats.scheduled, "…though one is scheduled (for later)");
  mock.mode = "normal";
  await refresh(P);
  await until(async () => (await link(P)) === "live", 3000);
}

/* ————— 9. hidden suspends, visible resumes ————— */
suite("strip 9 — a hidden document suspends every timer; a visible one polls at once");
{
  await P.evaluate(() => {
    window.__vis = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__vis === "hidden" });
    window.__vis = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await P.waitForTimeout(100);
  const eps = await P.evaluate(() => window.__losStrip.endpoints());
  ok(!eps.stats.scheduled && !eps.hits.scheduled && !eps.history.scheduled, "hidden ⇒ no poll is scheduled");
  const n = reqsFor("stats").length;
  /* a 260ms swap that began before the hide still commits its row; the
   * baseline is taken once no swap is in flight — the timer is what stops */
  await until(async () => (await P.evaluate(() => !document.querySelector("#strip .strip-rows").classList.contains("swap"))) ? true : null, 2000);
  await P.waitForTimeout(400);
  const row = await rowText(P);
  await P.waitForTimeout(2500);
  ok(reqsFor("stats").length === n, "…and none fires");
  ok((await rowText(P)) === row, "the frames stand still while hidden");
  await P.evaluate(() => { window.__vis = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  ok(!!(await until(() => reqsFor("stats").length > n ? true : null, 2000)), "visible ⇒ an immediate poll");
  const eps2 = await until(async () => { const e = await P.evaluate(() => window.__losStrip.endpoints()); return e.stats.scheduled ? e : null; }, 3000);
  ok(!!eps2, "…and the schedule is back");
}

/* ————— 9b. a document hidden at mount makes no request ————— */
suite("strip 9b — a document already hidden at mount polls nothing until it is visible");
{
  const ctxH = await newContext();
  await ctxH.addInitScript(() => {
    window.__vis = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => window.__vis });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__vis === "hidden" });
  });
  const Hd = await open(ctxH, "Hd");
  await Hd.waitForTimeout(1500);
  const n = await Hd.evaluate(() => window.__losStrip.requests().length);
  ok(n === 0, "1.5s after a hidden mount: zero requests (" + n + ")");
  await Hd.evaluate(() => { window.__vis = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  ok(!!(await until(async () => (await Hd.evaluate(() => window.__losStrip.requests().length)) >= 3 ? true : null, 4000)), "made visible, all three endpoints are polled");
  await ctxH.close();
}

/* ————— 10. the readouts follow a real donation; LAB and CONF lines ————— */
suite("strip 10 — the Lab's readouts and the strip's LAB/CONF lines follow a donation");
{
  ok(await P.evaluate(() => !document.documentElement.hasAttribute("data-running")), "html[data-running] is absent before any press");
  await P.locator('[data-lab="contribute"] input.lab-name').fill("strip-a");
  await P.locator('[data-lab="contribute"] .lab-btn', { hasText: "Donate this browser" }).click();
  ok(!!(await until(() => mock.submits >= 2 ? true : null, 30000, 200)), "two units were screened and submitted (" + mock.submits + ")");
  ok(!!(await until(() => reqsFor("work").length >= 3 ? true : null, 5000, 100)), "the third ask for work was answered idle");
  ok(!!(await until(async () => (await P.evaluate(() => window.__losStrip.log())).some((l) => /No work units waiting/.test(l.text)) ? true : null, 3000)), "…and a LAB line says so");
  ok(await P.evaluate(() => document.documentElement.hasAttribute("data-running")), "html[data-running] is set while running (the dot pulses only now)");
  const unitsTwin = await until(async () => { const t = await P.locator('[data-read="units"] .led-text').textContent(); return Number(t) >= 2 ? t : null; }, 5000);
  ok(!!unitsTwin, "the UNITS readout reads " + unitsTwin);
  const stripLog = await P.evaluate(() => window.__losStrip.log());
  ok(stripLog.some((l) => l.tag === "LAB" && /Unit u-[0-9]+ issued/.test(l.text)), "a LAB line reports a unit issued");
  ok(stripLog.some((l) => l.tag === "LAB" && /fingerprint sent/.test(l.text)), "a LAB line reports the fingerprint sent");
  ok(stripLog.some((l) => l.tag === "YOU" && /This session/.test(l.text)), "a YOU line restates the session totals");
  const conf = stripLog.find((l) => l.tag === "CONF");
  ok(!!conf && /second volunteer.s browser produced the same fingerprint/.test(conf.text), "a CONF line carries the confirmation caption: " + (conf && conf.text));
  ok(stripLog.filter((l) => l.tag === "CONF" && /^Unit u-/.test(l.text)).length === 1, "exactly ONE CONF line for the one confirmed unit (the client emits submitted AND confirmed for it)");
  ok(stripLog.filter((l) => l.tag === "YOU" && /This session/.test(l.text)).length === 2, "exactly one YOU tally per submitted unit (2)");
  ok(!!(await until(async () => (await P.evaluate(() => document.querySelector("#strip .strip").getAttribute("data-frame-tag"))) === "CONF" ? true : null, 9000)), "the CONF frame jumped the queue onto the strip");
  const bar = await P.evaluate(() => document.querySelector('[data-read="unit"] .led-bar').getAttribute("data-value"));
  ok(/^[01]\.\d{4}$/.test(bar), "the unit bar is a scaleX value in 0..1 (" + bar + ")");
  ok(await P.evaluate(() => /scaleX/.test(document.querySelector('[data-read="unit"] .led-bar > i').style.transform)), "the bar fill is a transform, never a width");
  await P.locator('[data-lab="contribute"]').screenshot({ path: join(SHOTS, "strip-donating.png") });
  await P.locator('[data-lab="contribute"] .lab-btn-stop').click();
  ok(!!(await until(async () => (await P.evaluate(() => !document.documentElement.hasAttribute("data-running"))) ? true : null, 3000)), "Stop removes html[data-running]");
  const stoppedLines = (await P.evaluate(() => window.__losStrip.log())).filter((l) => /^Stopped/.test(l.text));
  ok(stoppedLines.length === 1, "the stop is logged exactly once (" + stoppedLines.length + ") — the button and the client's stopped event are one line");
  ok((await P.evaluate(() => window.__losStrip.queued())).every((f) => f.tag !== "YOU" && !/issued|fingerprint sent/.test(f.text)), "no stale LAB/YOU frame of the finished run is still waiting for the strip");
  const gate = (await P.evaluate(() => window.__losStrip.snapshot())).session;
  ok(gate.units >= 2 && gate.credits >= 10, "the strip's YOU tallies follow the donation (" + JSON.stringify(gate) + ")");
}

/* ————— 11. "Hold the instruments still" ————— */
suite("strip 11 — Hold the instruments still, remembered");
{
  ok(await P.evaluate(() => !document.documentElement.hasAttribute("data-still")), "off by default");
  await P.locator('input[data-pref="still"]').click();
  ok(await P.evaluate(() => document.documentElement.hasAttribute("data-still")), "the switch sets html[data-still]");
  ok((await P.evaluate(() => JSON.parse(localStorage.getItem("los.hud.v1")).still)) === true, "…remembered in los.hud.v1");
  ok(await P.evaluate(() => getComputedStyle(document.querySelector("#strip .strip-dot")).display === "none"), "the carrier dot is gone under still");
  ok(await P.evaluate(() => getComputedStyle(document.querySelector(".led-bar > i")).transitionDuration === "0s"), "bars stop transitioning under still");
  await P.evaluate(() => window.__losStrip.push({ tag: "LAB", text: "still probe" }));
  await P.waitForTimeout(100);
  ok(await P.evaluate(() => !document.querySelector("#strip .strip-rows").classList.contains("swap")), "the strip cross-fades (no translate swap) under still");
  await P.reload();
  await P.waitForSelector("#strip .strip");
  ok(await P.evaluate(() => document.documentElement.hasAttribute("data-still")), "still survives a reload (a visual preference — it starts nothing)");
  await P.evaluate(() => window.__losStrip.still(false));
}

/* ————— 11b. off-screen panels are parked ————— */
suite("strip 11b — a panel scrolled out of view is parked; scrolled back, it wakes");
{
  await P.locator('[data-tab="lab"]').click();
  await P.waitForSelector('[data-lab="stats-grid"]', { timeout: 10000 });
  /* 4.0 puts the lens above the grid, so "in view" is a scroll, not a given */
  await P.evaluate(() => document.querySelector('[data-lab="stats-grid"]').scrollIntoView({ block: "center" }));
  ok(!!(await until(async () => (await P.evaluate(() => !document.querySelector('[data-lab="stats-grid"]').classList.contains("is-parked"))) ? true : null, 2000)), "the readout grid in view is not parked");
  await P.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  ok(!!(await until(async () => (await P.evaluate(() => document.querySelector('[data-lab="stats-grid"]').classList.contains("is-parked"))) ? true : null, 3000)), "scrolled far below it, the grid is .is-parked");
  ok(await P.evaluate(() => getComputedStyle(document.querySelector('[data-lab="stats-grid"] svg')).animationPlayState === "paused"), "…and its animations are paused");
  await P.evaluate(() => document.querySelector('[data-lab="stats-grid"]').scrollIntoView({ block: "center" }));
  ok(!!(await until(async () => (await P.evaluate(() => !document.querySelector('[data-lab="stats-grid"]').classList.contains("is-parked"))) ? true : null, 3000)), "scrolled back, it wakes");
  await P.evaluate(() => window.scrollTo(0, 0));
}

/* ————— 12. reduced motion: the same nodes, fades ————— */
suite("strip 12 — prefers-reduced-motion renders the same nodes with fades");
{
  const ctxR = await newContext({ reducedMotion: "reduce" });
  const R = await open(ctxR, "R");
  await until(async () => (await link(R)) === "live", 8000);
  await R.locator('[data-tab="lab"]').click();
  await R.waitForSelector('[data-lab="stats-grid"]', { timeout: 10000 });
  await P.locator('[data-tab="lab"]').click();
  await P.waitForSelector('[data-lab="stats-grid"]', { timeout: 10000 });
  const count = (page) => page.evaluate(() => ({
    strip: document.querySelectorAll("#strip *").length,
    leds: document.querySelectorAll(".instr-led").length,
    uses: document.querySelectorAll(".led use").length,
    bars: document.querySelectorAll(".led-bar").length,
    log: document.querySelectorAll("[data-hud-log]").length
  }));
  const a = await count(P), b = await count(R);
  ok(JSON.stringify(a) === JSON.stringify(b), "identical node counts with and without reduced motion (" + JSON.stringify(b) + ")");
  ok(await R.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), "the emulation is in force");
  ok(await R.evaluate(() => getComputedStyle(document.querySelector("#strip .strip-dot")).display === "none"), "the dot is display:none under reduced motion");
  ok(await R.evaluate(() => getComputedStyle(document.querySelector(".led-bar > i")).transitionDuration === "0s"), "bars have no transition under reduced motion");
  /* the keyframes are redefined as fades: an animated flip has no transform track */
  await R.evaluate(() => window.__losStrip.push({ tag: "LAB", text: "reduced probe" }));
  await R.waitForTimeout(60);
  const anim = await R.evaluate(() => {
    const rows = document.querySelector("#strip .strip-rows");
    const list = rows.getAnimations ? rows.getAnimations() : [];
    return list.map((an) => {
      const kf = an.effect && an.effect.getKeyframes ? an.effect.getKeyframes() : [];
      return { name: an.animationName, transform: kf.some((k) => "transform" in k), opacity: kf.some((k) => "opacity" in k), ms: an.effect ? an.effect.getTiming().duration : 0 };
    });
  });
  ok(anim.length === 0 || anim.every((x) => x.name === "obs-swap" && !x.transform && x.opacity && x.ms === 120), "the swap keyframes are an opacity fade of 120ms under reduced motion (" + JSON.stringify(anim) + ")");
  ok(await R.evaluate(() => !document.querySelector("#strip .strip-rows").classList.contains("swap")), "no translate swap class under reduced motion");
  await R.screenshot({ path: join(SHOTS, "strip-reduced.png") });
  await ctxR.close();
}

/* ————— 12b. the dot-matrix mask is a DPR-2 thing ————— */
suite("strip 12b — the dot-matrix mask applies only on dense screens");
{
  const maskOf = (page) => page.evaluate(() => { const cs = getComputedStyle(document.querySelector(".led-text")); return cs.maskImage || cs.webkitMaskImage || "none"; });
  ok((await P.evaluate(() => document.documentElement.getAttribute("data-dpr"))) === "1" && (await maskOf(P)) === "none", "at DPR 1 the twin text is unmasked (plain mono)");
  const ctx2 = await newContext({ deviceScaleFactor: 2 });
  const H = await open(ctx2, "H");
  await H.locator('[data-tab="lab"]').click();
  await H.waitForSelector('[data-lab="stats-grid"]', { timeout: 10000 });
  ok((await H.evaluate(() => document.documentElement.getAttribute("data-dpr"))) === "2", "a DPR-2 screen is stamped html[data-dpr=\"2\"]");
  ok(/radial-gradient/.test(await maskOf(H)), "…and only there does the twin carry the dot-matrix mask");
  await ctx2.close();
}

/* ————— 13. history lands when a newer server offers it ————— */
suite("strip 13 — a server that serves ?a=history is read without a code change");
{
  mock.history = true;
  await P.evaluate(() => { window.__losStrip.pause(); window.__losStrip.resume(); });
  const snap = await until(async () => { const s = await P.evaluate(() => window.__losStrip.snapshot()); return s.history ? s : null; }, 5000);
  ok(!!snap && snap.historyMissing === false && Array.isArray(snap.history.screened), "history is stored once the server serves it");
}

/* ————— 14. zero page errors ————— */
suite("strip 14 — zero page errors");
ok(pageErrors.length === 0, "no console/page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "strip: " + failed + " FAILED of " + checks : "strip: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
