/* unit — the data contracts. Run: node qa/unit.mjs (from repo root or qa/). */
import { COMPOUNDS, HEADLINE, DISCLAIMER } from "../app/js/data.js";
import { strongest, hasRigorousNull, RUNGS } from "../app/js/grades.js";
import { parseFeed, feedFreshness } from "../app/js/feed.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

/* ————— 1. every evidence row is fully sourced ————— */
suite("unit 1 — every claim carries its source");
const ORGS = ["cell", "worm", "fly", "mouse", "rat", "dog", "monkey", "human-obs", "human-rct"];
const OUTS = ["lifespan", "healthspan", "biomarker", "safety", "trial", "null"];
const DOMAINS = [
  "pubmed.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov",
  "www.nature.com", "www.science.org", "onlinelibrary.wiley.com",
  "www.nejm.org", "insight.jci.org", "clinicaltrials.gov", "www.cell.com",
  "www.thelancet.com", "link.springer.com", "doi.org"
];
ok(COMPOUNDS.length >= 12, "the atlas opens with a real corpus (≥12 compounds)");
for (const c of COMPOUNDS) {
  ok(typeof c.id === "string" && /^[a-z0-9]+$/.test(c.id), c.id + ": id is a slug");
  ok(typeof c.name === "string" && c.name.length > 2, c.id + ": name present");
  ok(typeof c.klass === "string" && c.klass.length > 3, c.id + ": class present");
  for (const k of ["what", "humanStatus", "verdict"]) {
    ok(typeof c[k] === "string" && c[k].length > 10, c.id + ": " + k + " is substantive");
  }
  ok(Array.isArray(c.risks) && c.risks.length >= 1, c.id + ": risks are stated");
  ok(typeof c.itp === "boolean", c.id + ": itp flag is explicit");
  ok(!("grade" in c) && !("rung" in c), c.id + ": no hand-set grade (grades are computed, never typed)");
  ok(Array.isArray(c.evidence) && c.evidence.length >= 1, c.id + ": has evidence rows");
  for (const ev of c.evidence) {
    ok(typeof ev.finding === "string" && ev.finding.length > 20, c.id + ": finding is substantive");
    ok(ORGS.includes(ev.organism), c.id + ": organism '" + ev.organism + "' is a known organism");
    ok(OUTS.includes(ev.outcome), c.id + ": outcome '" + ev.outcome + "' is a known outcome");
    ok(Number.isInteger(ev.year) && ev.year >= 1990 && ev.year <= 2027, c.id + ": year sane");
    ok(typeof ev.cite === "string" && ev.cite.length > 8, c.id + ": citation text present");
    ok(typeof ev.titleCheck === "string" && ev.titleCheck.length >= 6, c.id + ": titleCheck present for CI verification");
    ok(typeof ev.url === "string" && ev.url.startsWith("https://"), c.id + ": url is https");
    let host = "";
    try { host = new URL(ev.url).host; } catch (_) { /* fails below */ }
    ok(DOMAINS.includes(host), c.id + ": url host '" + host + "' is an allowlisted primary source");
  }
}

/* ————— 2. the ladder computes, never asserts ————— */
suite("unit 2 — the evidence ladder");
ok(RUNGS[0].key === "H2" && /No compound has ever earned this rung/.test(RUNGS[0].blurb),
  "the top rung is explicitly empty — that emptiness is load-bearing");
const byId = Object.fromEntries(COMPOUNDS.map((c) => [c.id, c]));
ok(strongest(byId.rapamycin) === "M2", "rapamycin: replicated ITP mouse lifespan → M2");
ok(strongest(byId.glycine) === "M2", "glycine: ITP both sexes → M2");
ok(strongest(byId.nad) === "H1", "NAD precursors: human RCT biomarker → H1");
ok(strongest(byId.urolithin) === "H1", "urolithin A: human RCT biomarker → H1");
ok(strongest(byId.caakg) === "M1", "CaAKG: single-program mouse → M1");
ok(strongest(byId.dq) === "M1", "D+Q: non-ITP mouse lifespan → M1");
for (const c of COMPOUNDS) ok(strongest(c) !== "H2", c.id + ": nothing may ever compute to H2 from current data");

/* ————— 3. the nulls are present and first-class ————— */
suite("unit 3 — failures stay on the record");
for (const id of ["metformin", "fisetin", "resveratrol", "aspirin", "nad", "taurine"]) {
  ok(hasRigorousNull(byId[id]), id + ": its rigorous null/contrary row is present");
}
ok(byId.fisetin.evidence.some((e) => e.outcome === "null" && /ITP/.test(e.cite)),
  "fisetin: the ITP null is cited to the ITP itself");
ok(byId.aspirin.evidence.some((e) => e.organism === "human-rct" && e.outcome === "null"),
  "aspirin: the ASPREE human null is recorded as human-rct");

/* ————— 4. the feed parser refuses garbage ————— */
suite("unit 4 — feed parser");
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "feed.json"), "utf8"));
const good = parseFeed(fixture);
ok(good && good.entries.length >= 2, "valid fixture parses");
ok(good.entries.every((e) => /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(e.url)),
  "every feed link is a pubmed url built from a numeric pmid");
ok(parseFeed(null) === null, "null refused");
ok(parseFeed({}) === null, "empty object refused");
ok(parseFeed({ fetched_at: "nonsense", entries: [] }) === null, "bad timestamp refused");
ok(parseFeed({ fetched_at: new Date().toISOString(), entries: [{ title: "x", pmid: "javascript:alert(1)" }] }) === null,
  "script-shaped pmid refused (and with it the whole empty feed)");
const big = { fetched_at: new Date().toISOString(), entries: Array.from({ length: 500 }, (_, i) => ({ title: "t" + i, pmid: String(1000 + i) })) };
ok(parseFeed(big).entries.length <= 100, "oversized feed truncated");
const longTitle = { fetched_at: new Date().toISOString(), entries: [{ title: "y".repeat(9000), pmid: "123" }] };
ok(parseFeed(longTitle).entries[0].title.length <= 300, "hostile title length-capped");
const fr = feedFreshness({ fetchedAt: Date.now() - 20 * 86400000, entries: [] }, Date.now());
ok(fr.stale === true && /STALE/.test(fr.label), "a 20-day-old sweep calls itself stale");

/* ————— 5. headline honesty is present in data itself ————— */
suite("unit 5 — the headline");
ok(/No drug has ever been shown to extend human lifespan/.test(HEADLINE), "the headline states the truth of the field");
ok(/not medical advice/i.test(DISCLAIMER), "the disclaimer says what this is not");

console.log(failed ? "unit: " + failed + " FAILED of " + checks : "unit: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
