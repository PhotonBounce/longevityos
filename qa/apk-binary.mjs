/* apk-binary — the mechanical meaning of "tested APK": unzip the REAL signed
 * binary, serve its own bytes at the appassets-equivalent path, cut every
 * off-origin request, and drive the atlas end-to-end. Runs inside
 * build-apk.yml against the SIGNED artifact before any publish step.
 *
 *   node qa/apk-binary.mjs path/to/longevityos.apk
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { chromium } from "playwright";

const apk = process.argv[2];
if (!apk || !existsSync(apk)) { console.error("usage: node qa/apk-binary.mjs <signed.apk>"); process.exit(1); }

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };

/* 1. the binary is a real zip and carries the app */
const magic = readFileSync(apk).subarray(0, 2).toString("latin1");
ok(magic === "PK", "APK has zip magic");
const dir = mkdtempSync(join(tmpdir(), "los-apk-"));
execFileSync("unzip", ["-q", apk, "assets/www/*", "-d", dir]);
ok(existsSync(join(dir, "assets", "www", "index.html")), "bundle carries assets/www/index.html");
for (const m of ["data", "grades", "feed", "app"]) {
  ok(existsSync(join(dir, "assets", "www", "js", m + ".js")), "bundle carries js/" + m + ".js");
}

/* 2. serve the APK's OWN bytes; everything off-origin is cut */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
  const p = join(dir, req.url.split("?")[0]);
  if (!p.startsWith(dir) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.hostname !== "127.0.0.1") return route.abort(); // the network is cut
  return route.continue();
});

/* 3. drive it */
await page.goto(BASE + "/assets/www/index.html");
await page.waitForSelector(".card", { timeout: 15000 });
ok((await page.locator(".card").count()) >= 12, "the atlas boots from the binary's own bytes");
ok(/No drug has ever been shown to extend human lifespan/.test(await page.locator(".banner-headline").textContent()),
  "the honesty headline survived packaging");
await page.locator('[data-tab="feed"]').click();
await page.waitForSelector(".feed-status");
ok(/not a live feed/.test(await page.locator(".feed-status").textContent()),
  "offline, the feed honestly shows its bundled library (no fabricated sweep)");
await page.locator('[data-tab="atlas"]').click();
await page.locator('.card[data-id="fisetin"]').click();
await page.waitForSelector(".ev-null");
ok(await page.locator(".ev-nulltag").first().isVisible(), "the ITP null renders inside the binary");
ok(pageErrors.length === 0, "zero page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "apk-binary: " + failed + " FAILED of " + checks : "apk-binary: " + checks + " checks passed ✓ — the signed binary itself has been driven");
process.exit(failed ? 1 : 0);
