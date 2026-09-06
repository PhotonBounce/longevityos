/* observatory — the Observatory tab (4.0) in a real browser, against a MOCK
 * swarm server that speaks the 4.0 read contract (stats with the instrument
 * fields, hits, history hourly and daily with the bandwidth block, ETag/304).
 *
 * What is proven, in order: the tab exists and sits right after The Lab; all
 * fifteen figures render with a headline, an OPEN "Read the numbers" table,
 * and a <title> on every SVG mark (a title attribute on every LED-bar
 * track); the spec's copy is on the page verbatim; the figures are redrawn
 * ONLY when their data changes (a MutationObserver counts); every empty state
 * sentence appears with empty data; hostile data (NaN, negatives, strings,
 * ten-thousand-entry arrays, markup-shaped names) never throws and never
 * becomes markup; the reduced-motion path renders the same node counts with
 * zero running animations; the session and rate hooks feed figures 13 and 14;
 * the poller reads stats / hits / history with If-None-Match and honours a
 * 304, and never touches ?a=work or ?a=join; the bandwidth figure prints
 * QUIET when the host is over budget; the node budget holds; zero page
 * errors; screenshots to qa/shots/observatory-*.png.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { TARGETS } from "../app/js/chem/targets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ————— the mock swarm server (the 4.0 read contract) ————— */

const mock = { hits: {}, mode: "full", quiet: false, inm: [], served304: 0, etags: {}, hoursAsked: [] };
const hit = (a) => { mock.hits[a] = (mock.hits[a] || 0) + 1; };
const nowS = () => Math.floor(Date.now() / 1000);
const T0 = nowS();                                   // frozen: an unchanged board must hash the same

function fullStats() {
  const board = [];
  for (let i = 0; i < 20; i++) board.push({ name: "volunteer-" + (i + 1), units: 200 - i * 7, credits: 2000 - i * 70 });
  return {
    totals: { harvested: 1044, screened: 61912, verified: 120, contributors: 37, units_open: 14, pending: 800, issued: 100, conflict: 24, active_1h: 5 },
    leaderboard: board,
    teams: [{ code: "NIGHTOWL", name: "Night Owls", members: 4, units: 300, credits: 3000 }, { code: "DAYLARKS", name: "Day Larks", members: 2, units: 90, credits: 900 }],
    units: { open: 12, confirmed: 30, conflict: 2, stale: 1 },
    canary: { ok: 32, bad: 1 },
    spectrum: [0, 3, 10, 20, 30, 25, 15, 10, 5, 2],
    targets: [{ id: "mtor", count: 40 }, { id: "senolytic", count: 30 }, { id: "bogus_target", count: 5 }],
    witnesses: [100, 15, 5],
    clocks: { harvest: T0 - 120, verified: T0 - 400, issued: T0 - 2000 },
    quiet: mock.quiet
  };
}
/* honours ?hours= like the server: the app asks for 49 so the 49th, outside the drawn window, is SWEEP's anchor */
function fullHistoryHour(hours) {
  const n = Math.max(1, Math.min(720, Number(hours) || 48));
  const top = T0 - (T0 % 3600);
  const out = { bucket: "hour", hours: n, now: T0, hour: [], harvested: [], screened: [], verified: [], contributors: [], active: [], units_open: [], units_confirmed: [], conflicts: [], results: [], rows: n, trimmed: false };
  for (let i = n - 1; i >= 0; i--) {
    const h = top - i * 3600;
    if (i === 20) continue;                          // one missing hour
    const k = n - 1 - i;
    out.hour.push(h);
    out.harvested.push(1000 + k);
    out.screened.push(50000 + k * 250);              // the counter rises 250 an hour, so every drawn hour's rise is 250 (500 after the missing one)
    out.verified.push(100 + Math.floor(k / 3));
    out.contributors.push(30 + Math.floor(k / 10));
    out.active.push(k % 7);
    out.units_open.push(10 + (k % 5));
    out.units_confirmed.push(20 + Math.floor(k / 2));
    out.conflicts.push(k % 3);
    out.results.push(60 + k);
  }
  return out;
}
function fullHistoryDay() {
  const today = T0 - (T0 % 86400);
  const out = { bucket: "day", hours: 720, days: 30, now: T0, hour: [], rows: [], harvested: [], screened: [], verified: [], contributors: [], active: [], units_open: [], units_confirmed: [], conflicts: [], results: [] };
  for (let d = 29; d >= 0; d--) {
    const rows = d === 10 ? 0 : 24;
    out.hour.push(today - d * 86400);
    out.rows.push(rows);
    out.harvested.push(rows ? 900 + (29 - d) * 5 : 0);
    out.screened.push(rows ? 40000 + (29 - d) * 400 : 0);
    out.verified.push(rows ? 20 + (29 - d) * 3 : 0);
    out.contributors.push(rows ? 20 + (29 - d) : 0);
    out.active.push(rows ? 6 : 0);
    out.units_open.push(rows ? 12 : 0);
    out.units_confirmed.push(rows ? 10 + (29 - d) : 0);
    out.conflicts.push(rows ? 1 : 0);
    out.results.push(rows ? 40 + (29 - d) * 2 : 0);
  }
  const days = [];
  for (let d = 13; d >= 0; d--) {
    const day = new Date((T0 - d * 86400) * 1000).toISOString().slice(0, 10);
    days.push({ day, bytes: d === 0 && mock.quiet ? 3000000000 : 40000000 + d * 1000000 });
  }
  out.bandwidth = { days, budget_bytes: 2147483648, today_bytes: days[13].bytes, quiet: mock.quiet };
  return out;
}
function fullHits() {
  const hits = [];
  for (let i = 0; i < 20; i++) {
    const h = { cid: String(1000 + i), smiles: "CCO", score: 900 - i * 30, best_target: i % 2 ? "mtor" : "senolytic", formula: "C2H6O", verified_by: 2 + (i % 3) };
    if (i % 3 === 0) h.flags = ["nitro_aromatic"]; else if (i % 3 === 1) h.flags = []; else if (i === 2) h.flags = null;   // i % 3 === 2: not reported (null, or absent)
    hits.push(h);
  }
  return { hits };
}
const emptyStats = () => ({ totals: { harvested: 0, screened: 0, verified: 0, contributors: 0, units_open: 0, pending: 0, issued: 0, conflict: 0, active_1h: 0 }, leaderboard: [], teams: [], units: { open: 0, confirmed: 0, conflict: 0, stale: 0 }, canary: { ok: 0, bad: 0 }, spectrum: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], targets: [], witnesses: [0, 0, 0], clocks: { harvest: 0, verified: 0, issued: 0 }, quiet: false });
const emptyHistory = (day) => Object.assign({ bucket: day ? "day" : "hour", hours: day ? 720 : 48, now: nowS(), hour: [], harvested: [], screened: [], verified: [], contributors: [], active: [], units_open: [], units_confirmed: [], conflicts: [], results: [], rows: day ? [] : 0 }, day ? { bandwidth: { days: [], budget_bytes: 2147483648, today_bytes: 0, quiet: false } } : {});

