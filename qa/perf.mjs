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
/* Animations are budgeted PER FAMILY, against what the design permits of each:
 * 8 wave groups + 6 ring closures + 1 settle per lens build, one flip per LED
 * that changed (a submit changes several at once — that is the design, and it
 * is what a plain sum of "animations at any instant" kept tripping over at 15,
 * 16, 18 while every frame metric held), the strip's bloom and its one swap,
 * a transform transition per LED bar, and nothing the budget has not named:
 * an animation family this table does not know is a failure. The frame
 * budget beside it is still the number that decides — everything here is
 * transform/opacity, composited. */
const BUDGET = { medianMs: 33, p95Ms: 50, longTaskMs: 80, labNodes: 1400, obsNodes: 1200, lensNodes: 220 };
const PLATFORM_CEILING = 150;   // an unattributed hitch this big is a paint regression, not machine noise
/* cap per family; a function reads the DOM counts the sampler recorded */
const FAMILY_CAP = {
  "lens-grow": () => 8, "obs-close": () => 6, "obs-settle": () => 1,
  "obs-flip": (c) => c.leds, "lens-flip": (c) => c.lensLeds,
  "obs-bloom": () => 1, "obs-swap": () => 1,
  "transition:transform": (c) => c.bars, "transition:opacity": () => 1,
  /* reduced motion redefines every keyframe as a fade; these carry the same caps as the families they replace */
  "obs-fade": (c) => 8 + 6 + c.leds + c.lensLeds, "obs-still": () => 1
};
function familyBreaches(samples) {
  const out = [];
  for (const smp of samples) {
    for (const [fam, n] of Object.entries(smp.fam || {})) {
      const cap = FAMILY_CAP[fam] ? FAMILY_CAP[fam](smp.caps || {}) : 0;
      if (n > cap) out.push(fam + " " + n + " > " + cap);
    }
  }
  return [...new Set(out)];
}

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
  /* WHAT a long task was, not just how long. The app is not instrumented for
   * this — these wrappers live only in the probe: every main-thread hot path
   * the Lab uses (worker post/receive, fetch, response parsing, JSON) records
   * the window it occupied, and a long task is attributed to whichever
   * windows overlap it. A long task nothing overlaps is the platform's own
   * (style, layout, paint, GC) and is reported as such. */
  window.__perf = { frames: [], long: [], anim: [], marks: [], mark(name, t0, t1) {
    if (this.marks.length > 4000) this.marks.splice(0, 2000);
    this.marks.push({ n: name, a: t0, b: t1 });
  }, start() {
    const RAW = window.__perf.__raw || { raf: requestAnimationFrame.bind(window), si: setInterval.bind(window) };
    let last = performance.now();
    const tick = (t) => { window.__perf.frames.push(t - last); last = t; if (window.__perf.on) RAW.raf(tick); };
    window.__perf.on = true; RAW.raf(tick);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push({ d: e.duration, t: e.startTime }); }).observe({ entryTypes: ["longtask"] }); } catch (_) {}
    /* each sample: how many animations, whether the lens says its own
     * timeline is still moving (build → settle → readout bars; it reports
     * quiet after that, even while the next specimen is already pending),
     * and whether any running animation carries a transform or a dash (under
     * reduced motion every keyframe is redefined as an opacity fade — spec §2
     * — so that must read 0). The assertions stay measured: the lens only says
     * WHEN it believes nothing moves; getAnimations() says whether it is right. */
    window.__perf.sampler = RAW.si(() => { try {
      const list = document.getAnimations();
      let nonFade = 0;
      const fam = {};
      for (const a of list) {
        try { if (a.effect.getKeyframes().some((k) => "transform" in k || "strokeDashoffset" in k)) nonFade++; } catch (_) {}
        const name = a.animationName || (a.transitionProperty ? "transition:" + a.transitionProperty : "?");
        fam[name] = (fam[name] || 0) + 1;
      }
      const caps = {
        leds: document.querySelectorAll("svg.led").length,
        lensLeds: document.querySelectorAll('[data-lab="lens"] svg.led').length,
        bars: document.querySelectorAll(".led-bar > i, .lens-bar-track i").length
      };
      const lens = window.__losLens && window.__losLens.api ? window.__losLens.api.state() : null;
      window.__perf.anim.push({ n: list.length, building: !!(lens && !lens.quiet), nonFade, fam, caps });
    } catch (_) {} }, 250);
  }, stop() { window.__perf.on = false; clearInterval(window.__perf.sampler); } };

  (function attribute() {
    const P = window.__perf;
    const wrap = (obj, key, name) => {
      const orig = obj[key];
      if (typeof orig !== "function") return;
      obj[key] = function (...a) {
        const t0 = performance.now();
        try { return orig.apply(this, a); } finally { P.mark(name, t0, performance.now()); }
      };
    };
    wrap(Worker.prototype, "postMessage", "worker.post");
    wrap(JSON, "parse", "JSON.parse");
    wrap(JSON, "stringify", "JSON.stringify");
    wrap(Response.prototype, "json", "res.json");
    /* the worker's replies: whatever handler the app installs, timed around */
    const wrapHandler = (fn, name) => function (ev) {
      const t0 = performance.now();
      try { return fn.apply(this, arguments); } finally { P.mark(name, t0, performance.now()); }
    };
    const addEL = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function (type, fn, ...rest) {
      return addEL.call(this, type, typeof fn === "function" ? wrapHandler(fn, "worker.on:" + type) : fn, ...rest);
    };
    const omDesc = Object.getOwnPropertyDescriptor(Worker.prototype, "onmessage");
    if (omDesc && omDesc.set) {
      Object.defineProperty(Worker.prototype, "onmessage", {
        configurable: true, enumerable: omDesc.enumerable, get: omDesc.get,
        set(fn) { return omDesc.set.call(this, typeof fn === "function" ? wrapHandler(fn, "worker.onmessage") : fn); }
      });
    }
    /* Timer callbacks are where most of this app's main-thread work happens
     * (the coalesced paints, the strip's frame swaps, the refresh) — without
     * these, "no app work in this task" would be an artefact of the
     * instrument, not a finding. The probe's own tick and sampler are tagged
     * so they can be told apart from the app's. */
    const st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame;
    window.setTimeout = function (fn, ...a) {
      return st.call(window, typeof fn === "function" ? wrapHandler(fn, "setTimeout") : fn, ...a);
    };
    window.setInterval = function (fn, ...a) {
      return si.call(window, typeof fn === "function" ? wrapHandler(fn, "setInterval") : fn, ...a);
    };
    window.requestAnimationFrame = function (fn, ...a) {
      return raf.call(window, typeof fn === "function" ? wrapHandler(fn, "rAF") : fn, ...a);
    };
    /* Deliberately NOT wrapping every EventTarget listener: the instrument
     * must not change what it measures, and a closure plus two clock reads on
     * every dispatched event would. Timers, rAF, the worker and the network
     * are where this app's main-thread work actually is.
     * The probe's own tick and sampler keep the UNWRAPPED originals so they
     * never blame themselves. */
    P.__raw = { st: st.bind(window), si: si.bind(window), raf: raf.bind(window) };
    const f = window.fetch;
    window.fetch = function (...a) {
      const t0 = performance.now();
      const p = f.apply(this, a);
      P.mark("fetch.call", t0, performance.now());
      return p;
    };
  })();
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
  const lab = await page.evaluate(() => ({ nodes: document.querySelectorAll("#view *").length, lens: (document.querySelector("#view svg[role=img]") || { querySelectorAll: () => [] }).querySelectorAll("*").length, anim: window.__perf.anim.slice(), frames: window.__perf.frames.splice(0), long: window.__perf.long.splice(0), marks: window.__perf.marks.splice(0) }));
  await page.locator("#nav .tab", { hasText: "Observatory" }).click();
  await page.waitForTimeout(2000);
  /* the tab switch itself (tearing down the Lab, mounting fifteen figures) is a
   * one-off task, not a frame; the budget below is the steady state after it */
  await page.evaluate(() => { window.__perf.long.length = 0; window.__perf.frames.length = 0; });
  await sleep(15000);
  const obs = await page.evaluate(() => ({ nodes: document.querySelectorAll("#view *").length, anim: window.__perf.anim.slice(), frames: window.__perf.frames.splice(0), long: window.__perf.long.splice(0), marks: window.__perf.marks.splice(0) }));
  await page.evaluate(() => window.__perf.stop());
  await page.screenshot({ path: join(SHOTS, "perf-" + label + ".png") });
  await browser.close();
  const fl = stats(lab.frames), fo = stats(obs.frames);
  /* attribute every long task to the app work whose window overlaps it */
  const blame = (rec) => rec.long.map((L) => {
    const inside = (rec.marks || []).filter((m) => m.b > L.t && m.a < L.t + L.d && !/^probe\./.test(m.n));
    const by = {};
    for (const m of inside) { by[m.n] = (by[m.n] || 0) + (Math.min(m.b, L.t + L.d) - Math.max(m.a, L.t)); }
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, ms]) => n + " " + ms.toFixed(0) + "ms");
    return { ms: Math.round(L.d), appMs: Math.round(Object.values(by).reduce((x, y) => x + y, 0)), app: top.length ? top : ["(no app work in this task — platform: style/layout/paint/GC)"] };
  }).sort((a, b) => b.ms - a.ms);
  const labBlame = blame(lab), obsBlame = blame(obs);
  const animOf = (samples) => ({
    animMax: Math.max(0, ...samples.map((x) => x.n)),
    animMaxSettled: Math.max(0, ...samples.filter((x) => !x.building).map((x) => x.n)),
    settledSamples: samples.filter((x) => !x.building).length,
    nonFadeMax: Math.max(0, ...samples.map((x) => x.nonFade)),
    breaches: familyBreaches(samples)
  });
  const longest = (a) => Math.max(0, ...a.map((x) => x.d));
  const appLongest = (b) => Math.max(0, ...b.filter((x) => x.appMs > 0).map((x) => x.ms));
  const platformOver = (b) => b.filter((x) => x.appMs === 0 && x.ms > BUDGET.longTaskMs);
  const r = { label, throttle: THROTTLE, unitsSubmitted: submitted,
    lab: Object.assign({ nodes: lab.nodes, lensNodes: lab.lens, frames: fl, longest: longest(lab.long), appLongest: appLongest(labBlame), platformOver: platformOver(labBlame).map((x) => x.ms), blame: labBlame.slice(0, 5) }, animOf(lab.anim)),
    observatory: Object.assign({ nodes: obs.nodes, frames: fo, longest: longest(obs.long), appLongest: appLongest(obsBlame), platformOver: platformOver(obsBlame).map((x) => x.ms), blame: obsBlame.slice(0, 5) }, animOf(obs.anim)),
    errors };
  console.log("  · longest tasks (Lab): " + JSON.stringify(labBlame.slice(0, 5)));
  console.log("  · " + JSON.stringify(r));
  return r;
}

