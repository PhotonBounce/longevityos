/* a11y — readability outranks mood, on every surface (the Eternal Lights rule).
 *
 * The Observatory theme paints many surfaces (wells, panels, bezels, LED
 * faces). This suite renders the Atlas, the Lab and the Observatory on a
 * phone viewport against a mock swarm and, for every visible text node,
 * computes the WCAG contrast of its colour against the first opaque
 * background behind it: body text (< 18px) must reach 7:1, labels and small
 * caps 4.5:1. It also asserts the text twins the design promises: every LED
 * has one, every image-role SVG has a title, every button has a name, touch
 * targets are ≥ 44 px, no autoplay attribute exists, and reduced motion
 * leaves nothing animating. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium, devices } from "playwright";
import { TARGETS, targetsDigest, ENGINE_VERSION } from "../app/js/chem/targets.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
mkdirSync(join(HERE, "shots"), { recursive: true });
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } else console.log("  ✓ " + msg); };
const suite = (name) => console.log("── " + name + " ──");

const mock = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const out = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (!u.pathname.startsWith("/mock-api/")) {
    let p = u.pathname; if (p === "/" || p === "/app/") p = "/app/index.html";
    if (p === "/app/data/feed.json") p = "/data/feed.json";
    const file = p === "/data/feed.json" ? join(HERE, "fixtures", "feed.json") : join(ROOT, p);
    if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
    const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file)); return;
  }
  const a = u.searchParams.get("a");
  const smiles = TARGETS.flatMap((t) => t.actives.map((x) => x.smiles));
  if (a === "health") return out({ ok: true, engine: ENGINE_VERSION, targets_digest: targetsDigest(), molecules: 1044, screened: 400, verified: 360, contributors: 4, ingest_armed: true, bandwidth: { today_bytes: 5e8, budget_bytes: 2e9, quiet: false } });
  if (a === "stats") return out({ totals: { harvested: 1044, screened: 400, verified: 360, contributors: 4, units_open: 3, pending: 600, issued: 40, conflict: 4, active_1h: 2 }, leaderboard: [{ name: "alpha", units: 5, credits: 50 }, { name: "beta", units: 4, credits: 40 }], teams: [{ code: "ABCDEFGH", name: "team a", members: 2, units: 9, credits: 90 }], quiet: false, units: { open: 3, confirmed: 9, conflict: 1, stale: 0 }, canary: { ok: 8, bad: 1 }, spectrum: [3, 5, 8, 13, 21, 13, 8, 5, 3, 1], targets: TARGETS.slice(0, 6).map((t, i) => ({ id: t.id, count: 6 - i })), witnesses: [7, 2, 1], clocks: { harvest: 1700000000, verified: 1700000000, issued: 1700000000 } });
  if (a === "hits") return out({ hits: smiles.slice(0, 12).map((s, i) => ({ cid: String(2000 + i), smiles: s, score: 880 - i * 30, best_target: TARGETS[i % TARGETS.length].id, formula: "C9H8O4", flags: i % 3 ? [] : ["mw"], verified_by: 2 + (i % 3) })) });
  if (a === "history") { const n = 48; return out({ hour: Array.from({ length: n }, (_, i) => 1700000000 + i * 3600), harvested: Array.from({ length: n }, (_, i) => 1000 + i), screened: Array.from({ length: n }, (_, i) => i * 7), verified: Array.from({ length: n }, (_, i) => i * 5), contributors: Array.from({ length: n }, () => 4), active: Array.from({ length: n }, (_, i) => i % 3), units_open: Array.from({ length: n }, () => 3), units_confirmed: Array.from({ length: n }, (_, i) => i), conflicts: Array.from({ length: n }, () => 0), results: Array.from({ length: n }, (_, i) => i * 2), bandwidth: { days: Array.from({ length: 14 }, (_, i) => ({ day: "2026-09-" + String(i + 1).padStart(2, "0"), bytes: i * 1e7 })) } }); }
  if (a === "me") return out({ contributor: { id: 1, name: "alpha", units: 5, credits: 50, created_at: 1700000000, team: null } });
  if (a === "join") return out({ token: "t".repeat(32), contributor: 1, name: "alpha" });
  if (a === "work") return out({ idle: true, message: "no work in the mock" });
  return out({ error: "unknown_action" }, 404);
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + mock.address().port;

/* WCAG relative luminance + contrast, computed in the page against the first opaque ancestor background */
const AUDIT = `
(() => {
  const lum = (r, g, b) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const parse = (s) => { const m = String(s).match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(",").map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const bgOf = (el) => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a >= 0.99) return c; e = e.parentElement; } return { r: 12, g: 17, b: 22, a: 1 }; };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const rows = []; let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim(); if (t.length < 2) continue;
    const el = n.parentElement; if (!el) continue;
    const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.5) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (el.closest("[aria-hidden=true], svg")) continue;
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg.r, fg.g, fg.b), L2 = lum(bg.r, bg.g, bg.b);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 600;
    const large = px >= 24 || (px >= 18.66 && bold);
    rows.push({ text: t.slice(0, 40), px, ratio: Math.round(ratio * 10) / 10, need: large ? 4.5 : (px < 12 ? 4.5 : 7), cls: el.className && el.className.baseVal === undefined ? String(el.className).slice(0, 40) : "" });
  }
  return rows;
})()`;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
async function audit(tab, reduced) {
  const ctx = await browser.newContext(Object.assign({}, devices["Pixel 5"], reduced ? { reducedMotion: "reduce" } : {}));
  await ctx.addInitScript((api) => { window.__LOS_API = api; }, BASE + "/mock-api/");
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/app/index.html"); await page.waitForSelector(".card");
  if (tab !== "Atlas") { await page.locator("#nav .tab", { hasText: tab }).click(); await page.waitForTimeout(2200); }
  const rows = await page.evaluate(AUDIT);
  const bad = rows.filter((r) => r.ratio < r.need);
  const leds = await page.$$eval("svg.led", (els) => els.map((s) => ({ twin: !!(s.nextElementSibling && s.nextElementSibling.classList.contains("led-text")), same: s.nextElementSibling ? s.nextElementSibling.textContent.trim().length > 0 : false })));
  const imgs = await page.$$eval("svg[role=img]", (els) => els.map((s) => !!s.querySelector("title")));
  /* every interactive target, not only <button>: a <summary> is a control too (the Observatory's fifteen "Read the numbers") */
  const buttons = await page.$$eval("button, summary, [role=button], a.btn", (els) => els.filter((b) => b.offsetParent !== null).map((b) => { const r = b.getBoundingClientRect(); return { name: (b.getAttribute("aria-label") || b.textContent || b.getAttribute("name") || "").trim(), h: r.height, w: r.width, tag: b.tagName.toLowerCase() }; }));
  const autoplay = await page.$$eval("[autoplay]", (els) => els.length);
  const anims = await page.evaluate(() => document.getAnimations().length);
  const closed = await page.$$eval("#view figure details", (els) => els.filter((d) => !d.open).length);
  await page.screenshot({ path: join(HERE, "shots", "a11y-" + tab.toLowerCase().replace(/\s+/g, "-") + (reduced ? "-still" : "") + ".png"), fullPage: false });
  await ctx.close();
  return { rows, bad, leds, imgs, buttons, autoplay, anims, closed, errors };
}

