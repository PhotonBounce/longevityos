/* unit — the data contracts. Run: node qa/unit.mjs (from repo root or qa/). */
import { COMPOUNDS, HEADLINE, DISCLAIMER } from "../app/js/data.js";
import { strongest, hasRigorousNull, RUNGS } from "../app/js/grades.js";
import { parseFeed, feedFreshness } from "../app/js/feed.js";
import { HUMAN_EVIDENCE, EVIDENCE_HEADLINE, EVIDENCE_NOTE, EVIDENCE_RUNGS, strongestHuman, hasHumanNull, rungLabelHuman } from "../app/js/evidence.js";
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

/* ————— 6. the human-evidence ledger is sourced exactly like the atlas ————— */
suite("unit 6 — what has evidence in people: every row carries its source");
const EV_KEYS = ["id", "name", "kind", "what", "who", "caveat", "rows"].sort().join();
const EV_ROW_KEYS = ["finding", "design", "outcome", "effect", "year", "cite", "url", "titleCheck"].sort().join();
const EV_KINDS = ["behaviour", "medical", "diet", "supplement", "environment", "procedure"];
const EV_DESIGNS = ["rct", "meta-rct", "cohort", "meta-cohort", "controlled"];
const EV_OUTS = ["mortality", "events", "null", "harm"];
ok(HUMAN_EVIDENCE.length >= 18 && HUMAN_EVIDENCE.length <= 24,
  "the ledger opens with a real corpus of 18–24 items (" + HUMAN_EVIDENCE.length + ")");
const evIds = new Set();
for (const it of HUMAN_EVIDENCE) {
  ok(Object.keys(it).sort().join() === EV_KEYS, it.id + ": exactly the item keys — none missing, none extra");
  ok(typeof it.id === "string" && /^[a-z0-9]+$/.test(it.id), it.id + ": id is a slug");
  ok(!evIds.has(it.id), it.id + ": id is unique");
  evIds.add(it.id);
  ok(typeof it.name === "string" && it.name.length > 2, it.id + ": name present");
  ok(EV_KINDS.includes(it.kind), it.id + ": kind '" + it.kind + "' is a known kind");
  for (const k of ["what", "who", "caveat"]) {
    ok(typeof it[k] === "string" && it[k].length > 10, it.id + ": " + k + " is substantive");
  }
  ok(Array.isArray(it.rows) && it.rows.length >= 1, it.id + ": has at least one row");
  for (const r of it.rows) {
    ok(Object.keys(r).sort().join() === EV_ROW_KEYS, it.id + ": row carries exactly the row keys");
    ok(typeof r.finding === "string" && r.finding.length > 20, it.id + ": finding is substantive");
    ok(EV_DESIGNS.includes(r.design), it.id + ": design '" + r.design + "' is a known design");
    ok(EV_OUTS.includes(r.outcome), it.id + ": outcome '" + r.outcome + "' is a known outcome");
    ok(typeof r.effect === "string" && r.effect.trim().length > 0, it.id + ": effect is stated as reported (never empty)");
    ok(Number.isInteger(r.year) && r.year >= 1990 && r.year <= 2027, it.id + ": year sane");
    ok(typeof r.cite === "string" && r.cite.length > 8, it.id + ": citation text present");
    ok(typeof r.titleCheck === "string" && r.titleCheck.length >= 6, it.id + ": titleCheck present for CI verification");
    ok(typeof r.url === "string" && r.url.startsWith("https://"), it.id + ": url is https");
    let host = "";
    try { host = new URL(r.url).host; } catch (_) { /* fails below */ }
    ok(DOMAINS.includes(host), it.id + ": url host '" + host + "' is an allowlisted primary source");
    ok(/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/.test(r.url) || /^https:\/\/clinicaltrials\.gov\/study\/NCT\d+$/.test(r.url),
      it.id + ": url is a PubMed record or a CT.gov study — the two tiers CI can verify against an API");
  }
}

/* ————— 7. the human rungs compute, never assert ————— */
suite("unit 7 — the human-evidence rungs");
ok(EVIDENCE_RUNGS.map((r) => r.key).join() === "E3,E2,E1,E0", "rung order is E3 → E2 → E1 → E0");
ok(EVIDENCE_RUNGS.every((r) => typeof r.label === "string" && typeof r.blurb === "string" && r.blurb.length > 20),
  "every rung has a label and a blurb");
ok(rungLabelHuman("E3") === "Randomised trial: fewer deaths" && rungLabelHuman("E0") === "Rigorous null or harm",
  "rung labels say what the rung is");