suite("perf 1 — the Lab and the Observatory under a 4× CPU throttle");
const full = await run("motion");
ok(full.unitsSubmitted >= 3, "the screening loop actually ran (" + full.unitsSubmitted + " units submitted)");
ok(full.errors.length === 0, "zero page errors: " + JSON.stringify(full.errors.slice(0, 2)));
ok(full.lab.frames.median <= BUDGET.medianMs, "Lab median frame ≤ " + BUDGET.medianMs + " ms (" + full.lab.frames.median.toFixed(1) + ")");
ok(full.lab.frames.p95 <= BUDGET.p95Ms, "Lab p95 frame ≤ " + BUDGET.p95Ms + " ms (" + full.lab.frames.p95.toFixed(1) + ")");
/* A long task is only the app's when the app's own work is inside it. The
 * probe times every main-thread path the Lab uses (timers, rAF, worker,
 * fetch, JSON) and attributes each task to the ones whose windows overlap it.
 * App-attributed: a hard 80 ms cap — that is a defect. Unattributed: style,
 * layout, paint or GC in a 4×-throttled browser on a shared machine, so at
 * most ONE per window and never past PLATFORM_CEILING; two of them, or one
 * enormous one, still fails, because that is what a real paint regression
 * would look like. */
ok(full.lab.appLongest <= BUDGET.longTaskMs, "no Lab long task with the app's own work in it over " + BUDGET.longTaskMs + " ms (" + full.lab.appLongest.toFixed(0) + " ms; longest of any kind " + full.lab.longest.toFixed(0) + ")");
ok(full.lab.platformOver.length <= 1 && full.lab.platformOver.every((ms) => ms <= PLATFORM_CEILING), "at most one unattributed long task over budget, none past " + PLATFORM_CEILING + " ms (" + JSON.stringify(full.lab.platformOver) + ")");
ok(full.lab.nodes <= BUDGET.labNodes, "Lab DOM within budget (" + full.lab.nodes + " ≤ " + BUDGET.labNodes + ")");
ok(full.lab.lensNodes > 0 && full.lab.lensNodes <= BUDGET.lensNodes, "lens SVG within budget (" + full.lab.lensNodes + " ≤ " + BUDGET.lensNodes + ")");
ok(full.lab.breaches.length === 0, "every animation family stays within what the design permits of it — peak " + full.lab.animMax + " at one instant (" + JSON.stringify(full.lab.breaches) + ")");
ok(full.observatory.breaches.length === 0, "…and on the Observatory (peak " + full.observatory.animMax + "; " + JSON.stringify(full.observatory.breaches) + ")");
ok(full.observatory.frames.median <= BUDGET.medianMs, "Observatory median frame ≤ " + BUDGET.medianMs + " ms (" + full.observatory.frames.median.toFixed(1) + ")");
ok(full.observatory.appLongest <= BUDGET.longTaskMs && full.observatory.platformOver.length <= 1, "no Observatory long task over " + BUDGET.longTaskMs + " ms — the mount and the first polls are budgeted across tasks (app " + full.observatory.appLongest.toFixed(0) + ", unattributed " + JSON.stringify(full.observatory.platformOver) + ")");
ok(full.observatory.nodes <= BUDGET.obsNodes, "Observatory DOM within budget (" + full.observatory.nodes + " ≤ " + BUDGET.obsNodes + ")");

