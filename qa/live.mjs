/* live — the DEPLOYED LongevityOS, proven from the outside.
 *
 * Local green is not shipped. This runs on a GitHub runner (the authoring
 * sandbox has no route to photon-bounce.com) and asks the live site the only
 * questions that matter after a deploy:
 *   1. freshness  — un-cache-busted fetches return THIS release (build stamp,
 *                   and the engine files byte-for-byte equal to the repo);
 *   2. the API    — health, engine identity, budgets, and a real join → team →
 *                   work → submit → leave arc with the local engine, which is
 *                   the same arc a volunteer's browser runs;
 *   3. the app    — a real browser on desktop and a phone-sized viewport:
 *                   the atlas, the evidence ledger, the Lab with its phone
 *                   controls and teams, zero page errors, screenshots.
 * Everything the arc creates it retires (team_leave + leave), so a daily run
 * leaves no litter on the public boards.
 *
 * Verdict discipline: a failed fetch is a FAILURE, never a skipped check.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium, devices } from "playwright";
import { screenUnit, referenceSet } from "../app/js/chem/score.js";
import { ENGINE_VERSION, targetsDigest } from "../app/js/chem/targets.js";
import { parseFeed, feedFreshness } from "../app/js/feed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(ROOT, "live-shots");
mkdirSync(SHOTS, { recursive: true });

const BASE = (process.env.LOS_LIVE_BASE || "https://photon-bounce.com/longevityos/").replace(/\/?$/, "/");
const API = BASE + "api/";
const UA = "LongevityOS-live-qa/3.0 (+https://github.com/PhotonBounce/longevityos)";
const STAMP = (readFileSync(join(ROOT, "app", "index.html"), "utf8").match(/id="build">([^<]+)</) || [])[1];

let checks = 0, failed = 0;
const notes = [];
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } else console.log("  ✓ " + msg); };
const warn = (msg) => { notes.push(msg); console.log("  ! " + msg); };
const suite = (name) => console.log("── " + name + " ──");

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { ...opts, headers: { "user-agent": UA, ...(opts.headers || {}) }, signal: ctl.signal });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, text: buf.toString("utf8"), type: res.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, buf: Buffer.alloc(0), text: "", type: "", error: String(e) };
  } finally { clearTimeout(t); }
}
const api = async (a, params = {}) => {
  const q = new URLSearchParams({ a, ...params }).toString();
  const r = await get(API + "?" + q);
  try { return { ...r, json: JSON.parse(r.text) }; } catch (_) { return { ...r, json: null }; }
};
const post = async (a, body) => {
  const r = await get(API + "?a=" + a, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try { return { ...r, json: JSON.parse(r.text) }; } catch (_) { return { ...r, json: null }; }
};

/* ————— 1. freshness ————— */
suite("live 1 — freshness (no cache-busting: what a visitor gets)");
ok(!!STAMP, "the repo declares a build stamp (" + STAMP + ")");
const index = await get(BASE);
ok(index.status === 200, "index answers 200 (" + index.status + ")");
ok(index.text.includes('id="build">' + STAMP + "<"), "index carries the current stamp " + STAMP);
const indexNoCache = await get(BASE, { headers: { "cache-control": "no-cache", pragma: "no-cache" } });
ok(indexNoCache.text.includes('id="build">' + STAMP + "<"), "…and so does a no-cache fetch");
for (const rel of ["js/chem/score.js", "js/chem/targets.js", "js/chem/fingerprint.js", "js/swarm/client.js", "js/app.js", "js/lab.js"]) {
  const live = await get(BASE + rel);
  const local = readFileSync(join(ROOT, "app", rel));
  ok(live.status === 200 && live.buf.equals(local), rel + " is byte-identical to the repo (" + live.status + ", " + live.buf.length + " B)");
}
const manifest = await get(BASE + "manifest.webmanifest");
ok(manifest.status === 200, "manifest.webmanifest answers 200 (" + manifest.status + ")");
let man = null; try { man = JSON.parse(manifest.text); } catch (_) {}
ok(man && Array.isArray(man.icons) && man.icons.length >= 2, "the manifest declares icons");
for (const ic of (man && man.icons) || []) {
  const r = await get(BASE + String(ic.src).replace(/^\.?\//, ""));
  const isPng = r.buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isSvg = /^\s*<(\?xml|svg)/.test(r.text);
  ok(r.status === 200 && (isPng || isSvg), "icon " + ic.src + " is served (" + r.status + ", " + (isPng ? "PNG" : isSvg ? "SVG" : r.type) + ")");
}
const feed = await get(BASE + "data/feed.json");
ok(feed.status === 200, "the literature feed is deployed beside the app (" + feed.status + ")");
let parsedFeed = null; try { parsedFeed = parseFeed(JSON.parse(feed.text)); } catch (_) {}
ok(!!parsedFeed, "…and parses through the app's own parser");
if (parsedFeed) { const f = feedFreshness(parsedFeed, Date.now()); (f.stale ? warn : (m) => console.log("  · " + m))("feed freshness: " + f.label); }

/* ————— 2. the API ————— */
suite("live 2 — the swarm API");
const health = await api("health");
ok(health.status === 200 && health.json && health.json.ok === true, "health is ok");
ok(health.json && health.json.engine === ENGINE_VERSION, "live engine is " + ENGINE_VERSION + " (got " + (health.json && health.json.engine) + ")");
const pinned = health.json && health.json.targets_digest;
if (pinned) ok(pinned === targetsDigest(), "live targets digest equals the repo's (" + String(pinned).slice(0, 12) + "…)");
else warn("server is unpinned (no harvest since this engine) — work is idle by design");
ok(health.json && health.json.ingest_armed === true, "the ingest door is armed (key present outside the web root)");
const stats = await api("stats");
ok(stats.status === 200 && stats.json && stats.json.totals, "stats answers");
ok(stats.buf.length < 10240, "stats stays under 10 KB (" + stats.buf.length + " B)");
ok(stats.json && Array.isArray(stats.json.teams), "stats carries the 3.0 teams board");
const hits = await api("hits", { limit: "5" });
ok(hits.status === 200 && hits.json && Array.isArray(hits.json.hits), "hits answers (" + (hits.json && hits.json.hits && hits.json.hits.length) + " rows)");

/* ————— 2b. the 4.0 API surface: history, integer stats fields, ETag/304, the bandwidth meter ————— */
suite("live 2b — the Observatory's data");
const sj = stats.json || {};
ok(typeof sj.quiet === "boolean", "stats carries the quiet flag (" + sj.quiet + ")");
ok(Array.isArray(sj.spectrum) && sj.spectrum.length === 10, "stats carries the 10-bucket score spectrum");
ok(Array.isArray(sj.witnesses) && sj.witnesses.length === 3, "stats carries the witnesses histogram");
ok(sj.clocks && typeof sj.clocks.harvest === "number", "stats carries the freshness clocks");
ok(sj.units && typeof sj.units.open === "number", "stats carries the unit status counts");
const hist = await api("history", { hours: "24" });
ok(hist.status === 200 && hist.json && Array.isArray(hist.json.hour), "history answers (" + (hist.json && hist.json.hour && hist.json.hour.length) + " hours)");
ok(hist.buf.length < 9000, "history stays under 9 KB (" + hist.buf.length + " B)");
const etagRes = await fetch(API + "?a=stats", { headers: { "user-agent": UA } });
const etag = etagRes.headers.get("etag");
ok(!!etag, "stats sends an ETag (" + etag + ")");
ok(/no-cache/.test(etagRes.headers.get("cache-control") || ""), "stats is no-cache (revalidate, never served stale by the host)");
if (etag) {
  const again = await fetch(API + "?a=stats", { headers: { "user-agent": UA, "if-none-match": etag } });
  ok(again.status === 304, "a matching If-None-Match gets 304 (" + again.status + ")");
}
const workHdr = await fetch(API + "?a=work&token=none", { headers: { "user-agent": UA } });
ok(/no-store/.test(workHdr.headers.get("cache-control") || ""), "work is no-store (a cached unit would hand two volunteers the same answer)");
const bw = health.json && health.json.bandwidth;
ok(bw && typeof bw.today_bytes === "number" && typeof bw.budget_bytes === "number", "health reports the host's bandwidth meter");
if (bw) {
  const pct = bw.budget_bytes ? Math.round(100 * bw.today_bytes / bw.budget_bytes) : 0;
  (pct >= 80 ? warn : (m) => console.log("  · " + m))("bandwidth today: " + bw.today_bytes + " B of " + bw.budget_bytes + " (" + pct + "%)" + (bw.quiet ? " — QUIET MODE" : ""));
}
const audioMan = await get(BASE + "audio/manifest.json");
if (audioMan.status === 200) {
  let man = null; try { man = JSON.parse(audioMan.text); } catch (_) {}
  ok(man && man.sfx && man.voice, "the audio manifest parses (sfx + voice)");
  /* The manifest stores a BASENAME per entry and the app prepends the group's
   * directory itself (sound.js: base + "sfx/" + file; guide.js: base +
   * "voice/" + file). A checker that flattens both groups loses that prefix
   * and asks for audio/intro.mp3, which has never existed — it reported 0/20
   * against a site serving all twenty. Ask for what the app asks for. */
  const entries = man ? [
    ...Object.values(man.sfx || {}).map((e) => ({ e, dir: "sfx/" })),
    ...Object.values(man.voice || {}).map((e) => ({ e, dir: "voice/" }))
  ] : [];
  let present = 0;
  const missing = [];
  for (const { e, dir } of entries) {
    const path = "audio/" + dir + String(e.file).replace(/^\/+/, "");
    const r = await fetch(BASE + path, { method: "HEAD", headers: { "user-agent": UA } });
    if (r.status === 200) present++; else missing.push(path + " (" + r.status + ")");
  }
  ok(entries.length > 0 && present === entries.length, "every file the manifest lists is served (" + present + "/" + entries.length + ")" + (missing.length ? ": " + missing.slice(0, 3).join(", ") : ""));
} else if (process.env.LOS_REQUIRE_AUDIO === "1") {
  ok(false, "audio manifest missing (" + audioMan.status + ") and LOS_REQUIRE_AUDIO=1");
} else {
  warn("audio not generated yet (manifest " + audioMan.status + ") — captions carry the guide until gen-audio-longevityos runs");
}

/* ————— 3. the arc: two volunteers, one team, real work, then they leave ————— */
suite("live 3 — join → team → work → submit → leave");
const A = await post("join", { name: "live-qa-a" });
const B = await post("join", { name: "live-qa-b" });
ok(A.json && A.json.token && Number.isInteger(A.json.contributor), "volunteer A joined (#" + (A.json && A.json.contributor) + ")");
ok(B.json && B.json.token && Number.isInteger(B.json.contributor), "volunteer B joined (#" + (B.json && B.json.contributor) + ")");
let teamCode = null;
if (A.json && A.json.token && B.json && B.json.token) {
  const tc = await post("team_create", { token: A.json.token, name: "live-qa" });
  ok(tc.status === 200 && tc.json && tc.json.team && /^[A-HJ-NP-Z2-9]{8}$/.test(tc.json.team.code), "A created a team (" + (tc.json && tc.json.team && tc.json.team.code) + ")");
  teamCode = tc.json && tc.json.team && tc.json.team.code;
  if (teamCode) {
    const tj = await post("team_join", { token: B.json.token, code: teamCode.toLowerCase() });
    ok(tj.status === 200 && tj.json && tj.json.team && tj.json.team.members === 2, "B joined it by code; members = " + (tj.json && tj.json.team && tj.json.team.members));
    const tv = await api("team", { code: teamCode });
    ok(tv.status === 200 && tv.json && tv.json.team && tv.json.team.members === 2 && Array.isArray(tv.json.board), "the public team page shows both");
  }
  const refs = referenceSet();
  const wa = await api("work", { token: A.json.token });
  if (wa.json && wa.json.unit) {
    const ra = screenUnit(wa.json.unit, refs);
    const sa = await post("submit", { token: A.json.token, unit_id: wa.json.unit.unit_id, digest: ra.digest, results: ra.results });
    ok(sa.status === 200 && sa.json && sa.json.accepted, "A's result accepted (" + (sa.json && sa.json.status) + ")");
    const wb = await api("work", { token: B.json.token });
    if (wb.json && wb.json.unit) {
      const rb = screenUnit(wb.json.unit, refs);
      const sb = await post("submit", { token: B.json.token, unit_id: wb.json.unit.unit_id, digest: rb.digest, results: rb.results });
      ok(sb.status === 200 && sb.json && sb.json.accepted, "B's result accepted (" + (sb.json && sb.json.status) + ")");
      if (wb.json.unit.unit_id === wa.json.unit.unit_id) ok(sb.json && sb.json.status === "confirmed", "same unit, identical digests → confirmed by two strangers");
      else warn("B was issued a different unit than A — consensus will come from the next volunteer");
    } else warn("no second unit available for B (" + JSON.stringify(wb.json).slice(0, 80) + ")");
  } else {
    ok(wa.json && (wa.json.idle === true), "no open work right now — the server says so honestly (" + JSON.stringify(wa.json).slice(0, 80) + ")");
  }
  const me = await api("me", { token: A.json.token });
  ok(me.status === 200 && me.json && me.json.contributor && me.json.contributor.id === A.json.contributor, "A can read their own record");
  const pub = await api("contributor", { id: String(A.json.contributor) });
  ok(pub.status === 200 && pub.json && pub.json.contributor && pub.json.contributor.name === "live-qa-a", "A's public record is readable by id");
  const la = await post("leave", { token: A.json.token });
  const lb = await post("leave", { token: B.json.token });
  ok(la.json && la.json.ok === true && lb.json && lb.json.ok === true, "both left the swarm");
  const gone = await api("contributor", { id: String(A.json.contributor) });
  ok(gone.status === 404, "a departed volunteer is no longer on any board (" + gone.status + ")");
  if (teamCode) {
    const tgone = await api("team", { code: teamCode });
    ok(tgone.status === 404, "the emptied team was removed (" + tgone.status + ")");
  }
}

/* ————— 4. the app in a real browser ————— */
suite("live 4 — the app, desktop and phone");
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
async function drive(label, contextOpts) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  const errors = [];
  let mp3Requests = 0;
  page.on("request", (r) => { if (/\.mp3(\?|$)|audio\/manifest\.json/.test(r.url())) mp3Requests++; });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 30000 });
  ok(/No drug has ever been shown to extend human lifespan/.test(await page.locator(".banner-headline").textContent()), label + ": the honesty headline is on screen");
  await page.screenshot({ path: join(SHOTS, label + "-01-atlas.png"), fullPage: true });
  await page.getByRole("button", { name: "What has evidence" }).click();
  await page.waitForTimeout(400);
  const evCards = await page.locator("#view .ev-card").count();
  ok(evCards >= 18, label + ": the evidence ledger renders (" + evCards + " items)");
  ok(/NULL \/ HARM/.test(await page.locator("#view").textContent()), label + ": the ledger shows its nulls and harms");
  await page.screenshot({ path: join(SHOTS, label + "-02-evidence.png"), fullPage: true });
  await page.screenshot({ path: join(SHOTS, label + "-02-evidence-viewport.png") });
  await page.getByRole("button", { name: "The Lab" }).click();
  await page.waitForTimeout(2500);
  const lab = await page.locator("#view").textContent();
  ok(/On a phone or tablet/.test(lab), label + ": the phone section is there");
  ok(/Teams/.test(lab), label + ": the teams section is there");
  ok(!/No swarm server here|not reachable from here/i.test(lab), label + ": the Lab reached the live swarm server");
  ok(/UNDER THE LENS/i.test(lab), label + ": the lens is on the console");
  ok(/Set up this browser/i.test(lab), label + ": the wizard entry is there");
  const ledTwins = await page.$$eval("svg.led", (els) => els.map((svg) => {
    const twin = svg.nextElementSibling;
    return { has: !!(twin && twin.classList.contains("led-text")), text: twin ? twin.textContent : "", svgTitle: (svg.querySelector("title") || {}).textContent || "" };
  }));
  ok(ledTwins.length >= 1 && ledTwins.every((t) => t.has), label + ": every LED has a visible text twin (" + ledTwins.length + ")");
  const strip = await page.locator("#strip").count();
  ok(strip === 1, label + ": the telemetry strip is mounted");
  const logLines = await page.locator(".hud-log li").count();
  ok(logLines >= 1 && logLines <= 20, label + ": the strip's log twin has 1..20 lines (" + logLines + ")");
  await page.screenshot({ path: join(SHOTS, label + "-03-lab.png"), fullPage: true });
  await page.screenshot({ path: join(SHOTS, label + "-03-lab-viewport.png") });   // what a visitor actually sees first
  await page.getByRole("button", { name: "Observatory" }).click();
  await page.waitForTimeout(2500);
  const figures = await page.locator("#view figure").count();
  ok(figures >= 15, label + ": the Observatory renders its figures (" + figures + ")");
  const closedDetails = await page.$$eval("#view figure details", (els) => els.filter((d) => !d.open).length);
  ok(closedDetails === 0, label + ": every 'Read the numbers' table is open");
  const captions = await page.locator("#view figure figcaption").count();
  ok(captions >= 15, label + ": every figure has a caption (" + captions + ")");
  await page.screenshot({ path: join(SHOTS, label + "-04-observatory.png"), fullPage: true });
  await page.screenshot({ path: join(SHOTS, label + "-04-observatory-viewport.png") });
  ok(mp3Requests === 0, label + ": no audio was requested without a tap (" + mp3Requests + " requests)");
  ok(errors.length === 0, label + ": zero page errors" + (errors.length ? " — " + errors.slice(0, 3).join(" | ") : ""));
  await ctx.close();
}
await drive("desktop", { viewport: { width: 1280, height: 900 }, userAgent: UA });
await drive("phone", { ...devices["Pixel 5"], userAgent: UA });
await drive("still", { ...devices["Pixel 5"], userAgent: UA, reducedMotion: "reduce" });
await browser.close();

/* ————— verdict ————— */
writeFileSync(join(SHOTS, "summary.json"), JSON.stringify({
  base: BASE, stamp: STAMP, at: new Date().toISOString(), checks, failed, notes,
  health: health.json, totals: stats.json && stats.json.totals
}, null, 2));
console.log("\nlive: " + (checks - failed) + "/" + checks + " checks passed" + (notes.length ? " (" + notes.length + " notes)" : ""));
if (failed) { console.error("live: " + failed + " FAILED"); process.exit(1); }
