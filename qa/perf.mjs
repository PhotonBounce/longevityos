/* perf — the frame budget is part of the design (the Eternal Lights lesson).
 *
 * A Pixel 5 viewport with the CPU throttled 4× runs the Lab with the strip,
 * the lens and a real screening loop against a mock swarm that never runs out
 * of units, then the Observatory with the client still running, then the
 * same under prefers-reduced-motion. Frames are measured from inside the page
 * (rAF deltas — the app itself has no rAF loop, the probe does), long tasks
 * via PerformanceObserver, and the DOM/animation budgets from the spec are
 * asserted. Numbers land in qa/shots/perf.json so a regression is a diff. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium, devices } from "playwright";
import { TARGETS, targetsDigest, ENGINE_VERSION } from "../app/js/chem/targets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } else console.log("  ✓ " + msg); };
const suite = (name) => console.log("── " + name + " ──");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THROTTLE = Number(process.env.LOS_PERF_THROTTLE || 4);
/* animating: 8 wave groups + 2 stroked closures + the bloom + one readout flip
 * (the spec's 12), plus up to four LED-bar transitions in flight — transform
 * and opacity only, composited, which is why the frame budget beside it is
 * the number that decides */
const BUDGET = { medianMs: 33, p95Ms: 50, longTaskMs: 80, labNodes: 1400, obsNodes: 1200, lensNodes: 220, animating: 16 };

/* ————— a mock swarm that never runs dry ————— */
const SMILES = TARGETS.flatMap((t) => t.actives.map((a) => a.smiles)).concat(["CCO", "c1ccccc1O", "CC(=O)Nc1ccc(O)cc1", "OC(=O)CCC(=O)O", "CN1CCC[C@H]1c1cccnc1", "C1CCCCC1", "NCC(=O)O"]);
let unitNo = 0, submitted = 0, confirmed = 0;
const mock = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const out = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-cache", etag: '"' + (unitNo + submitted) + '"' }); res.end(JSON.stringify(o)); };
  if (!u.pathname.startsWith("/mock-api/")) {
    let p = u.pathname; if (p === "/" || p === "/app/") p = "/app/index.html";
    if (p === "/app/data/feed.json") p = "/data/feed.json";
    const file = p === "/data/feed.json" ? join(HERE, "fixtures", "feed.json") : join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file)); return;
  }
  const a = u.searchParams.get("a");
  let body = ""; req.on("data", (d) => { body += d; }); req.on("end", () => {
    if (a === "health") return out({ ok: true, engine: ENGINE_VERSION, targets_digest: targetsDigest(), molecules: 100000, screened: submitted * 40, verified: confirmed * 40, contributors: 3, ingest_armed: true, bandwidth: { today_bytes: 1234567, budget_bytes: 2e9, quiet: false } });
    if (a === "join") return out({ token: "t".repeat(32), contributor: 1, name: "perf" });
    /* a real server answers in tens of milliseconds; an instant mock would drive
     * the client past any device's real unit rate and measure the mock */
    if (a === "work") { unitNo++; const u = unitNo; return setTimeout(() => out({ unit: { unit_id: "u" + u, engine: ENGINE_VERSION, targets_digest: targetsDigest(), molecules: Array.from({ length: 40 }, (_, i) => ({ id: u * 100 + i, smiles: SMILES[(u + i) % SMILES.length] })) } }), 60); }
    if (a === "submit") { submitted++; confirmed++; return setTimeout(() => out({ accepted: true, credited: 10, status: "confirmed" }), 60); }
    if (a === "stats") return out({ totals: { harvested: 100000, screened: submitted * 40, verified: confirmed * 40, contributors: 3, units_open: 5, pending: 90000, issued: 40, conflict: 1, active_1h: 2 }, leaderboard: [{ name: "perf", units: submitted, credits: submitted * 10 }], teams: [], quiet: false, units: { open: 5, confirmed, conflict: 1, stale: 0 }, canary: { ok: 12, bad: 0 }, spectrum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], targets: TARGETS.map((t) => ({ id: t.id, count: 3 })), witnesses: [5, 2, 1], clocks: { harvest: 1700000000, verified: 1700000000, issued: 1700000000 } });
    if (a === "hits") return out({ hits: SMILES.slice(0, 20).map((s, i) => ({ cid: String(1000 + i), smiles: s, score: 900 - i * 20, best_target: TARGETS[i % TARGETS.length].id, formula: "C9H8O4", flags: [], verified_by: 2 })) });
    if (a === "history") { const n = 48; const hour = Array.from({ length: n }, (_, i) => 1700000000 + i * 3600); const arr = (k) => Array.from({ length: n }, (_, i) => (i * 37 + k) % 200); return out({ hour, harvested: arr(1), screened: arr(2), verified: arr(3), contributors: arr(4), active: arr(5), units_open: arr(6), units_confirmed: arr(7), conflicts: arr(8), results: arr(9), bandwidth: { days: Array.from({ length: 14 }, (_, i) => ({ day: "2026-09-" + String(i + 1).padStart(2, "0"), bytes: i * 1e7 })) } }); }
    if (a === "me") return out({ contributor: { id: 1, name: "perf", units: submitted, credits: submitted * 10, created_at: 1700000000, team: null } });
    return out({ error: "unknown_action" }, 404);
  });
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + mock.address().port;