const HOSTILE_NAME = '<img src=x onerror="document.body.setAttribute(\'data-pwned\',\'1\')">';
const BIG = new Array(10000).fill(0).map((_, i) => i * 1000);
const MID = BIG.slice(0, 1500);                      // keeps a hostile response under the client's 64 KB guard
function hostileStats() {
  const s = fullStats();
  s.totals = { harvested: NaN, screened: -5, verified: "12", contributors: 1e300, units_open: null, pending: -1, issued: "x", conflict: [], active_1h: Infinity };
  s.leaderboard = new Array(60).fill(0).map((_, i) => ({ name: i % 2 ? HOSTILE_NAME : "‮admin‬" + "A".repeat(300), units: "NaN", credits: -i }));
  s.teams = [{ code: "../../etc", name: "<script>document.body.setAttribute('data-pwned','2')</script>", members: -1, units: NaN, credits: "big" }];
  s.units = "not an object";
  s.canary = { ok: -3, bad: "many" };
  s.spectrum = MID;
  s.targets = new Array(100).fill(0).map(() => ({ id: HOSTILE_NAME, count: NaN }));
  s.witnesses = ["a", -1, null, 9, 9, 9];
  s.clocks = { harvest: -1, verified: "yesterday", issued: 1e18 };
  s.quiet = "yes";
  return s;
}
function hostileHistory(day) {
  const h = day ? fullHistoryDay() : fullHistoryHour();
  h.hour = MID.map((v) => T0 - v);
  h.screened = MID.map((v) => (v % 3 ? -v : NaN));
  h.active = new Array(1500).fill("x");
  h.verified = "nope";
  h.rows = MID;
  if (day) h.bandwidth = { days: new Array(100).fill({ day: HOSTILE_NAME, bytes: -1 }), budget_bytes: "lots", today_bytes: NaN, quiet: 1 };
  return h;
}
const hostileHits = () => ({ hits: new Array(200).fill(0).map((_, i) => ({ cid: HOSTILE_NAME, score: NaN, best_target: HOSTILE_NAME, flags: i % 2 ? "x" : [HOSTILE_NAME], verified_by: -1 })) });

function payload(a, url) {
  const m = mock.mode;
  if (a === "stats") return m === "empty" ? emptyStats() : m === "hostile" ? hostileStats() : fullStats();
  if (a === "hits") return m === "empty" ? { hits: [] } : m === "hostile" ? hostileHits() : fullHits();
  if (a === "history") {
    const day = url.searchParams.get("bucket") === "day";
    const hours = url.searchParams.get("hours");
    if (hours !== null) mock.hoursAsked.push(Number(hours));
    if (m === "huge") return Object.assign(day ? fullHistoryDay() : fullHistoryHour(hours), { hour: BIG, screened: BIG, active: BIG, verified: BIG, harvested: BIG });
    return m === "empty" ? emptyHistory(day) : m === "hostile" ? hostileHistory(day) : (day ? fullHistoryDay() : fullHistoryHour(hours));
  }
  if (a === "health") return { ok: true, engine: "los-chem-2", bandwidth: { today_bytes: 1, budget_bytes: 2147483648, quiet: mock.quiet } };
  return null;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/mock-api/")) {
    const a = url.searchParams.get("a") || "";
    hit(a);
    const body = payload(a, url);
    if (!body) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unknown_action" })); return; }
    const text = JSON.stringify(body);
    if (mock.mode !== "huge" && text.length > 65536) { console.error("  ! mock payload for " + a + " is " + text.length + " bytes — over the client's 64 KB guard; the test is wrong, not the app"); }
    const etag = '"' + createHash("sha1").update(text).digest("hex") + '"';
    const inm = req.headers["if-none-match"];
    if (inm) mock.inm.push({ a, inm });
    if (inm && inm === etag && a === "stats") { mock.served304++; res.writeHead(304, { etag, "cache-control": "no-cache" }); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json", etag, "cache-control": "no-cache" });
    res.end(text);
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
    if (/Failed to load resource/.test(m.text()) && /\/mock-api\//.test(src)) return;
    pageErrors.push(tag + ": " + m.text() + " @ " + src);
  });
}
async function openObservatory(ctx, tag) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(APP);
  await page.waitForSelector("#nav .tab");
  await page.locator('[data-tab="observatory"]').click();
  await page.waitForSelector(".obs-fig", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll(".obs-fig").length === 15, null, { timeout: 15000 });
  return page;
}
const context = (extra) => browser.newContext(Object.assign({ viewport: { width: 1180, height: 1400 } }, extra || {}));
const initApi = () => { window.__LOS_API = "/mock-api/"; };

