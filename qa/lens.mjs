/* lens — UNDER THE LENS in a real browser.
 *
 * Serves app/ over http with a MOCK swarm server (join/work/submit/stats/hits,
 * the hits carrying SMILES as the real ?a=hits does), opens the Lab on a
 * desktop viewport, and proves the lens's contract:
 *
 *   - nothing starts on load; the pre-run specimen comes from the public
 *     shortlist and is stepped ONLY by a Next press (a refresh never steps it);
 *   - the SVG pool is ≤ 220 nodes and CONSTANT across 200 specimens;
 *   - at most 12 animating elements at any instant, ≤ 3 between builds
 *     (document.getAnimations()), and NO requestAnimationFrame ever;
 *   - the sampling caption's arithmetic is computed from live numbers;
 *   - the rate limit (one specimen per 2,200 ms) drops intermediates;
 *   - HOLD after a stop; the two failure cards (81 atoms, unparseable);
 *   - SCORE ≥ 700 is amber + "worth a look" and nothing else (no audio);
 *   - zero flags prints the sentence, never a tick; hostile results render as text;
 *   - the real worker's spotlight reaches the lens after a Donate press, and the
 *     unit digest is unchanged by it;
 *   - reduced-motion emulation: same DOM, fades only, 0 animations between builds;
 *   - heap growth < 6 MB over 2,000 specimens (performance.memory + --expose-gc);
 *   - zero page errors. Screenshots to qa/shots/lens-*.png.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium } from "playwright";
import { referenceSet, screenMolecule, screenUnit } from "../app/js/chem/score.js";
import { TARGETS } from "../app/js/chem/targets.js";

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

/* ————— molecules and their real results ————— */

const refs = referenceSet();
const ACTIVES = [];
for (const t of TARGETS) for (const a of t.actives || []) ACTIVES.push(a.smiles);
const VARIETY = [
  "CC(=O)OC1=CC=CC=C1C(=O)O", "CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "c1ccc2ccccc2c1", "C1CCC2(CC1)CCCC2",
  "c1ccccc1-c1ccccc1", "CCCCCC", "CC(=O)[O-].[Na+]", "CN(C)C(=N)N=C(N)N", "CC12CCC3C(C1CCC2O)CCC4=CC(=O)CCC34C",
  "O=C1C(O)=C(Oc2cc(O)cc(O)c12)c1ccc(O)c(O)c1", "CC#N", "CC=C=CC", "CCO", "c1ccc2[nH]ccc2c1",
  "CC1=NC(=CC(=C1Cl)NC(=O)C2=CN=C(S2)NC3=CC(=NC(=N3)C)N4CCN(CC4)CCO)C", "CS(=O)(=O)c1ccc(cc1)[N+](=O)[O-]",
  "C[C@H](N)C(=O)O", "F/C=C/F", "C1COCCOCCOCCOCCOCCO1", "N#Cc1ccccc1C#N"
];
const CORPUS = [...ACTIVES, ...VARIETY];
const spotlightFor = (smiles, i) => ({
  type: "spotlight", unitId: "u-qa-" + (i + 1), index: i % 40, cid: String(1000 + i), smiles, result: screenMolecule(smiles, refs)
});