const PROBE = `
  window.__perf = { frames: [], long: [], anim: [], start() {
    let last = performance.now();
    const tick = (t) => { window.__perf.frames.push(t - last); last = t; if (window.__perf.on) requestAnimationFrame(tick); };
    window.__perf.on = true; requestAnimationFrame(tick);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push(e.duration); }).observe({ entryTypes: ["longtask"] }); } catch (_) {}
    /* each sample: how many animations, whether the lens says its own
     * timeline is still moving (build → settle → readout bars; it reports
     * quiet after that, even while the next specimen is already pending),
     * and whether any running animation carries a transform or a dash (under
     * reduced motion every keyframe is redefined as an opacity fade — spec §2
     * — so that must read 0). The assertions stay measured: the lens only says
     * WHEN it believes nothing moves; getAnimations() says whether it is right. */
    window.__perf.sampler = setInterval(() => { try {
      const list = document.getAnimations();
      let nonFade = 0;
      for (const a of list) { try { if (a.effect.getKeyframes().some((k) => "transform" in k || "strokeDashoffset" in k)) nonFade++; } catch (_) {} }
      const lens = window.__losLens && window.__losLens.api ? window.__losLens.api.state() : null;
      window.__perf.anim.push({ n: list.length, building: !!(lens && !lens.quiet), nonFade });
    } catch (_) {} }, 250);
  }, stop() { window.__perf.on = false; clearInterval(window.__perf.sampler); } };
`;
const stats = (arr) => { const s = [...arr].sort((a, b) => a - b); const q = (p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; return { n: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1] || 0 }; };

async function run(label, extra) {
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const ctx = await browser.newContext(Object.assign({}, devices["Pixel 5"], extra || {}));
  await ctx.addInitScript((api) => { window.__LOS_API = api; }, BASE + "/mock-api/");
  await ctx.addInitScript(PROBE);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  await page.goto(BASE + "/app/index.html");
  await page.waitForSelector(".card");
  await page.locator("#nav .tab", { hasText: "The Lab" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Donate this browser/i }).first().click();
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__perf.start());
  await sleep(30000);
  /* name every animation alive at this instant: when a budget fails, this line says who */
  const alive = await page.evaluate(() => document.getAnimations().map((a) => {
    const t = a.effect && a.effect.target; const tm = a.effect ? a.effect.getTiming() : {};
    let props = []; try { props = [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !/^(offset|computedOffset|easing|composite)$/.test(x))))]; } catch (_) {}
    return (a.animationName || a.transitionProperty || "?") + "@" + (t ? t.tagName.toLowerCase() + "." + String(t.getAttribute("class") || "").split(" ").slice(0, 2).join(".") : "?") + "×" + (tm.iterations === Infinity ? "∞" : tm.iterations) + "[" + props.join(",") + "]";
  }));
  console.log("  · alive at 30 s (" + label + "): " + JSON.stringify(alive));
  const lab = await page.evaluate(() => ({ nodes: document.querySelectorAll("#view *").length, lens: (document.querySelector("#view svg[role=img]") || { querySelectorAll: () => [] }).querySelectorAll("*").length, anim: window.__perf.anim.slice(), frames: window.__perf.frames.splice(0), long: window.__perf.long.splice(0) }));
  await page.locator("#nav .tab", { hasText: "Observatory" }).click();
  await page.waitForTimeout(2000);
  /* the tab switch itself (tearing down the Lab, mounting fifteen figures) is a
   * one-off task, not a frame; the budget below is the steady state after it */
  await page.evaluate(() => { window.__perf.long.length = 0; window.__perf.frames.length = 0; });
  await sleep(15000);
  const obs = await page.evaluate(() => ({ nodes: document.querySelectorAll("#view *").length, anim: window.__perf.anim.slice(), frames: window.__perf.frames.splice(0), long: window.__perf.long.splice(0) }));
  await page.evaluate(() => window.__perf.stop());
  await page.screenshot({ path: join(SHOTS, "perf-" + label + ".png") });
  await browser.close();
  const fl = stats(lab.frames), fo = stats(obs.frames);
  const animOf = (samples) => ({
    animMax: Math.max(0, ...samples.map((x) => x.n)),
    animMaxSettled: Math.max(0, ...samples.filter((x) => !x.building).map((x) => x.n)),
    settledSamples: samples.filter((x) => !x.building).length,
    nonFadeMax: Math.max(0, ...samples.map((x) => x.nonFade))
  });
  const r = { label, throttle: THROTTLE, unitsSubmitted: submitted, lab: Object.assign({ nodes: lab.nodes, lensNodes: lab.lens, frames: fl, longest: Math.max(0, ...lab.long) }, animOf(lab.anim)), observatory: Object.assign({ nodes: obs.nodes, frames: fo, longest: Math.max(0, ...obs.long) }, animOf(obs.anim)), errors };
  console.log("  · " + JSON.stringify(r));
  return r;
}