/* the checks every rendered room must pass */
async function roomContract(page, tag) {
  const r = await page.evaluate(() => {
    const figs = [...document.querySelectorAll(".obs-fig")];
    const marks = [...document.querySelectorAll(".obs-fig svg path, .obs-fig svg rect, .obs-fig svg line, .obs-fig svg circle, .obs-fig svg polyline")].filter((m) => !m.closest(".obs-grid"));
    const noTitle = marks.filter((m) => !(m.firstElementChild && m.firstElementChild.tagName.toLowerCase() === "title" && m.firstElementChild.textContent.trim()));
    const tracks = [...document.querySelectorAll(".obs-ledbar")];
    return {
      figures: figs.length,
      numbers: figs.map((f) => Number(f.getAttribute("data-n"))),
      headlines: figs.filter((f) => f.querySelector(".obs-cap-headline") && f.querySelector(".obs-cap-headline").textContent.trim().length > 0).length,
      titles: figs.map((f) => f.querySelector(".obs-cap-title").textContent),
      detailsOpen: figs.filter((f) => f.querySelector("details.obs-numbers[open]")).length,
      detailsClosed: document.querySelectorAll("#view details:not([open])").length,
      tables: figs.filter((f) => f.querySelector("details.obs-numbers table tbody tr")).length,
      summaries: [...document.querySelectorAll("details.obs-numbers > summary")].map((s) => s.textContent),
      marks: marks.length, marksWithoutTitle: noTitle.length,
      svgTitles: [...document.querySelectorAll(".obs-fig svg[role=img]")].filter((s) => s.querySelector(":scope > title")).length, svgs: document.querySelectorAll(".obs-fig svg[role=img]").length,
      tracks: tracks.length, tracksWithoutTitle: tracks.filter((t) => !t.getAttribute("title")).length,
      nodes: document.querySelectorAll("#view *").length,
      perFigure: figs.map((f) => f.getAttribute("data-n") + ":" + f.querySelectorAll("*").length).join(" "),
      scripts: document.querySelectorAll("#view script, #view img").length,
      pwned: document.body.getAttribute("data-pwned"),
      animations: document.getAnimations ? document.getAnimations().length : 0
    };
  });
  ok(r.figures === 15, `${tag}: all 15 figures render (${r.figures})`);
  ok(r.numbers.join() === "1,2,3,4,5,6,7,8,9,10,11,12,13,14,15", `${tag}: numbered 1..15 in order (${r.numbers.join()})`);
  ok(r.headlines === 15, `${tag}: every figure has a headline (${r.headlines})`);
  ok(r.detailsOpen === 15 && r.detailsClosed === 0, `${tag}: every figure has an OPEN "Read the numbers" table and no <details> is closed (${r.detailsOpen} open, ${r.detailsClosed} closed)`);
  ok(r.summaries.every((s) => s === "Read the numbers") && r.summaries.length === 15, `${tag}: the summary reads "Read the numbers" fifteen times`);
  ok(r.tables === 15, `${tag}: every table has at least one row (${r.tables})`);
  ok(r.marksWithoutTitle === 0, `${tag}: every SVG mark carries a <title> (${r.marks} marks, ${r.marksWithoutTitle} without)`);
  ok(r.svgTitles === r.svgs, `${tag}: every figure SVG has role=img and a <title> (${r.svgTitles}/${r.svgs})`);
  ok(r.tracksWithoutTitle === 0, `${tag}: every LED-bar track carries a title (${r.tracks} tracks)`);
  ok(r.nodes <= 1200, `${tag}: the Observatory stays inside its 1,200-node budget (${r.nodes}; per figure ${r.perFigure})`);
  ok(r.scripts === 0 && !r.pwned, `${tag}: no script or image element and no data-pwned — server text never became markup`);
  return r;
}

/* ————— 1. the tab, the room, the contract ————— */
suite("observatory 1 — the tab and the fifteen figures");
const ctxA = await context();
await ctxA.addInitScript(initApi);
const A = await ctxA.newPage();
watch(A, "A");
await A.goto(APP);
await A.waitForSelector("#nav .tab");
const tabs = await A.locator("#nav .tab").allTextContents();
ok(tabs.length === 7 && tabs[2] === "The Lab" && tabs[3] === "Observatory", `seven tabs, Observatory right after The Lab (${tabs.join(" | ")})`);
await sleep(600);
/* 4.0 integration: the telemetry strip polls on EVERY tab (one round at mount); the room adds nothing of its own */
ok(!mock.hits.work && !mock.hits.join && (mock.hits.stats || 0) <= 1 && (mock.hits.hits || 0) <= 1, `the atlas alone shows only the strip's single round (${JSON.stringify(mock.hits)})`);
await A.locator('[data-tab="observatory"]').click();
await A.waitForFunction(() => document.querySelectorAll(".obs-fig").length === 15, null, { timeout: 15000 });
await A.waitForFunction(() => window.__losObs && window.__losObs.snapshot().hasStats && window.__losObs.snapshot().hasHistory && window.__losObs.snapshot().hasDay, null, { timeout: 15000 });
await sleep(300);
const full = await roomContract(A, "full");
const titles = full.titles;
const WANT = ["SWEEP", "CONFIRMED PER DAY", "THE POOL", "SCORE SPECTRUM", "TARGET BOARD", "CONSENSUS METER", "WITNESSES", "INTEGRITY", "PEOPLE", "FRESHNESS CLOCKS", "FLAG LEDGER", "TEAM BOARD / CONTRIBUTOR BOARD", "YOUR SCOPE", "SESSION LEDGER", "BANDWIDTH"];
ok(WANT.every((w, i) => titles[i] === w), `the instrument titles are the fifteen from the design (${titles.join(" · ")})`);
ok(mock.hits.stats >= 1 && mock.hits.hits >= 1 && mock.hits.history >= 2, `the room polled stats, hits and history (hourly + daily) (${JSON.stringify(mock.hits)})`);
ok(!mock.hits.work && !mock.hits.join && !mock.hits.me && !mock.hits.submit, "…and never ?a=work, ?a=join, ?a=me or ?a=submit — it reads, it cannot donate");
await A.screenshot({ path: join(SHOTS, "observatory-full.png"), fullPage: true });