/* the unit the mock hands out: real molecules, real ids */
const UNIT_MOLS = VARIETY.slice(0, 12).map((s, i) => ({ id: String(2000 + i), smiles: s }));
const HITS = [
  { cid: "5284616", smiles: ACTIVES[0], formula: "C51H79NO13", score: 1000, best_target: "mtor", flags: ["hba", "mw", "rotb"], verified_by: 2 },
  { cid: "5280343", smiles: "O=C1C(O)=C(Oc2cc(O)cc(O)c12)c1ccc(O)c(O)c1", formula: "C15H10O7", score: 812, best_target: "sirtuin_polyphenol", flags: [], verified_by: 3 },
  { cid: "2244", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O", formula: "C9H8O4", score: 402, best_target: "nsaid_inflammation", verified_by: 2 }
];

/* ————— the mock swarm server ————— */

const mock = { hits: {}, tokens: new Set(), units: 0 };
const hit = (a) => { mock.hits[a] = (mock.hits[a] || 0) + 1; };
function api(res, url, body) {
  const a = url.searchParams.get("a") || (body && body.a) || "";
  hit(a);
  const out = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (a === "join") { const t = "tok" + (mock.tokens.size + 1); mock.tokens.add(t); return out(200, { token: t.padEnd(32, "0"), contributor: mock.tokens.size, name: "qa" }); }
  if (a === "work") { mock.units++; return out(200, { unit: { unit_id: "u-" + mock.units, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: UNIT_MOLS } }); }
  if (a === "submit") return out(200, { accepted: true, credited: 5, status: "pending" });
  if (a === "stats") return out(200, { totals: { harvested: 1044, screened: 900, verified: 3, contributors: 4, units_open: 12 }, leaderboard: [], teams: [] });
  if (a === "hits") return out(200, { hits: HITS });
  if (a === "me") return out(200, { contributor: { id: 1, name: "qa", units: 0, credits: 0, created_at: 1700000000, team: null } });
  return out(400, { error: "unknown_action" });
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/mock-api/")) {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => { let body = null; try { body = raw ? JSON.parse(raw) : null; } catch (_) {} api(res, url, body); });
    return;
  }
  let p = url.pathname;
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/data/feed.json") { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;
const APP = BASE + "/app/index.html";

/* ————— the browser ————— */

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ["--js-flags=--expose-gc"]
});
const pageErrors = [];
function watch(page, tag) {
  page.on("pageerror", (e) => pageErrors.push(tag + ": " + String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const src = (m.location() && m.location().url) || "";
    if (/\/mock-api\/|\/data\/feed\.json$|\/favicon\.ico$/.test(src)) return;
    pageErrors.push(tag + ": " + m.text() + " @ " + src);
  });
}
/* counters for the things that must never happen without a gesture or at all */
function probes() {
  window.__LOS_API = "/mock-api/";
  window.__probe = { raf: 0, audio: 0 };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (fn) { window.__probe.raf++; return raf.call(window, fn); };
  const wrap = (name) => {
    const Orig = window[name];
    if (!Orig) return;
    window[name] = function (...a) { window.__probe.audio++; return new Orig(...a); };
  };
  wrap("Audio"); wrap("AudioContext"); wrap("webkitAudioContext");
}
async function openLab(ctx, tag) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(APP);
  await page.waitForSelector("#nav .tab");
  await page.locator('[data-tab="lab"]').click();
  await page.waitForSelector('[data-lab="lens"]', { timeout: 15000 });
  return page;
}
const state = (page) => page.evaluate(() => window.__losLens.api.state());
const nodes = (page) => page.evaluate(() => window.__losLens.svg.querySelectorAll("*").length + 1);
const anims = (page) => page.evaluate(() => document.getAnimations().length);
/* The lens is not the only thing on this page. The telemetry strip rotates its
 * own frames on a six-second cadence and pulses a carrier dot, and it was
 * never told that a run stopped — a raw `stopped` event goes to the lens
 * alone. So "nothing is moving" must be asked of the LENS, or the answer
 * depends on whether a 260 ms strip swap happens to be in flight at the
 * instant of the sample. CI caught exactly that, once, on a loaded runner. */
const lensAnims = (page) => page.evaluate(() => {
  const host = document.querySelector('[data-lab="lens"]') || document.querySelector(".lens-stage");
  if (!host) return -1;
  return document.getAnimations().filter((a) => {
    const t = a.effect && a.effect.target;
    return t && host.contains(t);
  }).length;
});
const force = (page, spec) => page.evaluate((s) => window.__losLens.force(s), spec);
const push = (page, spec) => page.evaluate((s) => window.__losLens.api.push(s), spec);
const event = (page, ev) => page.evaluate((e) => window.__losLens.api.onEvent(e), ev);

const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
await ctx.addInitScript(probes);

/* ————— 1. before any run ————— */
suite("lens 1 — before any run: the shortlist specimen, stepped only by a press");
const A = await openLab(ctx, "A");
await until(async () => (await state(A)).hits > 0, 8000);
await sleep(300);
let s = await state(A);
ok(!mock.hits.work && !mock.hits.join, `opening the Lab touches neither ?a=work nor ?a=join (${JSON.stringify(mock.hits)})`);
ok(s.hits === 3, `the already-fetched hits reach the lens (${s.hits})`);
ok(s.mode === "SHORTLIST" && s.hitIndex === 0, `the first shortlist molecule is on stage (${s.mode}, #${s.hitIndex})`);
ok(/From the public shortlist — two independent volunteers scored this identically\. Nothing is running\./.test(s.stateLine), "the pre-run line is verbatim");
ok(s.nextVisible, "a Next button is offered");
ok(!s.running && !s.drewLive, "nothing is running and nothing live has been drawn");
const C = await A.evaluate(() => window.__losLens.constants);
ok(s.caption.startsWith(C.CAPTION_HEAD) && /Shown here this session: 0 · screened by this browser this session: 0\.$/.test(s.caption),
   "the sampling caption prints zeros and no ratio before any run: " + s.caption);