suite("perf 1 — the Lab and the Observatory under a 4× CPU throttle");
const full = await run("motion");
ok(full.unitsSubmitted >= 3, "the screening loop actually ran (" + full.unitsSubmitted + " units submitted)");
ok(full.errors.length === 0, "zero page errors: " + JSON.stringify(full.errors.slice(0, 2)));
ok(full.lab.frames.median <= BUDGET.medianMs, "Lab median frame ≤ " + BUDGET.medianMs + " ms (" + full.lab.frames.median.toFixed(1) + ")");
ok(full.lab.frames.p95 <= BUDGET.p95Ms, "Lab p95 frame ≤ " + BUDGET.p95Ms + " ms (" + full.lab.frames.p95.toFixed(1) + ")");
ok(full.lab.longest <= BUDGET.longTaskMs, "no Lab long task over " + BUDGET.longTaskMs + " ms (" + full.lab.longest.toFixed(0) + ")");
ok(full.lab.nodes <= BUDGET.labNodes, "Lab DOM within budget (" + full.lab.nodes + " ≤ " + BUDGET.labNodes + ")");
ok(full.lab.lensNodes > 0 && full.lab.lensNodes <= BUDGET.lensNodes, "lens SVG within budget (" + full.lab.lensNodes + " ≤ " + BUDGET.lensNodes + ")");
ok(full.lab.animMax <= BUDGET.animating, "≤ " + BUDGET.animating + " animations at any instant (" + full.lab.animMax + ")");
ok(full.observatory.frames.median <= BUDGET.medianMs, "Observatory median frame ≤ " + BUDGET.medianMs + " ms (" + full.observatory.frames.median.toFixed(1) + ")");
ok(full.observatory.longest <= BUDGET.longTaskMs, "no Observatory long task over " + BUDGET.longTaskMs + " ms — the mount and the first polls are budgeted across tasks (" + full.observatory.longest.toFixed(0) + ")");
ok(full.observatory.nodes <= BUDGET.obsNodes, "Observatory DOM within budget (" + full.observatory.nodes + " ≤ " + BUDGET.obsNodes + ")");

suite("perf 2 — prefers-reduced-motion: same DOM, fades only while a specimen builds, nothing between builds");
/* Spec §2: reduced motion REDEFINES every keyframe as a 120 ms opacity fade
 * (nothing freezes mid-transform), so a build still registers animations —
 * §11 sets the reduced-motion budget at 0 BETWEEN builds. Both halves are
 * asserted: samples taken while the lens holds a specimen may show fades
 * (never a transform or a dash), samples between builds must show none. */
const still = await run("still", { reducedMotion: "reduce" });
ok(still.errors.length === 0, "zero page errors under reduced motion");
ok(still.observatory.longest <= BUDGET.longTaskMs, "no Observatory long task over " + BUDGET.longTaskMs + " ms under reduced motion either (" + still.observatory.longest.toFixed(0) + ")");
ok(Math.abs(still.lab.nodes - full.lab.nodes) <= 40, "reduced motion keeps the same Lab DOM (" + still.lab.nodes + " vs " + full.lab.nodes + ")");
ok(still.lab.settledSamples >= 5, "the sampler caught the lens between builds (" + still.lab.settledSamples + " settled samples)");
ok(still.lab.animMaxSettled === 0 || still.lab.animMaxSettled <= 1, "reduced motion runs (almost) no animations between builds (" + still.lab.animMaxSettled + ")");
ok(still.lab.animMax <= BUDGET.animating, "a reduced-motion build stays within the ≤ " + BUDGET.animating + " budget (" + still.lab.animMax + ")");
ok(still.lab.nonFadeMax === 0, "under reduced motion no running animation carries a transform or a dash — fades only (" + still.lab.nonFadeMax + ")");
ok(still.observatory.animMaxSettled <= 1, "the Observatory under reduced motion animates nothing between builds (" + still.observatory.animMaxSettled + ")");

writeFileSync(join(SHOTS, "perf.json"), JSON.stringify({ budget: BUDGET, motion: full, still }, null, 2));
mock.close();
console.log(failed ? "perf: " + failed + " FAILED of " + checks : "perf: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