ok(strongestHuman({ rows: [] }) === "E0", "an item with no positive row computes to E0");
ok(strongestHuman({ rows: [{ design: "cohort", outcome: "mortality" }, { design: "rct", outcome: "null" }] }) === "E1",
  "an RCT null never lifts a rung; a cohort mortality row alone is E1");
ok(strongestHuman({ rows: [{ design: "rct", outcome: "events" }, { design: "meta-cohort", outcome: "mortality" }] }) === "E2",
  "randomised events outrank observational deaths");
const evById = Object.fromEntries(HUMAN_EVIDENCE.map((it) => [it.id, it]));
for (const [id, rung] of [
  ["bloodpressure", "E3"], ["statins", "E3"], ["empagliflozin", "E3"], ["saltsubstitute", "E3"],
  ["semaglutide", "E2"], ["colonoscopy", "E2"], ["exercise", "E1"], ["bariatric", "E1"],
  ["vitamind", "E0"], ["aspirinelderly", "E0"], ["intensiveglucose", "E0"]
]) {
  ok(evById[id] && strongestHuman(evById[id]) === rung, id + ": computes to " + rung);
}
const nullRows = HUMAN_EVIDENCE.flatMap((it) => it.rows).filter((r) => r.outcome === "null" || r.outcome === "harm");
ok(nullRows.length >= 7, "at least 7 null/harm rows across the ledger (" + nullRows.length + ")");
const e3 = HUMAN_EVIDENCE.filter((it) => strongestHuman(it) === "E3");
ok(e3.length >= 4, "at least 4 items reach E3 — randomised, fewer deaths (" + e3.length + ")");
const allNull = HUMAN_EVIDENCE.filter((it) => it.rows.every((r) => r.outcome === "null" || r.outcome === "harm"));
ok(allNull.length >= 1, "at least one item's ONLY human evidence is null or harm (" + allNull.map((i) => i.id).join(", ") + ")");
for (const it of allNull) ok(strongestHuman(it) === "E0" && hasHumanNull(it), it.id + ": an all-null item sits on E0 and wears its null");
ok(evById.exercise.rows.some((r) => (r.design === "cohort" || r.design === "meta-cohort") && r.outcome === "mortality"),
  "exercise: the pooled-cohort mortality gradient is on record");
ok(evById.exercise.rows.some((r) => r.design === "rct" && r.outcome === "null"),
  "exercise: the Generation 100 randomised null is on the same card");
ok(hasHumanNull(evById.exercise) && !hasHumanNull(evById.smokingcessation),
  "hasHumanNull answers per item");
ok(/not medical advice/.test(EVIDENCE_HEADLINE), "the ledger's headline says it is not medical advice");
ok(/did nothing/.test(EVIDENCE_HEADLINE) && /harm/.test(EVIDENCE_HEADLINE), "the headline promises the nulls and the harms");
ok(/people like those in the trial/.test(EVIDENCE_NOTE), "the note frames every result as 'people like those in the trial'");

/* ————— 8. the ledger's copy never advises ————— */
suite("unit 8 — the ledger reports; it never advises");
const evSrc = readFileSync(join(HERE, "..", "app", "js", "evidence.js"), "utf8");
const EV_BANNED = [
  [/\byou should\b/i, "'you should'"],
  [/\brecommended\b/i, "'recommended' (doses appear only as what a trial used)"],
  [/\btake \d+/i, "'take N …' dosing"],
  [/\bmakes? you live\b/i, "'makes you live'"],
  [/\bclinically proven\b/i, "'clinically proven'"],
  [/\bguaranteed\b/i, "'guaranteed'"],
  [/\bwill extend your life\b/i, "'will extend your life'"],
  [/\bsafe to take\b/i, "'safe to take'"],
  [/\b(cures?|reverses?) aging\b/i, "'cures/reverses aging'"],
  [/\bproven to extend human lifespan\b/i, "'proven to extend human lifespan'"],
  [/\bdiscovered a drug\b/i, "'discovered a drug'"],
  [/\bvalidated candidate\b/i, "'validated candidate'"],
  [/\b(you|people|patients|adults) (must|need to|ought to|have to)\b/i, "a verb of advice"]
];
for (const [re, why] of EV_BANNED) ok(!re.test(evSrc), "evidence.js never says " + why + " (" + re + ")");
ok(/fewer deaths|reduced all-cause mortality/.test(evSrc), "the ledger speaks in the trial's own terms: fewer deaths");

console.log(failed ? "unit: " + failed + " FAILED of " + checks : "unit: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