await A.evaluate(() => window.__losLab.refresh());
await sleep(600);
s = await state(A);
ok(s.hitIndex === 0, "a refresh never steps the specimen");
await A.locator(".lens-next").click();
await sleep(1300);   // the readout paints at 1,150 ms
s = await state(A);
ok(s.hitIndex === 1, "a Next press steps it (#" + s.hitIndex + ")");
ok(s.led === "812" && s.amber && s.worth, `the shortlist score is the recorded one, amber at ≥ 700 (${s.led})`);
const ledTwin = await A.evaluate(() => document.querySelector(".lens-led + .led-text").textContent);
ok(ledTwin === s.led, "the LED's text twin carries the identical digits");
await A.locator(".lens-next").click();
await sleep(1300);
s = await state(A);
ok(s.hitIndex === 2 && s.led === "402" && !s.amber && !s.worth, `…and 402 is not amber (${s.led})`);
ok(s.noFlags === "flags not reported by the server for this record — not the same as none", "a hit without a flags field is 'not reported', never 'none'");
await A.locator(".lens-next").click();
await sleep(1300);
s = await state(A);
ok(s.hitIndex === 0 && s.chipsShown === 3, `the list wraps; a flagged hit shows its chips as text (${s.chipsShown})`);
await A.locator(".lens-next").click();
await sleep(1300);
s = await state(A);
ok(s.hitIndex === 1 && s.chipsShown === 0 && s.noFlags === C.NO_FLAGS, "a hit whose server reported [] prints the zero-flags sentence");
const chipText = await A.evaluate(() => [...document.querySelectorAll(".lens-chip")].filter((c) => !c.hidden).map((c) => c.textContent));
ok(!chipText.some((t) => /✓/.test(t)), "no tick anywhere in the chips");
ok(s.title.length > 0 && s.desc.length > 0, "the SVG carries a <title> and a <desc>");
ok(await A.evaluate(() => document.querySelector(".lens-svg").getAttribute("role") === "img"), "the SVG is role=img");
const triage = await A.locator(".lens-flags-title").textContent();
ok(triage === C.TRIAGE_SENTENCE, "the triage sentence is on the panel verbatim");
await A.locator('[data-lab="lens"]').screenshot({ path: join(SHOTS, "lens-idle.png") });

/* ————— 2. the pool ————— */
suite("lens 2 — the pool: ≤ 220 nodes, constant across 200 specimens");
const n0 = await nodes(A);
ok(n0 <= 220, `the lens SVG has ${n0} nodes (≤ 220)`);
let constant = true;
const counts = new Set();
for (let i = 0; i < 200; i++) {
  await force(A, spotlightFor(CORPUS[i % CORPUS.length], i));
  const n = await nodes(A);
  counts.add(n);
  if (n !== n0) constant = false;
}
ok(constant, `the node count never changes across 200 specimens (${[...counts].join(",")})`);
s = await state(A);
ok(s.builds >= 200, `200 builds ran (${s.builds})`);

/* ————— 3. animation budget, no rAF ————— */
suite("lens 3 — ≤ 12 animating elements at any instant; ≤ 3 between builds; no rAF");
let maxAnims = 0;
const samples = [];
/* the lens reports `quiet` once its own timeline is past everything that
 * moves (QUIET_AT); a perf probe samples on that word, so it is checked
 * against the measurement here: whenever the lens says quiet, nothing but
 * the between-builds allowance may be animating */
const quietSamples = [];
let quietAtArrival = null;
for (let round = 0; round < 4; round++) {
  await force(A, spotlightFor(CORPUS[round * 7 % CORPUS.length], round));
  if (quietAtArrival === null) quietAtArrival = (await state(A)).quiet;
  const t0 = Date.now();
  /* sampled past QUIET_AT (2,000) and short of the 2,200 ms lock */
  while (Date.now() - t0 < 2150) {
    const pair = await A.evaluate(() => ({ n: document.getAnimations().length, quiet: window.__losLens.api.state().quiet }));
    samples.push(pair.n);
    if (pair.quiet) quietSamples.push(pair.n);
    if (pair.n > maxAnims) maxAnims = pair.n;
    await sleep(25);
  }
}
ok(maxAnims <= 12, `at most 12 animations at any instant (peak ${maxAnims} over ${samples.length} samples)`);
ok(samples.some((n) => n > 0), "…and the build really does animate (" + Math.max(...samples) + " peak)");
ok(quietAtArrival === false, "a specimen's arrival makes the lens report NOT quiet");
ok(quietSamples.length >= 4 && quietSamples.every((n) => n <= 3), `whenever the lens reports quiet, ≤ 3 animations are measured (${quietSamples.length} quiet samples, max ${Math.max(0, ...quietSamples)})`);
await sleep(400);
const between = await anims(A);
ok(between <= 3, `between builds: ${between} animations (≤ 3)`);
ok((await state(A)).quiet === true, "…and the lens reports quiet between builds");
const raf = await A.evaluate(() => window.__probe.raf);
ok(raf === 0, `requestAnimationFrame was never called (${raf})`);
const audio = await A.evaluate(() => window.__probe.audio);
ok(audio === 0, `no Audio or AudioContext was constructed (${audio})`);
await A.locator('[data-lab="lens"]').screenshot({ path: join(SHOTS, "lens-live.png") });

