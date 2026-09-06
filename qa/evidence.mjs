/* evidence — the "What has evidence" ledger in a real browser. Boots the app
 * over http (no feed, no swarm API — the honest degraded state), opens the tab
 * and checks the ledger renders its corpus honestly: every card, E3 first,
 * every null and harm badged, every cite a PubMed / CT.gov link opened with
 * noopener, filter chips that actually filter, zero page errors — at desktop
 * and phone widths, with screenshots to qa/shots/evidence-*.png. */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";
import { HUMAN_EVIDENCE, EVIDENCE_RUNGS, strongestHuman, hasHumanNull } from "../app/js/evidence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/data/feed.json") { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const pageErrors = [];
async function boot(viewport) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const src = (m.location() && m.location().url) || "";
    if (/\/data\/feed\.json$|\/favicon\.ico$|\/api\//.test(src)) return;
    pageErrors.push(m.text() + " @ " + src);
  });
  await page.goto(BASE + "/app/index.html");
  await page.waitForSelector(".card");
  await page.locator('[data-tab="evidence"]').click();
  await page.waitForSelector(".ev-card");
  return page;
}

/* what the corpus itself says the page must show */
const ORDER = EVIDENCE_RUNGS.map((r) => r.key);
const expectNull = HUMAN_EVIDENCE.filter(hasHumanNull).length;
const expectNullRows = HUMAN_EVIDENCE.flatMap((it) => it.rows).filter((r) => r.outcome === "null" || r.outcome === "harm").length;
const expectRct = HUMAN_EVIDENCE.filter((it) => ["E3", "E2"].includes(strongestHuman(it))).length;
const expectObs = HUMAN_EVIDENCE.filter((it) => strongestHuman(it) === "E1").length;
const expectMedical = HUMAN_EVIDENCE.filter((it) => it.kind === "medical").length;

/* ————— 1. the tab boots and says what it is ————— */
suite("evidence 1 — boot");
const page = await boot({ width: 1280, height: 900 });
ok((await page.locator('[data-tab="evidence"]').textContent()) === "What has evidence", "the tab is named 'What has evidence'");
const tabs = await page.locator("#nav .tab").allTextContents();
ok(tabs[0] === "Atlas" && tabs[1] === "What has evidence" && tabs[2] === "The Lab", "tab order: Atlas, What has evidence, The Lab, … (" + tabs.join(" · ") + ")");
const headline = await page.locator(".ev-banner .banner-headline").textContent();
ok(/not medical advice/.test(headline), "the headline says it is not medical advice");
ok(/did nothing/.test(headline) && /harm/.test(headline), "the headline promises the nulls and the harms");
ok(/not medical advice/i.test(await page.locator(".ev-disclaimer").textContent()), "the atlas disclaimer is on the page");
ok(/people like those in the trial/.test(await page.locator(".ev-note").textContent()), "the note frames results as 'people like those in the trial'");
const cards = await page.locator(".ev-card").count();
ok(cards >= 18, "the ledger renders at least 18 cards (" + cards + ")");
ok(cards === HUMAN_EVIDENCE.length, "every corpus item renders exactly once (" + cards + "/" + HUMAN_EVIDENCE.length + ")");
const footer = await page.locator(".ev-footer").textContent();
ok(/Nothing on this page is advice/.test(footer) && /trial population/i.test(footer),
  "the footer repeats that nothing is advice and that the trial population defines the result");

/* ————— 2. rung badges, E3 first ————— */
suite("evidence 2 — the ledger is sorted by rung, E3 first");
const rungs = await page.$$eval(".ev-card .ev-rung", (els) => els.map((e) => ({ key: e.getAttribute("data-rung"), text: e.textContent })));
ok(rungs.length === cards, "every card wears exactly one rung badge (" + rungs.length + ")");
ok(rungs.every((r) => ORDER.includes(r.key) && r.text.length > 8), "every badge is a known rung with a label");
ok(rungs[0].key === "E3" && /fewer deaths/.test(rungs[0].text), "the first card is E3 — randomised, fewer deaths");
let sorted = true;
for (let i = 1; i < rungs.length; i++) if (ORDER.indexOf(rungs[i].key) < ORDER.indexOf(rungs[i - 1].key)) sorted = false;
ok(sorted, "rungs never rise down the page: " + rungs.map((r) => r.key).join(" "));
ok(rungs.some((r) => r.key === "E0") && /null or harm/i.test(rungs[rungs.length - 1].text), "the last card is a rigorous null or harm");
ok((await page.locator(".ev-who-label").count()) === cards, "every card says who was studied");
ok((await page.locator(".ev-card .caveat").count()) === cards, "every card carries its caveat");