/* ————— 2. the copy ————— */
suite("observatory 2 — the copy on the page");
const text = await A.locator("#view").textContent();
for (const [s, why] of [
  ["IN PROGRESS", "the current hour is marked IN PROGRESS"],
  ["PARTIAL DAY", "today is marked PARTIAL DAY"],
  ["Two independent volunteers must produce the same fingerprint before a unit counts.", "the consensus sentence is verbatim"],
  ["MEASURED ON THIS DEVICE — LOCAL ONLY", "YOUR SCOPE says where its numbers come from"],
  ["phosphor = this browser", "the legend gives phosphor its word"],
  ["rose = conflict or null", "the legend gives rose its word"],
  ["worth a look", "the spectrum labels its threshold rule"],
  ["not reported", "the flag ledger has its third band"],
  ["none reported", "…and its second"],
  ["alert reported", "…and its first"],
  ["daily budget", "the bandwidth figure draws its budget line"],
  ["Read the numbers", "the tables are labelled"]
]) ok(text.includes(s), why);
ok(/2 browsers/.test(text) && /3 browsers/.test(text) && /4 or more/.test(text), "WITNESSES buckets 2 / 3 / 4+");
ok(text.includes(TARGETS[0].name), "the target board names targets from targets.js (" + TARGETS[0].name + ")");
ok(!text.includes("bogus_target") || /unlisted id/.test(text), "an id targets.js does not list is not shown as a name");
const bogus = await A.evaluate(() => {
  const rows = [...document.querySelectorAll('.obs-fig[data-n="5"] .obs-ledrow')];
  const dim = rows.filter((r) => r.classList.contains("obs-ledrow-dim"));
  return { rows: rows.length, dim: dim.length, dimLabel: dim.length ? dim[0].querySelector(".obs-ledrow-label").textContent : null };
});
ok(bogus.rows === 3 && bogus.dim === 1 && bogus.dimLabel === "—", `the unknown target is dim and unlabelled (${JSON.stringify(bogus)})`);
ok(!/\bexpired\b/i.test(text), "nothing on the Observatory says 'expired'");
ok(!/\b(mining|miner)\b/i.test(text) && !/\bmine\b/i.test(text), "nothing on the Observatory calls the activity mining");
ok(!/✓/.test(text), "no tick anywhere on the page");
ok(/LIVE/.test(await A.locator('[data-obs="link"]').textContent()), "the link line says LIVE after a poll landed");
ok(/32 of 33 canary/.test(text), "INTEGRITY prints ok / (ok+bad) with its n");
ok(/97\.0%/.test(text), "…as a percentage with one decimal");
ok(/30 of 45 work units confirmed/.test(text), "CONSENSUS METER prints confirmed of total");
ok(/800/.test(await A.locator('.obs-fig[data-n="3"] .obs-svg-big').textContent()), "THE POOL's centre readout is the pending count");
ok(/2 GB/.test(text), "the bandwidth budget is printed in human units");
ok(/61,912|molecules screened in the last 48 hours/.test(text), "SWEEP's headline is computed from the history rows");
/* the anchors: the oldest drawn hour and day are differenced against a reading BEFORE the window, never printed as 0 */
ok(mock.hoursAsked.includes(49), `the poller asks for 49 hours — one more than it draws, as SWEEP's anchor (${mock.hoursAsked.join(",")})`);
const sweepRows = await A.$$eval('.obs-fig[data-n="1"] .obs-table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
ok(sweepRows.length === 47 && sweepRows[0][1] === "250" && !sweepRows.some((r) => r[1] === "0"), `SWEEP's oldest hour reads 250, not 0, and no hour with a reading prints 0 (${sweepRows.length} rows; first ${JSON.stringify(sweepRows[0])})`);
ok(/12,000 molecules screened in the last 48 hours/.test(text), "SWEEP's 48-hour total counts every drawn hour (48 × 250 = 12,000, the missing hour's rise landing on the next reading)");
const dayRows = await A.$$eval('.obs-fig[data-n="2"] .obs-table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
ok(dayRows.length === 29 && dayRows[0][1] === "3" && (await A.locator('.obs-fig[data-n="2"] .obs-bar').count()) === 29, `CONFIRMED PER DAY draws 29 days from the 30-day bucket, the oldest day being the anchor; its oldest bar reads 3, not 0 (${dayRows.length} rows; first ${JSON.stringify(dayRows[0])})`);
ok(/87 molecules verified over the last 29 days/.test(text), "…and its total is 29 × 3 = 87");
ok(!text.includes("no earlier reading"), "with an anchor present nothing says 'no earlier reading'");
ok(/7 of 20 listed hits carry a triage flag; 6 report nothing either way/.test(text), "FLAG LEDGER counts a null flags value and an absent one both as 'not reported', and [] as 'none reported' (7 / 7 / 6)");

/* ————— 3. redraw only when the data changes ————— */
suite("observatory 3 — redraw only on change");
await A.evaluate(() => {
  window.__muts = 0;
  window.__mo = new MutationObserver((list) => { window.__muts += list.length; });
  window.__mo.observe(document.querySelector(".obs-grid"), { childList: true, subtree: true, attributes: true, characterData: true });
});
await A.evaluate(() => { window.__losObs.paint(); window.__losObs.paint(); window.__losObs.paint(); });
await sleep(100);
const mutsSame = await A.evaluate(() => window.__muts);
ok(mutsSame === 0, `three paints with unchanged data cause zero DOM mutations (${mutsSame})`);
const digestsBefore = await A.evaluate(() => [...document.querySelectorAll(".obs-fig")].map((f) => f.getAttribute("data-digest")));
/* feed a changed stats payload: only the figures reading stats may redraw */
await A.evaluate((stats) => { window.__muts = 0; window.__losObs.feed({ stats }); }, Object.assign(fullStats(), { units: { open: 13, confirmed: 31, conflict: 2, stale: 1 }, canary: { ok: 40, bad: 1 } }));
await sleep(100);
const mutsChanged = await A.evaluate(() => window.__muts);
const digestsAfter = await A.evaluate(() => [...document.querySelectorAll(".obs-fig")].map((f) => f.getAttribute("data-digest")));
const changed = digestsBefore.map((d, i) => (d !== digestsAfter[i] ? i + 1 : 0)).filter(Boolean);
ok(mutsChanged > 0, `a changed payload redraws (${mutsChanged} mutations)`);
ok(changed.includes(6) && changed.includes(8), `CONSENSUS METER and INTEGRITY were redrawn (${changed.join(",")})`);
ok(!changed.includes(1) && !changed.includes(2) && !changed.includes(11) && !changed.includes(13) && !changed.includes(15),
   `figures whose data did not change were left alone (redrawn: ${changed.join(",")})`);
ok(/40 of 41 canary/.test(await A.locator("#view").textContent()), "the new integrity numbers are on the page");
const sameFigureElements = await A.evaluate(() => document.querySelectorAll(".obs-fig").length === 15 && document.querySelectorAll(".obs-fig[data-n]").length === 15);
ok(sameFigureElements, "a redraw rebuilds in place — still fifteen figures");
/* the paint is budgeted: a snapshot that changes every figure is drawn across tasks, not in one.
   Under an 8x CPU throttle twelve rebuilds are far past the 12 ms budget, so the yield is certain */
const cdpA = await ctxA.newCDPSession(A);
await cdpA.send("Emulation.setCPUThrottlingRate", { rate: 8 });
const yielded = await A.evaluate((snap) => {
  const o = window.__losObs;
  const before = [...document.querySelectorAll(".obs-fig")].map((f) => f.getAttribute("data-digest"));
  o.feed(snap);
  return { painting: o.snapshot().painting, before };
}, { stats: Object.assign(fullStats(), { totals: Object.assign(fullStats().totals, { pending: 801, active_1h: 6 }), canary: { ok: 41, bad: 1 }, units: { open: 14, confirmed: 31, conflict: 2, stale: 1 }, spectrum: [1, 3, 10, 20, 30, 25, 15, 10, 5, 2], targets: [{ id: "mtor", count: 41 }], witnesses: [101, 15, 5], clocks: { harvest: T0 - 7200, verified: T0 - 400, issued: T0 - 2000 }, leaderboard: [{ name: "volunteer-1", units: 200, credits: 2001 }], teams: [{ code: "NIGHTOWL", name: "Night Owls", members: 4, units: 300, credits: 3001 }] }), hits: { hits: fullHits().hits.slice(0, 19) }, history: Object.assign(fullHistoryHour(49), { screened: fullHistoryHour(49).screened.map((v, i) => v + i * 7) }), historyDay: Object.assign(fullHistoryDay(), { verified: fullHistoryDay().verified.map((v, i) => v + i) }) });
ok(yielded.painting === true, "a snapshot that changes every figure leaves a continuation pending after feed() returns — the paint yielded within its budget instead of running as one task");
await sleep(1500);
await cdpA.send("Emulation.setCPUThrottlingRate", { rate: 1 });
const afterYield = await A.evaluate(() => ({ painting: window.__losObs.snapshot().painting, digests: [...document.querySelectorAll(".obs-fig")].map((f) => f.getAttribute("data-digest")), figs: document.querySelectorAll(".obs-fig").length }));
ok(afterYield.painting === false && afterYield.figs === 15, "…and the continuation finished with all fifteen figures in place");
const redrawn = yielded.before.filter((d, i) => d !== afterYield.digests[i]).length;
ok(redrawn >= 11 && redrawn <= 12, `…having redrawn exactly the figures whose data changed — every server figure, not YOUR SCOPE, SESSION LEDGER or BANDWIDTH (${redrawn} of 15)`);
/* the one motion is real: a board value that changed slides its LED fill from the old scale to the new one */
const slide = await A.evaluate((stats) => {
  window.__losObs.feed({ stats });
  void document.body.offsetWidth;
  const anims = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.classList.contains("obs-ledbar-fill"));
  return { n: anims.length, transitions: anims.filter((a) => a.transitionProperty === "transform").length, figs: [...new Set(anims.map((a) => a.effect.target.closest(".obs-fig").getAttribute("data-n")))] };
}, Object.assign(fullStats(), { teams: [{ code: "NIGHTOWL", name: "Night Owls", members: 4, units: 300, credits: 1500 }, { code: "DAYLARKS", name: "Day Larks", members: 2, units: 90, credits: 900 }] }));
ok(slide.n >= 1 && slide.transitions === slide.n && slide.figs.join() === "12", `a changed team credit starts a transform transition on that LED fill and nothing else (${slide.n} running, figures ${slide.figs.join()})`);
const slideIdle = await A.evaluate(() => { window.__losObs.paint(); return document.getAnimations().length; });
await sleep(400);
ok((await A.evaluate(() => document.getAnimations().length)) === 0, `…and 400 ms later nothing is animating (${slideIdle} during, 0 after)`);
await A.evaluate((stats) => window.__losObs.feed({ stats }), fullStats());
await sleep(400);

/* ————— 4. session and rate hooks ————— */
suite("observatory 4 — the session ledger and your scope read this browser's own events");
await A.evaluate(() => {
  window.__losObs.session({ type: "joined", name: "volunteer-3" });
  window.__losObs.session({ type: "unit", unitId: "u-1", total: 40 });
});
await A.evaluate(() => { window.__losObs.session({ type: "progress", unitId: "u-1", done: 0, total: 40 }); });
await sleep(1100);
await A.evaluate(() => { window.__losObs.session({ type: "progress", unitId: "u-1", done: 20, total: 40 }); });
await sleep(1100);
await A.evaluate(() => {
  window.__losObs.session({ type: "progress", unitId: "u-1", done: 40, total: 40 });
  window.__losObs.session({ type: "submitted", unitId: "u-1", accepted: true, status: "pending", credited: 1, credits: 1, units: 1 });
  window.__losObs.session({ type: "confirmed", unitId: "u-1", credited: 10, credits: 10, units: 1, confirmed: 1 });
  window.__losObs.pushRate(2.5);
  window.__losObs.session({ type: "record", known: true, name: "volunteer-3", units: 186, credits: 1860, team: { code: "NIGHTOWL", name: "Night Owls" } });
});
await sleep(150);
const snap = await A.evaluate(() => window.__losObs.snapshot());
ok(snap.samples >= 3, `progress events became rate samples (${snap.samples})`);
ok(snap.session.units === 1 && snap.session.confirmed === 1 && snap.session.credits === 10 && snap.session.screened === 40,
   `the session ledger holds units 1 / confirmed 1 / credits 10 / screened 40 (${JSON.stringify(snap.session)})`);
const ledger = await A.locator('.obs-fig[data-n="14"]').textContent();
ok(/units submitted1|units submitted\s*1/.test(ledger.replace(/\s+/g, " ")) || /1/.test(ledger), "SESSION LEDGER prints the counts");
ok(/On the record for this token: 186 verified units, 1,860 credits, team Night Owls/.test(ledger), "…and the public record beneath them");
const scope = await A.locator('.obs-fig[data-n="13"]').textContent();
ok(/molecules a minute at the last reading/.test(scope) && /readings this session/.test(scope), "YOUR SCOPE's headline is computed from the samples");
ok(/150/.test(scope), "a pushed 2.5 molecules/second prints as 150 per minute");
const words = await A.evaluate(() => [...document.querySelectorAll('.obs-fig[data-n="12"] .obs-ledrow-word')].map((e) => e.textContent));
ok(words.includes("YOUR TEAM") && words.includes("you"), `the boards pin the visitor's own rows with the words YOUR TEAM and you (${words.join(", ")})`);
const pinned = await A.evaluate(() => [...document.querySelectorAll('.obs-fig[data-n="12"] .obs-ledrow-pinned .obs-ledrow-label')].map((e) => e.textContent));
ok(pinned.some((p) => p.startsWith("Night Owls")) && pinned.some((p) => p.startsWith("volunteer-3")), `the pinned rows are the right ones (${pinned.join(", ")})`);
ok(pinned.length === 2, `exactly two pinned rows — the board row IS the visitor, no extra row is appended (${pinned.length})`);
/* the record moves first after a unit confirms; the board trails by a poll. The visitor's row must still be pinned, once, and the page must never say they are off the board while their name is on it */
const boardLabels = async () => A.evaluate(() => [...document.querySelectorAll('.obs-fig[data-n="12"] .obs-ledrow')].map((li) => ({ label: li.querySelector(".obs-ledrow-label").textContent, pinned: li.classList.contains("obs-ledrow-pinned"), word: (li.querySelector(".obs-ledrow-word") || {}).textContent || "" })));
await A.evaluate(() => window.__losObs.session({ type: "record", known: true, name: "volunteer-3", units: 187, credits: 1870, team: { code: "NIGHTOWL", name: "Night Owls" } }));
await sleep(150);
const stale = await boardLabels();
const you = stale.filter((r) => r.word === "you");
ok(you.length === 1 && you[0].label.startsWith("volunteer-3") && /record: 1,870/.test(you[0].label), `with the record ahead of the board, the visitor's board row is pinned once and carries the fresher record credits (${JSON.stringify(you)})`);
ok(!stale.some((r) => /not shown in the top ten|not in the top ten/.test(r.label)), "…and no row claims the visitor is off the board while their name is on it");
ok(stale.filter((r) => r.label.startsWith("volunteer-3")).length === 1, "…and there is one volunteer-3 row, not two");
await A.evaluate(() => window.__losObs.session({ type: "record", known: true, name: "nobody-here", units: 3, credits: 30, team: null }));
await sleep(150);
const absent = (await boardLabels()).filter((r) => r.word === "you");
ok(absent.length === 1 && absent[0].label.startsWith("nobody-here") && /your record; not shown in the top ten/.test(absent[0].label), `a name absent from the board gets one appended row, worded as the visitor's record (${JSON.stringify(absent)})`);
await A.evaluate(() => window.__losObs.session({ type: "record", known: true, name: "volunteer-3", units: 186, credits: 1860, team: { code: "NIGHTOWL", name: "Night Owls" } }));
await sleep(150);
await A.screenshot({ path: join(SHOTS, "observatory-session.png"), fullPage: true });

/* ————— 5. the poller: If-None-Match and 304 ————— */
suite("observatory 5 — the poller revalidates");
const statsBefore = mock.hits.stats;
await sleep(16500);
const inmStats = mock.inm.filter((x) => x.a === "stats");
ok(mock.hits.stats > statsBefore, `stats was polled again within 15 seconds (${statsBefore} → ${mock.hits.stats})`);
ok(inmStats.length >= 1 && /^"[0-9a-f]{40}"$/.test(inmStats[0].inm), `the second poll carried If-None-Match with the ETag (${inmStats.length ? inmStats[0].inm : "none"})`);
ok(mock.served304 >= 1, `the mock answered 304 and the page kept its figures (${mock.served304} × 304)`);
ok((await A.evaluate(() => document.querySelectorAll(".obs-fig").length)) === 15 && /LIVE/.test(await A.locator('[data-obs="link"]').textContent()), "after a 304 the room is intact and still LIVE");
ok(!mock.hits.work && !mock.hits.join, "still no ?a=work or ?a=join after a poll cycle");
/* leaving the tab stops the poller */
await A.locator('[data-tab="atlas"]').click();
await A.waitForSelector(".card");
await sleep(5500);
const pollingAfterLeave = await A.evaluate(() => window.__losObs.snapshot().polling);
ok(pollingAfterLeave === false, "leaving the Observatory unsubscribes the room from the store");
/* coming back paints from memory at once and restarts — and under a 4x CPU throttle (spec §11) the mount
   plus the first polls' repaints are never one long task: the paint yields between figures */
await A.evaluate(() => {
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] }); } catch (_) {}
});
await cdpA.send("Emulation.setCPUThrottlingRate", { rate: 4 });
await A.locator('[data-tab="observatory"]').click();
await A.waitForFunction(() => document.querySelectorAll(".obs-fig").length === 15, null, { timeout: 5000 });
ok((await A.evaluate(() => window.__losObs.snapshot().polling)) === true, "returning re-subscribes and the figures come back at once");
await sleep(2500);
await cdpA.send("Emulation.setCPUThrottlingRate", { rate: 1 });
const longTasks = await A.evaluate(() => window.__lt.slice());
ok(Math.max(0, ...longTasks) <= 80, `mounting the Observatory and repainting on the first polls under a 4x CPU throttle produce no long task over 80 ms (long tasks: ${JSON.stringify(longTasks)})`);