/* ————— 4. rate limit and the caption's arithmetic ————— */
suite("lens 4 — one specimen per 2,200 ms; live numbers in the caption");
await sleep(2300);
const before = await state(A);
for (let i = 0; i < 5; i++) await push(A, spotlightFor(CORPUS[i], 500 + i));
s = await state(A);
ok(s.builds === before.builds + 1, `five spotlights in a burst start exactly one build (${s.builds - before.builds})`);
ok(s.pendingHeld, "the latest is held as pending");
ok(s.session.offered === before.session.offered + 5, "all five count as offered");
await sleep(2400);
s = await state(A);
ok(s.builds === before.builds + 2 && !s.pendingHeld, `the pending one shows when the stage frees (${s.builds - before.builds} builds)`);
ok(s.session.dropped === before.session.dropped + 3, `three intermediates were dropped (${s.session.dropped - before.session.dropped})`);
/* the denominator: unit / progress / submitted events */
await event(A, { type: "unit", unitId: "u-x", total: 40 });
await event(A, { type: "progress", unitId: "u-x", done: 40, total: 40 });
await event(A, { type: "submitted", unitId: "u-x", status: "pending" });
await event(A, { type: "unit", unitId: "u-y", total: 40 });
await event(A, { type: "progress", unitId: "u-y", done: 15, total: 40 });
s = await state(A);
const shown = s.session.shown, screened = s.session.screened;
ok(screened === before.session.screened + 55, `screened counts completed units plus the unit in progress (${screened})`);
const expected = `Shown here this session: ${shown.toLocaleString("en-US")} · screened by this browser this session: ${screened.toLocaleString("en-US")}` +
  (shown > 0 && screened >= shown ? ` — one in ${Math.round(screened / shown).toLocaleString("en-US")}.` : ".");
ok(s.caption === C.CAPTION_HEAD + " " + expected, `the caption's ratio is computed from the live numbers\n      got:  ${s.caption}\n      want: ${C.CAPTION_HEAD + " " + expected}`);
ok(!/one in (5|five)\b/.test(s.caption) || Math.round(screened / shown) === 5, "no fixed ratio");
/* a forced stream can show more than it screened; the caption must then say nothing about a ratio */
for (let i = 0; i < 3; i++) await force(A, spotlightFor(CORPUS[i], 600 + i));
s = await state(A);
ok(s.session.shown > s.session.screened ? !/one in/.test(s.caption) : /one in \d/.test(s.caption),
   "a ratio is printed only when screened ≥ shown — never 'one in 0': " + s.caption.slice(-60));

/* ————— 5. HOLD ————— */
suite("lens 5 — HOLD after a stop");
await event(A, { type: "stopped", reason: "stopped" });
await sleep(400);
s = await state(A);
ok(s.mode === "HOLD" && s.hold, `the mode reads HOLD (${s.mode})`);
const opacity = await A.evaluate(() => getComputedStyle(document.querySelector(".lens-stage")).opacity);
ok(Math.abs(parseFloat(opacity) - 0.55) < 0.02, `the stage holds at 55% opacity (${opacity})`);
ok(s.stateLine === C.HOLD_LINE, "the HOLD line is verbatim");
ok(!s.nextVisible, "no Next button after a live run");
await sleep(2400);
{
  const inLens = await lensAnims(A);
  ok(inLens === 0, `nothing in the lens animates while nothing is running (${inLens}; ${await anims(A)} on the page, where the strip legitimately keeps rotating its own frames)`);
}
await A.locator('[data-lab="lens"]').screenshot({ path: join(SHOTS, "lens-hold.png") });

/* ————— 6. failure cards ————— */
suite("lens 6 — the two failure cards");
await force(A, spotlightFor("C".repeat(81), 900));
await sleep(1300);
s = await state(A);
ok(s.failShown && s.failText === C.REFUSED, "an 81-atom molecule that scored normally gets the refused card");
ok(/^\d+$/.test(s.led), `…and its real score is beside it (${s.led})`);
await force(A, spotlightFor("((((((", 901));
await sleep(1300);
s = await state(A);
ok(s.failShown && s.failText === C.UNPARSEABLE, "an unparseable molecule gets DID NOT PARSE");
ok(s.led === "0", `…scored 0 (${s.led})`);
ok(s.chipsShown === 1, "its one flag, 'unparseable', is a chip");
await A.locator('[data-lab="lens"]').screenshot({ path: join(SHOTS, "lens-fail.png") });
await force(A, spotlightFor("C1C2CC3CC1CC(C2)C3", 902));   // adamantane: approximate ⇒ refused
await sleep(200);
s = await state(A);
ok(s.failShown && s.failText === C.REFUSED, "an approximate (cage) layout is refused honestly");