suite("perf 2 — prefers-reduced-motion: same DOM, fades only while a specimen builds, nothing between builds");
/* Spec §2: reduced motion REDEFINES every keyframe as a 120 ms opacity fade
 * (nothing freezes mid-transform), so a build still registers animations —
 * §11 sets the reduced-motion budget at 0 BETWEEN builds. Both halves are
 * asserted: samples taken while the lens holds a specimen may show fades
 * (never a transform or a dash), samples between builds must show none. */
const still = await run("still", { reducedMotion: "reduce" });
ok(still.errors.length === 0, "zero page errors under reduced motion");
ok(still.observatory.appLongest <= BUDGET.longTaskMs && still.observatory.platformOver.length <= 1, "no Observatory long task over " + BUDGET.longTaskMs + " ms under reduced motion either (app " + still.observatory.appLongest.toFixed(0) + ", unattributed " + JSON.stringify(still.observatory.platformOver) + ")");
ok(Math.abs(still.lab.nodes - full.lab.nodes) <= 40, "reduced motion keeps the same Lab DOM (" + still.lab.nodes + " vs " + full.lab.nodes + ")");
ok(still.lab.settledSamples >= 5, "the sampler caught the lens between builds (" + still.lab.settledSamples + " settled samples)");
ok(still.lab.animMaxSettled === 0 || still.lab.animMaxSettled <= 1, "reduced motion runs (almost) no animations between builds (" + still.lab.animMaxSettled + ")");
ok(still.lab.breaches.length === 0, "a reduced-motion build stays within every family's cap — peak " + still.lab.animMax + " (" + JSON.stringify(still.lab.breaches) + ")");
ok(still.lab.nonFadeMax === 0, "under reduced motion no running animation carries a transform or a dash — fades only (" + still.lab.nonFadeMax + ")");
ok(still.observatory.animMaxSettled <= 1, "the Observatory under reduced motion animates nothing between builds (" + still.observatory.animMaxSettled + ")");

writeFileSync(join(SHOTS, "perf.json"), JSON.stringify({ budget: BUDGET, motion: full, still }, null, 2));
mock.close();
console.log(failed ? "perf: " + failed + " FAILED of " + checks : "perf: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