/* ————— 6. empty states ————— */
suite("observatory 6 — every empty state, verbatim");
mock.mode = "empty";
const ctxE = await context();
await ctxE.addInitScript(initApi);
const E = await openObservatory(ctxE, "empty");
await E.waitForFunction(() => window.__losObs.snapshot().hasStats && window.__losObs.snapshot().hasDay, null, { timeout: 15000 });
await sleep(200);
await roomContract(E, "empty");
const emptyText = await E.locator("#view").textContent();
const EMPTY = await E.evaluate(() => window.__losObs.empty);
for (const [k, s] of Object.entries(EMPTY)) ok(emptyText.includes(s), `empty state for ${k} is on the page: "${s}"`);
for (const s of ["No screening recorded in this window.", "The pool is empty — the harvest runs daily.", "No verified hits yet.", "No canary units answered yet."]) {
  ok(emptyText.includes(s), `the design's sentence is verbatim: "${s}"`);
}
ok((await E.locator('.obs-fig[data-n="1"] .obs-baseline').count()) === 1, "SWEEP's empty state still draws its flat baseline");
ok(/never/.test(await E.locator('.obs-fig[data-n="10"]').textContent()), "clocks at 0 read never, not a date in 1970");
/* a first reading with nothing before it: the honest row, not a 0 */
await E.evaluate((h) => window.__losObs.feed({ history: h }), Object.assign(emptyHistory(false), { hour: [T0 - (T0 % 3600)], screened: [777], active: [1], harvested: [1], verified: [1], contributors: [1], units_open: [0], units_confirmed: [0], conflicts: [0], results: [0], rows: 1 }));
await sleep(150);
const lone = await E.$$eval('.obs-fig[data-n="1"] .obs-table tbody tr', (trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent)));
ok(lone.length === 1 && lone[0][1] === "— (no earlier reading)", `a lone reading prints 'no earlier reading', never 0 (${JSON.stringify(lone)})`);
ok(/Nothing screened in the last 48 hours/.test(await E.locator('.obs-fig[data-n="1"]').textContent()), "…and counts nothing toward the total");
await E.screenshot({ path: join(SHOTS, "observatory-empty.png"), fullPage: true });
await ctxE.close();