/* ————— 7. score ≥ 700, flags, hostile results ————— */
suite("lens 7 — 700 is amber and words, zero flags is a sentence, hostile results are text");
/* the engine's real number, not an invented one: a self-match has similarity
 * 1000 but the drug-likeness penalties still apply (rapamycin: 792) */
const HIGH = CORPUS.map((smi) => [smi, screenMolecule(smi, refs).score]).filter((x) => x[1] >= 700).sort((a, b) => b[1] - a[1])[0];
ok(!!HIGH, "the corpus holds a molecule the engine scores at 700 or more");
await force(A, spotlightFor(HIGH[0], 903));
await sleep(1300);
s = await state(A);
ok(s.led === String(HIGH[1]) && s.amber && s.worth, `the LED shows the engine's own score, amber, 'worth a look' (${s.led} vs ${HIGH[1]})`);
ok(s.barsShown >= 8 && s.barsShown <= 10, `per-target bars in engine order (${s.barsShown})`);
const barLabel = await A.evaluate(() => document.querySelector(".lens-bar:not([hidden]) .lens-bar-label").textContent);
ok(/ · \d+ per mille$/.test(barLabel), `bars are labelled '<target> · <sim> per mille' (${barLabel})`);
ok((await A.evaluate(() => window.__probe.audio)) === 0, "no sound at " + HIGH[1]);
await force(A, spotlightFor("CCO", 904));
await sleep(1300);
s = await state(A);
ok(!s.amber && !s.worth && s.chipsShown === 0 && s.noFlags === C.NO_FLAGS, `ethanol: not amber, zero flags prints the sentence (${s.led})`);
/* built inside the page (a throwing toString cannot cross the wire) */
const threw = await A.evaluate(() => {
  const hostile = {
    type: "spotlight", unitId: { toString() { throw new Error("x"); } }, index: "1", cid: "<img src=x onerror=alert(1)>",
    smiles: 42, result: { ok: true, score: "940", best: "<b>x</b>", bestSim: -5, perTarget: [{ target: "<img>", sim: 5000 }, { target: null, sim: "9" }, {}, null],
      flags: [{}, "<script>", "a".repeat(200)], alerts: 7, formula: 12, desc: { mw: "x" } }
  };
  try { window.__losLens.force(hostile); return false; } catch (e) { return String(e); }
});
await sleep(1300);
s = await state(A);
ok(threw === false, "a hostile result never throws out of the lens (" + threw + ")");
ok(s.led === "0", `a non-integer score reads 0 (${s.led})`);
ok((await A.evaluate(() => document.querySelector(".lens").querySelectorAll("img, script, b").length)) === 0, "no markup was created from hostile text");
ok((await A.evaluate(() => document.querySelector(".lens-bar:not([hidden]) .lens-bar-val").textContent)) === "1000", "a similarity above 1000 is clamped");
ok((await nodes(A)) === n0, "the pool is still the same size after hostile input");

/* ————— 8. the real worker's spotlight ————— */
suite("lens 8 — the real worker: one molecule every fortieth chunk, by position, digest untouched");
/* UNIT_MOLS is 12 molecules = 3 chunks of 5 (0–4, 5–9, 10–11). Sixteen units
 * = 45 chunks of the twelve-molecule kind plus one two-molecule unit that has
 * no chunk loop at all: the spotlight must fire on chunk 0 (unit 1, position 0)
 * and chunk 40 (unit 14's second chunk, position 5) and nowhere else. */
