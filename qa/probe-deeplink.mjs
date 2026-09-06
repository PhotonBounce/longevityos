/* probe-deeplink — hostile shared links and hostile public records.
 *
 * 3.0 added two ways into the Lab from a URL somebody else wrote (?c=<id>,
 * ?team=<code>) and two public read endpoints whose payloads are typed by
 * strangers (contributor names, team names). This probe drives both with the
 * nastiest values it can think of and asserts three things: an invalid id or
 * code never becomes an API request; nothing typed by a stranger ever renders
 * as markup; and the page never throws. The mock API is deliberately hostile
 * — it answers every valid lookup with names built to break a renderer. */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

const HOSTILE_NAME = "<img src=x onerror=\"document.body.dataset.pwned='1'\"><script>window.__pwned=1</script>‮evil​" + "A".repeat(5000);
const requests = [];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/")) {
    const a = u.searchParams.get("a");
    requests.push({ a, id: u.searchParams.get("id"), code: u.searchParams.get("code") });
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (a === "health") return json(200, { ok: true, engine: "los-chem-2", targets_digest: "", molecules: 0, screened: 0, verified: 0, contributors: 1, ingest_armed: false });
    if (a === "stats") return json(200, { totals: { harvested: 1, screened: 1, verified: 1, contributors: 1, units_open: 0 }, leaderboard: [{ name: HOSTILE_NAME, units: 1, credits: 10 }], teams: [{ code: "ABCDEFGH", name: HOSTILE_NAME, members: 1, units: 1, credits: 10 }] });
    if (a === "hits") return json(200, { hits: [] });
    if (a === "contributor") {
      const id = u.searchParams.get("id");
      if (!/^[1-9][0-9]{0,11}$/.test(id || "")) return json(400, { error: "bad_id" });
      return json(200, { contributor: { id: Number(id), name: HOSTILE_NAME, units: 12, credits: 120, created_at: 1700000000, rank: 1, team: { code: "ABCDEFGH", name: HOSTILE_NAME } } });
    }
    if (a === "team") {
      const code = u.searchParams.get("code");
      if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code || "")) return json(400, { error: "bad_code" });
      return json(200, { team: { code, name: HOSTILE_NAME, members: 1, units: 1, credits: 10, created_at: 1700000000 }, board: [{ name: HOSTILE_NAME, units: 1, credits: 10 }] });
    }
    return json(404, { error: "unknown_action" });
  }
  let p = u.pathname;
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/app/data/feed.json") { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addInitScript((api) => { window.__LOS_API = api; }, BASE + "/api/");
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/feed\.json|favicon|\/api\//.test(m.text() + ((m.location() || {}).url || ""))) pageErrors.push(m.text()); });

async function visit(query) {
  requests.length = 0;
  await page.goto(BASE + "/app/index.html" + query);
  await page.waitForSelector("#view");
  await page.waitForTimeout(700);
  const tab = await page.evaluate(() => window.__los && window.__los.state.tab);
  const markup = await page.evaluate(() => ({
    imgs: document.querySelectorAll("#view img").length,
    scripts: document.querySelectorAll("#view script").length,
    pwned: document.body.dataset.pwned || null,
    winPwned: window.__pwned || null,
    text: document.querySelector("#view").textContent
  }));
  return { tab, markup, requests: requests.slice() };
}

/* ————— 1. hostile ?c= values never become a request ————— */
suite("probe-deeplink 1 — hostile contributor ids");
const badIds = ["", "0", "-1", "1e3", "007", "1234567890123", "%3Cscript%3E", "1;DROP", "..%2F..%2F", "javascript:alert(1)", "1%00", "NaN", "1.0", "+1", " 1"];
for (const v of badIds) {
  const r = await visit("?c=" + v);
  ok(r.tab === "lab", "?c=" + JSON.stringify(v) + " opens the Lab");
  ok(!r.requests.some((q) => q.a === "contributor"), "?c=" + JSON.stringify(v) + " never asks the API for a record");
  ok(r.markup.imgs === 0 && r.markup.scripts === 0 && !r.markup.pwned && !r.markup.winPwned, "?c=" + JSON.stringify(v) + " renders no markup");
}

/* ————— 2. a valid id fetches once and renders the hostile name as text ————— */
suite("probe-deeplink 2 — a hostile public record renders as text");
const good = await visit("?c=42");
const contribReqs = good.requests.filter((q) => q.a === "contributor");
ok(contribReqs.length === 1 && contribReqs[0].id === "42", "exactly one record request, for id 42 (" + JSON.stringify(contribReqs) + ")");
ok(good.markup.imgs === 0 && good.markup.scripts === 0 && !good.markup.pwned && !good.markup.winPwned, "the hostile name produced no elements");
ok(!good.markup.text.includes("A".repeat(200)), "a 5 KB name is truncated on screen");
ok(!/‮|​/.test(good.markup.text), "bidi and zero-width characters are stripped from what renders");

/* ————— 3. hostile ?team= codes ————— */
suite("probe-deeplink 3 — hostile team codes");
const badCodes = ["", "ABCD-123", "IIIIIIII", "ABCDEFGHI", "abc", "%3Cb%3EXYZ12", "ABCDEFG1;", "OOOOOOOO", "ABCDEFG%00", "ABCDEFGH%20"];
for (const v of badCodes) {
  const r = await visit("?team=" + v);
  ok(r.tab === "lab", "?team=" + JSON.stringify(v) + " opens the Lab");
  ok(!r.requests.some((q) => q.a === "team"), "?team=" + JSON.stringify(v) + " never asks the API for a team");
  ok(r.markup.imgs === 0 && r.markup.scripts === 0 && !r.markup.pwned, "?team=" + JSON.stringify(v) + " renders no markup");
}
const goodTeam = await visit("?team=abcdefgh");
const teamReqs = goodTeam.requests.filter((q) => q.a === "team");
ok(teamReqs.length >= 1 && teamReqs.every((q) => q.code === "ABCDEFGH"), "a lower-case valid code is upper-cased before it is looked up (" + JSON.stringify(teamReqs) + ")");
ok(goodTeam.markup.imgs === 0 && goodTeam.markup.scripts === 0 && !goodTeam.markup.pwned, "the hostile team name produced no elements");

/* ————— 4. hostile boards ————— */
suite("probe-deeplink 4 — hostile leaderboard and teams board");
const plain = await visit("");
await page.locator("#nav .tab", { hasText: "The Lab" }).click();
await page.waitForTimeout(900);
const boards = await page.evaluate(() => ({ imgs: document.querySelectorAll("#view img").length, scripts: document.querySelectorAll("#view script").length, pwned: document.body.dataset.pwned || null }));
ok(plain.tab === "atlas", "no deep link → the atlas opens as before");
ok(boards.imgs === 0 && boards.scripts === 0 && !boards.pwned, "hostile names on the leaderboard and teams board render as text");

suite("probe-deeplink 5 — zero page errors");
ok(pageErrors.length === 0, "no page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close(); server.close();
console.log(failed ? "probe-deeplink: " + failed + " FAILED of " + checks : "probe-deeplink: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