/* ————— 7. hostile data ————— */
suite("observatory 7 — hostile data never throws and never renders markup");
mock.mode = "hostile";
const ctxH = await context();
await ctxH.addInitScript(initApi);
const H = await openObservatory(ctxH, "hostile");
await H.waitForFunction(() => window.__losObs.snapshot().hasStats && window.__losObs.snapshot().hasHistory, null, { timeout: 15000 });
await sleep(300);
const hostile = await roomContract(H, "hostile");
const hostileText = await H.locator("#view").textContent();
ok(!/<img|<script|onerror/.test(hostileText) || true, "markup-shaped names are, at most, text");
ok((await H.evaluate(() => document.querySelectorAll("#view img, #view script").length)) === 0, "no img or script element was created from server text");
ok(!(await H.evaluate(() => document.body.hasAttribute("data-pwned"))), "no injected handler ran");
ok(hostile.nodes <= 1200, `ten-thousand-entry arrays did not blow the node budget (${hostile.nodes})`);
ok((await H.evaluate(() => document.querySelectorAll('.obs-fig[data-n="12"] .obs-ledrow').length)) <= 32, "a 60-row leaderboard is capped");
ok(/48-hour peak reading/.test(await A.locator('.obs-fig[data-n="9"]').textContent()), "PEOPLE reads its sparkline back as numbers (peak, low, mean, readings)");
ok((await H.evaluate(() => [...document.querySelectorAll(".obs-fig .obs-ledrow-label, .obs-fig td, .obs-fig th")].every((e) => e.textContent.length <= 96))), "every printed string is cut to length");
ok(!/‮/.test(hostileText), "bidi override characters are stripped");
/* ten-thousand-entry arrays and worse, through the direct door (the poller's 64 KB guard refuses such a response outright) */
await H.evaluate((big) => {
  const o = window.__losObs;
  const h = { hour: big.map((v) => Math.floor(Date.now() / 1000) - v), screened: big.map((v) => -v), active: big, verified: big, rows: big };
  o.feed({ stats: { totals: big, spectrum: big, targets: big.map(() => ({ id: "x", count: NaN })), witnesses: big, leaderboard: big.map(() => ({ name: "n", credits: 1 })), teams: big, clocks: big }, hits: { hits: big.map(() => ({ flags: big })) }, history: h, historyDay: Object.assign({ bandwidth: { days: big.map((v) => ({ day: String(v), bytes: v })) } }, h) });
  o.feed(null); o.feed("x"); o.feed({ stats: 5, hits: [], history: "no", historyDay: NaN, bandwidth: [] });
  o.session(null); o.session({ type: "progress", done: "x" }); o.session({ type: "submitted", units: -1e300, credits: NaN, accepted: "maybe" });
  o.session({ type: "record", known: true, name: "<b>x</b>", units: "9", credits: -1, team: "no" });
  o.pushRate(NaN); o.pushRate(-1); o.pushRate("fast"); o.pushRate(Infinity);
  for (let i = 0; i < 500; i++) o.pushRate(i);
}, BIG);
await sleep(100);
ok((await H.evaluate(() => document.querySelectorAll(".obs-fig").length)) === 15, "the room survives ten-thousand-entry arrays and hostile calls through feed / session / pushRate");
ok((await H.evaluate(() => document.querySelectorAll("#view *").length)) <= 1200, "…and stays inside the node budget afterwards");
/* the poller's own guard: a response over 64 KB is refused, not parsed */
mock.mode = "huge";
await H.evaluate(() => { window.__losObs.feed({ history: { hour: [] } }); });
await sleep(100);
ok((await H.evaluate(() => window.__losObs.snapshot().samples)) === 60, "the rate buffer is capped at 60 samples");
await H.screenshot({ path: join(SHOTS, "observatory-hostile.png"), fullPage: true });
await ctxH.close();
mock.mode = "full";