const WORKER_UNITS = 16;
const workerRun = await A.evaluate(({ base, mols, n }) => new Promise((resolve) => {
  const w = new Worker(base + "/app/js/swarm/worker.js", { type: "module" });
  const out = { spotlights: [], digests: [] };
  const units = [];
  for (let k = 1; k < n; k++) units.push({ unit_id: "w" + k, molecules: mols });
  units.push({ unit_id: "w" + n, molecules: mols.slice(0, 2) });
  let i = 0;
  const timer = setTimeout(() => { w.terminate(); resolve(Object.assign(out, { timedOut: true })); }, 90000);
  w.onmessage = (ev) => {
    const d = ev.data || {};
    if (d.type === "spotlight") { out.spotlights.push({ unitId: d.unitId, index: d.index, cid: d.cid, smiles: d.smiles, score: d.result && d.result.score }); return; }
    if (d.type === "done") out.digests.push(d.result.digest);
    else if (d.type === "error") out.digests.push("error:" + d.message);
    else return;
    i++;
    if (i >= units.length) { clearTimeout(timer); w.terminate(); resolve(out); }
    else w.postMessage({ type: "screen", unit: units[i] });
  };
  w.postMessage({ type: "screen", unit: units[0] });
}), { base: BASE, mols: UNIT_MOLS, n: WORKER_UNITS });
ok(!workerRun.timedOut && workerRun.digests.length === WORKER_UNITS, `${WORKER_UNITS} units came back (${workerRun.digests.length})`);
const spotSeen = workerRun.spotlights.map((x) => x.unitId + ":" + x.index).join(",");
ok(workerRun.spotlights.length === 2, `45 chunks → two spotlights, on chunks 0 and 40 (${workerRun.spotlights.length}: ${spotSeen})`);
ok(spotSeen === "w1:0,w14:5", `…unit 1 position 0 and unit 14 position 5 — a chunk counter, the first molecule of the chunk (${spotSeen})`);
const sp1 = workerRun.spotlights[1] || {};
ok(sp1.cid === UNIT_MOLS[5].id && sp1.smiles === UNIT_MOLS[5].smiles, "the spotlight names the molecule at that position");
ok(sp1.score === screenMolecule(UNIT_MOLS[5].smiles, refs).score, "its score is the engine's own");
const nodeDigest = screenUnit({ unit_id: "w1", molecules: UNIT_MOLS }, refs).digest;
const nodeDigest14 = screenUnit({ unit_id: "w14", molecules: UNIT_MOLS }, refs).digest;
const nodeDigestTiny = screenUnit({ unit_id: "w" + WORKER_UNITS, molecules: UNIT_MOLS.slice(0, 2) }, refs).digest;
ok(workerRun.digests[0] === nodeDigest && workerRun.digests[13] === nodeDigest14 && workerRun.digests[WORKER_UNITS - 1] === nodeDigestTiny,
   "the unit digests are byte-identical to bare Node's, spotlighted units included — the spotlight touched nothing");
/* the spotlight is not the best-scoring molecule of the unit (it is chosen by position) */
const scoresInUnit = UNIT_MOLS.map((m) => screenMolecule(m.smiles, refs).score);
const bestIdx = scoresInUnit.indexOf(Math.max(...scoresInUnit));
ok(!(workerRun.spotlights.every((x) => x.index === bestIdx)), "the spotlight is not simply the unit's best score");

/* ————— 9. end to end: press Donate, a live specimen arrives ————— */
suite("lens 9 — Donate → a live specimen, then Stop → HOLD");
const B = await openLab(ctx, "B");
await until(async () => (await state(B)).hits > 0, 8000);
const b0 = await state(B);
ok(b0.mode === "SHORTLIST", "a fresh Lab starts on the shortlist");
const workBefore = mock.hits.work || 0;
await B.locator(".lab-btn", { hasText: "Donate this browser" }).click();
const live = await until(async () => { const st = await state(B); return st.drewLive ? st : null; }, 30000);
ok(!!live, "a live specimen was drawn after the press");
ok((mock.hits.work || 0) > workBefore, "…and only after the press did ?a=work fire");
if (live) {
  ok(live.mode === "LIVE", `the mode reads LIVE (${live.mode})`);
  const unitLine = await B.locator(".lens-unit").textContent();
  ok(/^unit u-\d+ · molecule \d+$/.test(unitLine), `the header names the unit and the position (${unitLine})`);
  ok(!live.nextVisible, "no Next button while running");
}
await sleep(1500);
await B.locator('[data-lab="lens"]').screenshot({ path: join(SHOTS, "lens-e2e-live.png") });
/* regression: a tab round-trip WHILE RUNNING re-mounts the lens; the idle
 * paint at construction says HOLD, and setRunning(true) must overrule it —
 * the coloured state carries the right word, the stage is not dimmed */
await B.locator('[data-tab="atlas"]').click();
await B.waitForSelector(".card");
await B.locator('[data-tab="lab"]').click();
await B.waitForSelector('[data-lab="lens"]');
await sleep(100);
const mid = await state(B);
ok(mid.running && mid.mode === "LIVE" && !mid.hold, `re-mount while running: the word is LIVE and the stage is undimmed (${mid.mode}, hold ${mid.hold})`);
ok(/^Screening/.test(mid.stateLine), `…and the state line says screening (${mid.stateLine})`);
ok(mid.drewLive && mid.led.length > 0, "the last live specimen is back on stage with its score");
await B.getByRole("button", { name: "Stop", exact: true }).click();
await sleep(600);
const held = await state(B);
ok(held.mode === "HOLD" && held.hold && held.stateLine === C.HOLD_LINE, `Stop → HOLD (${held.mode})`);
/* regression: the unit in flight at Stop still finishes in the worker and
 * posts its spotlight afterwards — it must not re-light the stage */