/* ————— 3. the nulls and harms are badged ————— */
suite("evidence 3 — nulls and harms wear their badge");
const nullTags = await page.locator(".ev-nulltag").allTextContents();
ok(nullTags.length >= 7, "at least 7 NULL / HARM badges (" + nullTags.length + ")");
ok(nullTags.length === expectNullRows, "one badge per null/harm row in the corpus (" + nullTags.length + "/" + expectNullRows + ")");
ok(nullTags.every((t) => t === "NULL / HARM"), "the badge reads exactly 'NULL / HARM'");
ok((await page.locator(".ev-row.ev-null").count()) === expectNullRows, "every null/harm row carries the ev-null class");
ok((await page.locator(".ev-card .tag-null").count()) === expectNull, "every item with a null or harm wears the card tag (" + expectNull + ")");
ok(/did not significantly reduce all-cause mortality/.test(await page.locator('.ev-card[data-id="exercise"]').textContent()),
  "exercise: the randomised null sits on the same card as the cohort gradient");
ok(/higher with aspirin/.test(await page.locator('.ev-card[data-id="aspirinelderly"]').textContent()),
  "aspirin: the harm is quoted, not softened");

/* ————— 4. every cite is a primary-source link opened safely ————— */
suite("evidence 4 — citations");
const cites = await page.$$eval(".ev-cite", (as) => as.map((a) => ({ href: a.getAttribute("href"), rel: a.rel, target: a.target, text: a.textContent })));
const expectRows = HUMAN_EVIDENCE.reduce((n, it) => n + it.rows.length, 0);
ok(cites.length === expectRows, "one cite link per row (" + cites.length + "/" + expectRows + ")");
ok(cites.every((c) => /noopener/.test(c.rel)), "every cite opens with rel=noopener");
ok(cites.every((c) => c.target === "_blank"), "every cite opens in a new tab");
ok(cites.every((c) => /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(c.href) || /^https:\/\/clinicaltrials\.gov\/study\/NCT\d+$/.test(c.href)),
  "every cite href is an https PubMed record or CT.gov study");
ok(cites.every((c) => c.text.length > 8), "every cite has visible citation text");
const effects = await page.locator(".ev-effect").allTextContents();
ok(effects.length === expectRows && effects.every((e) => e.trim().length > 0), "every row prints its effect as reported");

/* ————— 5. the filter chips filter ————— */
suite("evidence 5 — filters");
const count = () => page.locator(".ev-card").count();
await page.locator('.ev-controls .chip[data-filter="null"]').click();
const nullCount = await count();
ok(nullCount === expectNull && nullCount < cards, "'Nulls & harms' shows exactly the items with a null or harm (" + nullCount + ")");
await page.screenshot({ path: join(SHOTS, "evidence-nulls.png"), fullPage: true });
await page.locator('.ev-controls .chip[data-filter="rct"]').click();
const rctCount = await count();
ok(rctCount === expectRct && rctCount < cards, "'Randomised trials' shows the E3 + E2 items (" + rctCount + ")");
ok((await page.$$eval(".ev-card .ev-rung", (els) => els.every((e) => /^E[23]$/.test(e.getAttribute("data-rung"))))),
  "and every visible badge is E3 or E2");
await page.locator('.ev-controls .chip[data-filter="obs"]').click();
const obsCount = await count();
ok(obsCount === expectObs && obsCount < cards, "'Observational' shows the E1 items (" + obsCount + ")");
await page.locator('.ev-controls .chip[data-filter="kind:medical"]').click();
const medCount = await count();
ok(medCount === expectMedical && medCount < cards, "the 'medical' kind chip shows the medical items (" + medCount + ")");
await page.locator('.ev-controls .chip[data-filter="all"]').click();
ok((await count()) === cards, "'All' restores the full ledger");
ok(await page.locator('.ev-controls .chip[data-filter="all"]').evaluate((b) => b.classList.contains("chip-on")), "the active chip is marked");

/* ————— 6. screenshots, desktop and phone ————— */
suite("evidence 6 — proof at two widths");
await page.screenshot({ path: join(SHOTS, "evidence-desktop.png"), fullPage: true });
ok(existsSync(join(SHOTS, "evidence-desktop.png")), "desktop screenshot saved");
const phone = await boot({ width: 390, height: 844 });
ok((await phone.locator(".ev-card").count()) === cards, "the phone renders every card");
const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok(overflow <= 1, "no horizontal overflow on a 390px phone (" + overflow + "px)");
ok(await phone.locator(".ev-card").first().locator(".ev-rung").isVisible(), "the rung badge is visible on the phone");
await phone.screenshot({ path: join(SHOTS, "evidence-phone.png"), fullPage: true });
ok(existsSync(join(SHOTS, "evidence-phone.png")), "phone screenshot saved");

/* ————— 7. the atlas is untouched ————— */
suite("evidence 7 — the rest of the app still works");
await page.locator('[data-tab="atlas"]').click();
await page.waitForSelector(".card");
ok((await page.locator(".card").count()) >= 12, "returning to the Atlas still renders the compound grid");
ok(await page.evaluate(() => Array.isArray(window.__los.HUMAN_EVIDENCE) && typeof window.__los.strongestHuman === "function"),
  "the QA hook exposes HUMAN_EVIDENCE and strongestHuman");

/* ————— 8. zero errors ————— */
suite("evidence 8 — zero page errors");
ok(pageErrors.length === 0, "no console/page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "evidence: " + failed + " FAILED of " + checks : "evidence: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