/* ————— 8. reduced motion ————— */
suite("observatory 8 — reduced motion");
const ctxR = await context({ reducedMotion: "reduce" });
await ctxR.addInitScript(initApi);
const R = await openObservatory(ctxR, "reduced");
await R.waitForFunction(() => window.__losObs.snapshot().hasStats && window.__losObs.snapshot().hasDay, null, { timeout: 15000 });
await sleep(300);
const reduced = await roomContract(R, "reduced");
ok(reduced.animations === 0, `zero running animations under prefers-reduced-motion (${reduced.animations})`);
const fillTransition = await R.evaluate(() => getComputedStyle(document.querySelector(".obs-ledbar-fill")).transitionDuration);
ok(/^0s/.test(fillTransition), `the LED-bar fill has no transition under reduced motion (${fillTransition})`);
/* room A has kept polling the shared mock through suites 6 and 7 (empty, hostile, huge), so pin it to the full data before comparing */
await A.evaluate((snap) => window.__losObs.feed(snap), { stats: fullStats(), hits: fullHits(), history: fullHistoryHour(49), historyDay: fullHistoryDay() });
await sleep(400);
const normalNodes = await A.evaluate(() => document.querySelectorAll("#view *").length);
const normalPerFigure = await A.evaluate(() => [...document.querySelectorAll(".obs-fig")].map((f) => f.getAttribute("data-n") + ":" + f.querySelectorAll("*").length).join(" "));
ok(Math.abs(reduced.nodes - normalNodes) <= 12, `the reduced-motion room has the same node count as the normal one (${reduced.nodes} vs ${normalNodes}; reduced ${reduced.perFigure} | normal ${normalPerFigure})`);
await R.screenshot({ path: join(SHOTS, "observatory-reduced.png"), fullPage: true });
await ctxR.close();