await event(B, spotlightFor(VARIETY[3], 700));
await sleep(300);
const late = await state(B);
ok(late.mode === "HOLD" && late.builds === held.builds, `a spotlight arriving after Stop is ignored (${late.mode}, builds ${late.builds}/${held.builds})`);
ok(held.session.shown >= 1 && held.session.screened >= 12, `the session counters are live (shown ${held.session.shown}, screened ${held.session.screened})`);
/* a tab round-trip keeps the session counters */
await B.locator('[data-tab="atlas"]').click();
await B.waitForSelector(".card");
await B.locator('[data-tab="lab"]').click();
await B.waitForSelector('[data-lab="lens"]');
await sleep(300);
const back = await state(B);
ok(back.session.shown === held.session.shown && back.session.screened === held.session.screened, "leaving and returning to the Lab keeps 'this session'");
ok(back.mode === "HOLD", "…and the lens comes back on HOLD");
const stampOn = await B.evaluate((id) => window.__losLens.api.stamp(id), "not-this-unit");
ok(stampOn === false, "the SECOND WITNESS stamp refuses a unit that is not on stage (so the caller relocates it)");

/* ————— 9b. Stop in the middle of a build: HOLD means nothing moves ————— */
suite("lens 9b — Stop mid-build cuts the timeline; the bubbling animationend regression");
/* headless Chromium stops ticking CSS animations on a page once another page
 * in the context has been screenshotted (no animationend ever fires there);
 * page B was, above — so page A is made the active page again first */
await A.bringToFront();
await sleep(2300);
await force(A, spotlightFor(ACTIVES[5], 971));
await sleep(300);
const preStop = await state(A);
ok(preStop.locked && (await anims(A)) > 0, "a build is in flight 300 ms after the specimen arrived");
await event(A, { type: "stopped" });
/* the ONLY thing allowed to move after Stop is the stage's own 260 ms dim to 55% */
const rightAfter = await A.evaluate(() => ({
  anims: document.getAnimations().filter((a) => !(a.effect && a.effect.target && a.effect.target.classList.contains("lens-stage"))).length,
  building: !!document.querySelector(".lens-mol.is-building"),
  settle: !!document.querySelector(".lens-mol.is-settle"),
  led: window.__losLens.api.state().led, locked: window.__losLens.api.state().locked, mode: window.__losLens.api.state().mode
}));
ok(rightAfter.anims === 0, `within one frame of Stop nothing but the stage dim is animating (${rightAfter.anims})`);
ok(!rightAfter.building && !rightAfter.settle, "the build and settle classes are gone");
const stopScore = String(screenMolecule(ACTIVES[5], refs).score);
ok(rightAfter.led === stopScore && !rightAfter.locked && rightAfter.mode === "HOLD", `the readout printed the engine's score at once and the stage is on HOLD (${rightAfter.led} vs ${stopScore}, ${rightAfter.mode})`);
/* the stage dim is 260 ms; the old timeline would have kept moving to 1,600 */
const quiet = await until(async () => (await anims(A)) === 0 ? "quiet" : null, 600);
ok(quiet === "quiet", "…and within 600 ms of Stop nothing at all is animating");
const fillNow = await A.evaluate(() => getComputedStyle(document.querySelector(".lens-bar:not([hidden]) .lens-bar-track i")).transform);
ok(fillNow !== "matrix(0, 0, 0, 1, 0, 0)" && fillNow !== "none", `the bars landed at their values without a transition (${fillNow})`);
/* regression: animationend bubbles from a ring-closure path to its wave
 * group; a closure ending inside wave 7 must not end the build early. A
 * cyclopentane and a cyclobutane joined by a branched twelve-carbon chain:
 * exactly two closures (both stroked — the cap is two) and the far ring's
 * closure lands in the last wave (layout.mjs-style search picked it). */