for (const tab of ["Atlas", "What has evidence", "The Lab", "Observatory"]) {
  suite("a11y — " + tab);
  const r = await audit(tab, false);
  ok(r.errors.length === 0, "zero page errors");
  ok(r.rows.length >= 20, "text audited (" + r.rows.length + " nodes)");
  ok(r.bad.length === 0, "every text node clears its contrast target (" + r.bad.length + " below): " + JSON.stringify(r.bad.slice(0, 4)));
  ok(r.leds.every((l) => l.twin && l.same), "every LED has a visible text twin (" + r.leds.length + " LEDs)");
  ok(r.imgs.every(Boolean), "every image-role SVG carries a <title> (" + r.imgs.length + ")");
  ok(r.buttons.every((b) => b.name.length > 0), "every visible control has a name (" + r.buttons.length + " controls)");
  const small = r.buttons.filter((b) => b.h < 44 || b.w < 44);
  ok(small.length === 0, "touch targets ≥ 44 px (" + small.length + " small): " + JSON.stringify(small.slice(0, 3).map((b) => b.tag + ":" + b.name)));
  if (tab === "Observatory") {
    const sums = r.buttons.filter((b) => b.tag === "summary");
    ok(sums.length === 15 && sums.every((b) => b.h >= 44), "the fifteen 'Read the numbers' controls are each ≥ 44 px tall (" + sums.length + ", min " + Math.min(...sums.map((b) => b.h)).toFixed(0) + ")");
  }
  ok(r.autoplay === 0, "no autoplay attribute anywhere");
  if (tab === "Observatory") ok(r.closed === 0, "no 'Read the numbers' table is closed");
}
suite("a11y — reduced motion leaves nothing animating");
const still = await audit("The Lab", true);
ok(still.anims === 0, "document.getAnimations() is empty on the Lab under reduced motion (" + still.anims + ")");
await browser.close(); mock.close();
console.log(failed ? "a11y: " + failed + " FAILED of " + checks : "a11y: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
