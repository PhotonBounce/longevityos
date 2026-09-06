/* e2e — the atlas in a real browser. Serves app/ + data/ over http, drives it
 * with Playwright, and screenshots the proof to qa/shots/. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
let serveFeed = false;
const server = createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/app/data/feed.json") p = "/data/feed.json";   // FEED_URL is app-relative
  if (p === "/data/feed.json" && !serveFeed) { res.writeHead(404); res.end(); return; }
  const file = p === "/data/feed.json" ? join(HERE, "fixtures", "feed.json") : join(ROOT, p);
  if (!file.startsWith(ROOT) && !file.startsWith(HERE)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined
});
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const src = (m.location() && m.location().url) || "";
  // the missing-feed 404 is the fallback path under test, the missing swarm API
  // is the no-server degradation under test, and a favicon 404 is browser noise
  if (/\/data\/feed\.json$|\/favicon\.ico$|\/api\//.test(src)) return;
  if (/Failed to load resource/.test(m.text()) && /\/api\//.test(src)) return;
  pageErrors.push(m.text() + " @ " + src);
});

/* ————— 1. boot ————— */
suite("e2e 1 — boot");
await page.goto(BASE + "/app/index.html");
await page.waitForSelector(".card");
ok(await page.locator(".banner-headline").isVisible(), "the honesty headline is the first thing on screen");
ok(/No drug has ever been shown to extend human lifespan/.test(await page.locator(".banner-headline").textContent()),
  "and it says what it must");
const cardCount = await page.locator(".card").count();
ok(cardCount >= 12, "the atlas renders its corpus (" + cardCount + " cards)");
await page.screenshot({ path: join(SHOTS, "01-atlas.png"), fullPage: true });

/* ————— 2. filters + search ————— */
suite("e2e 2 — filters and search");
await page.locator(".chip", { hasText: "ITP-tested" }).click();
const itpCount = await page.locator(".card").count();
ok(itpCount > 0 && itpCount < cardCount, "ITP filter narrows the grid (" + itpCount + ")");
await page.locator(".chip", { hasText: "Has a rigorous null" }).click();
const nullCount = await page.locator(".card").count();
ok(nullCount >= 5, "the failures are findable as a group (" + nullCount + ")");
await page.locator(".chip", { hasText: "All" }).click();
await page.locator(".search").fill("senolytic");
const senoCount = await page.locator(".card").count();
ok(senoCount >= 2, "search 'senolytic' finds the senolytics (" + senoCount + ")");
await page.locator(".search").fill("");

/* ————— 3. a dossier shows its null ————— */
suite("e2e 3 — fisetin's failure is on its card and in its dossier");
ok(await page.locator('.card[data-id="fisetin"] .tag-null').isVisible(), "the card wears its null tag");
await page.locator('.card[data-id="fisetin"]').click();
await page.waitForSelector(".ev-null");
ok(await page.locator(".ev-nulltag").first().isVisible(), "the dossier shows NULL / CONTRARY");
ok(/did not significantly affect lifespan/.test(await page.locator(".ev-null").textContent()),
  "the ITP null is quoted, not paraphrased away");
ok(/not medical advice/i.test(await page.locator(".disclaimer").textContent()), "the dossier ends with the disclaimer");
await page.screenshot({ path: join(SHOTS, "02-dossier-fisetin.png"), fullPage: true });
await page.locator(".back").click();

/* ————— 4. the ladder admits its empty top rung ————— */
suite("e2e 4 — the ladder");
await page.locator('[data-tab="ladder"]').click();
await page.waitForSelector(".ladder-row");
ok(/No compound has ever earned this rung/.test(await page.locator(".ladder-row").first().textContent()),
  "the top rung says it is empty");
await page.screenshot({ path: join(SHOTS, "03-ladder.png"), fullPage: true });

/* ————— 4b. the Lab renders, and survives having no server ————— */
suite("e2e 4b — the Lab");
await page.locator('[data-tab="lab"]').click();
await page.waitForSelector(".lab-banner, .lab-offline, .lab", { timeout: 15000 });
const labText = await page.locator("#view").textContent();
ok(/hypothes/i.test(labText), "the Lab states its output is hypotheses");
ok(/not (a )?(discover|drug|medical)|shortlist/i.test(labText),
   "the Lab says plainly what a hit is not");
ok(/donate|contribute/i.test(labText), "the Lab offers to use the visitor's browser");
/* this page is served with NO swarm API behind it — the honest outcome is a
 * panel saying so, never a broken tab */
await page.waitForTimeout(1500);
const stillAlive = await page.locator("#nav").isVisible();
ok(stillAlive, "with no swarm server reachable, the app is still fully usable");
await page.screenshot({ path: join(SHOTS, "07-lab.png"), fullPage: true });
await page.locator('[data-tab="atlas"]').click();
await page.waitForSelector(".card");
ok((await page.locator(".card").count()) >= 12, "returning to the Atlas still works");

/* ————— 5. the feed is honest with and without a live sweep ————— */
suite("e2e 5 — fresh findings");
await page.locator('[data-tab="feed"]').click();
await page.waitForSelector(".feed-status");
ok(/not a live feed/.test(await page.locator(".feed-status").textContent()),
  "without feed.json the app says it is showing its bundled library");
serveFeed = true;
await page.reload();
await page.waitForSelector(".card");
await page.locator('[data-tab="feed"]').click();
await page.waitForFunction(() => document.querySelector(".feed-status") &&
  /Live literature sweep/.test(document.querySelector(".feed-status").textContent));
ok(true, "with feed.json served, the live sweep renders with its freshness");
const feedLinks = await page.locator(".feed-row .feed-title").count();
ok(feedLinks >= 3, "sweep entries render (" + feedLinks + ")");
await page.screenshot({ path: join(SHOTS, "04-feed.png"), fullPage: true });

/* ————— 6. sources ————— */
suite("e2e 6 — sources");
await page.locator('[data-tab="sources"]').click();
await page.waitForSelector(".src-row");
const srcCount = await page.locator(".src-cite").count();
ok(srcCount >= 25, "every citation is listed (" + srcCount + ")");
await page.screenshot({ path: join(SHOTS, "05-sources.png"), fullPage: true });

/* ————— 7. zero errors ————— */
suite("e2e 7 — zero page errors");
ok(pageErrors.length === 0, "no console/page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "e2e: " + failed + " FAILED of " + checks : "e2e: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