const BUBBLE_SMILES = "C1CCCC1CCCCCCCCCCCC(C)C1CCC1";
await sleep(2300);
await A.evaluate(() => {
  const mol = document.querySelector(".lens-mol");
  const waves = mol.querySelectorAll("g.mol-wave");
  const w7 = waves[waves.length - 1];
  const P = { removedAt: null, w7EndAt: null, closeEndsInW7: 0, armed: false, mol };
  window.__buildProbe = P;
  new MutationObserver(() => { if (P.armed && P.removedAt === null && !mol.classList.contains("is-building")) P.removedAt = performance.now(); }).observe(mol, { attributes: true, attributeFilter: ["class"] });
  w7.addEventListener("animationend", (e) => {
    if (e.target === w7) P.w7EndAt = performance.now();
    else if (e.target.classList && e.target.classList.contains("mol-close")) P.closeEndsInW7++;
  });
});
await A.evaluate((spec) => { window.__losLens.force(spec); window.__buildProbe.armed = true; }, spotlightFor(BUBBLE_SMILES, 972));
await until(() => A.evaluate(() => window.__buildProbe.w7EndAt !== null && window.__buildProbe.removedAt !== null), 3000);
const bp = await A.evaluate(() => Object.assign({}, window.__buildProbe, { molConnected: document.querySelector(".lens-mol") === window.__buildProbe.mol, mols: document.querySelectorAll(".lens-mol").length, building: window.__losLens.api.state().builds }));
ok(bp.closeEndsInW7 >= 1, `a ring closure ended inside wave 7 — the trigger condition (${bp.closeEndsInW7}; mol live ${bp.molConnected}, removed at ${bp.removedAt === null ? "never" : Math.round(bp.removedAt)})`);
ok(bp.w7EndAt !== null, "wave 7's own grow ran to its end");
ok(bp.removedAt !== null && bp.w7EndAt !== null && bp.removedAt >= bp.w7EndAt - 2, `the build ended at wave 7's end, not at the closure's (${bp.removedAt && bp.w7EndAt ? Math.round(bp.removedAt - bp.w7EndAt) : "?"} ms after)`);

/* ————— 10. reduced motion ————— */
suite("lens 10 — reduced motion: same DOM, fades only");
const rctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, reducedMotion: "reduce" });
await rctx.addInitScript(probes);
const R = await openLab(rctx, "R");
await until(async () => (await state(R)).hits > 0, 8000);
const rn = await nodes(R);
ok(rn === n0, `the reduced-motion page has the identical node count (${rn} vs ${n0})`);
let rmax = 0;
let sawScaleKeyframe = false;
await force(R, spotlightFor(ACTIVES[3], 950));
const rt0 = Date.now();
while (Date.now() - rt0 < 1500) {
  const n = await anims(R);
  if (n > rmax) rmax = n;
  const kinds = await R.evaluate(() => document.getAnimations().map((a) => {
    try { return a.effect.getKeyframes().map((k) => Object.keys(k).join("|")).join(","); } catch (_) { return ""; }
  }));
  if (kinds.some((k) => /transform|strokeDashoffset/.test(k))) sawScaleKeyframe = true;
  await sleep(40);
}
ok(rmax <= 12 && rmax > 0, `reduced motion still builds, within budget (peak ${rmax})`);
ok(!sawScaleKeyframe, "under reduced motion no keyframe carries a transform or a dash — fades only");
await sleep(1200);
ok((await anims(R)) === 0, "0 animations between builds under reduced motion");
const barTransition = await R.evaluate(() => getComputedStyle(document.querySelector(".lens-bar-track i")).transitionProperty);
ok(/none|^$/.test(barTransition) || barTransition === "all" && false, `bars have no transition under reduced motion (${barTransition})`);
await R.locator('[data-lab="lens"]').screenshot({ path: join(SHOTS, "lens-reduced.png") });
await rctx.close();

/* ————— 11. heap ————— */
suite("lens 11 — heap growth < 6 MB over 2,000 specimens");
const heap = await A.evaluate(async (corpus) => {
  if (!performance.memory || typeof window.gc !== "function") return { skipped: true };
  const specs = corpus;
  window.gc(); window.gc();
  await new Promise((r) => setTimeout(r, 100));
  const before = performance.memory.usedJSHeapSize;
  for (let i = 0; i < 2000; i++) window.__losLens.force(specs[i % specs.length]);
  await new Promise((r) => setTimeout(r, 2500));
  window.gc(); window.gc();
  await new Promise((r) => setTimeout(r, 100));
  const after = performance.memory.usedJSHeapSize;
  return { before, after, growth: after - before };
}, CORPUS.map((smi, i) => spotlightFor(smi, i)));
if (heap.skipped) {
  console.log("   performance.memory / gc unavailable in this browser — heap check skipped");
} else {
  console.log(`   heap ${(heap.before / 1048576).toFixed(1)} MB → ${(heap.after / 1048576).toFixed(1)} MB (growth ${(heap.growth / 1048576).toFixed(2)} MB)`);
  ok(heap.growth < 6 * 1048576, `heap growth over 2,000 specimens is ${(heap.growth / 1048576).toFixed(2)} MB (< 6 MB)`);
}
ok((await nodes(A)) === n0, "…and the pool is still exactly the same size");

/* ————— 12. zero errors ————— */
suite("lens 12 — zero page errors");
ok(pageErrors.length === 0, "no console/page errors: " + JSON.stringify(pageErrors.slice(0, 3)));

await browser.close();
server.close();
console.log(failed ? "lens: " + failed + " FAILED of " + checks : "lens: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