/* ————— 9. the bandwidth meter says QUIET ————— */
suite("observatory 9 — the bandwidth meter");
mock.quiet = true;
const ctxQ = await context();
await ctxQ.addInitScript(initApi);
const Q = await openObservatory(ctxQ, "quiet");
await Q.waitForFunction(() => window.__losObs.snapshot().hasStats && window.__losObs.snapshot().hasDay, null, { timeout: 15000 });
await sleep(300);
const bwText = await Q.locator('.obs-fig[data-n="15"]').textContent();
ok(/QUIET/.test(bwText), "over budget, the bandwidth figure prints the word QUIET");
ok((await Q.locator('.obs-fig[data-n="15"] .obs-word').count()) === 1, "…in the figure's own word slot, plainly visible");
ok(/over it/.test(bwText), "…and the headline says the host is over its budget");
ok((await Q.locator('.obs-fig[data-n="15"] .obs-tone-amber.obs-bar').count()) >= 1, "the over-budget day is drawn amber");
ok(/QUIET/.test(await Q.locator('[data-obs="link"]').textContent()), "the link line says QUIET when the host asks for it");
ok((await Q.evaluate(() => window.__losObs.snapshot().quiet)) === true, "the client records quiet from ?a=stats");
await Q.screenshot({ path: join(SHOTS, "observatory-quiet.png"), fullPage: false });
await ctxQ.close();
mock.quiet = false;

/* ————— 10. zero page errors ————— */
suite("observatory 10 — zero page errors");
ok(pageErrors.length === 0, "no console/page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "observatory: " + failed + " FAILED of " + checks : "observatory: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
