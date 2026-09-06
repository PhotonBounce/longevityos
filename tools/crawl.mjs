/* crawl — the literature sweep. Runs on a scheduled GitHub runner (the
 * authoring sandbox has no route to PubMed). Fetches recent papers per topic
 * from PubMed E-utilities, validates everything through the app's OWN feed
 * parser, and writes data/feed.json. On any failure the old feed stays —
 * stale beats fabricated.
 *
 *   node tools/crawl.mjs             live sweep (network)
 *   node tools/crawl.mjs --selftest  parses qa/fixtures/esummary.json, no network
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseFeed } from "../app/js/feed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "data", "feed.json");

const TOPICS = [
  { topic: "rapamycin", term: "rapamycin AND (aging OR lifespan) NOT cancer[ti]" },
  { topic: "senolytics", term: "senolytic AND (aging OR senescence)" },
  { topic: "ITP", term: '"interventions testing program" AND lifespan' },
  { topic: "NAD+", term: "(nicotinamide riboside OR nicotinamide mononucleotide) AND aging AND trial" },
  { topic: "metformin", term: "metformin AND aging AND (trial OR lifespan)" },
  { topic: "taurine", term: "taurine AND aging" },
  { topic: "glycine", term: "glycine supplementation AND (lifespan OR aging) NOT \"Glycine max\"" },
  { topic: "spermidine", term: "spermidine AND (aging OR autophagy) AND (trial OR lifespan)" }
];

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

function summaryToEntries(json, topic) {
  const out = [];
  const uids = json?.result?.uids || [];
  for (const uid of uids) {
    const r = json.result[uid];
    if (!r || typeof r.title !== "string") continue;
    out.push({
      pmid: String(uid),
      title: r.title.replace(/\s+/g, " ").trim(),
      journal: typeof r.fulljournalname === "string" ? r.fulljournalname : "",
      date: typeof r.sortpubdate === "string" ? r.sortpubdate.slice(0, 10).replace(/\//g, "-") : "",
      topic
    });
  }
  return out;
}

if (process.argv.includes("--selftest")) {
  const fixture = JSON.parse(readFileSync(join(HERE, "..", "qa", "fixtures", "esummary.json"), "utf8"));
  const entries = summaryToEntries(fixture, "ITP");
  if (entries.length !== 2) { console.error("selftest: expected 2 entries, got " + entries.length); process.exit(1); }
  const feed = parseFeed({ fetched_at: new Date().toISOString(), entries });
  if (!feed || feed.entries.length !== 2) { console.error("selftest: app parser rejected crawler output"); process.exit(1); }
  console.log("crawl --selftest: crawler output round-trips through the app's own parser ✓");
  process.exit(0);
}

const get = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.json();
};

const all = [];
for (const { topic, term } of TOPICS) {
  try {
    const q = EUTILS + "/esearch.fcgi?db=pubmed&retmode=json&retmax=6&sort=date&reldate=90&datetype=edat&term=" + encodeURIComponent(term);
    const search = await get(q);
    const ids = search?.esearchresult?.idlist || [];
    if (!ids.length) continue;
    const sum = await get(EUTILS + "/esummary.fcgi?db=pubmed&retmode=json&id=" + ids.join(","));
    all.push(...summaryToEntries(sum, topic));
    await new Promise((r) => setTimeout(r, 400)); // be a polite E-utilities citizen
  } catch (e) {
    console.error("topic '" + topic + "' failed: " + e.message + " (continuing)");
  }
}

const seen = new Set();
const entries = all.filter((e) => !seen.has(e.pmid) && seen.add(e.pmid))
  .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);

const candidate = { fetched_at: new Date().toISOString(), entries };
const parsed = parseFeed(candidate);
if (!parsed || parsed.entries.length < 3) {
  console.error("Sweep produced too little (" + (parsed ? parsed.entries.length : 0) + " entries) — keeping the existing feed. Stale beats fabricated.");
  process.exit(0);
}
writeFileSync(OUT, JSON.stringify(candidate, null, 2) + "\n");
console.log("feed.json written: " + parsed.entries.length + " entries across " + new Set(entries.map((e) => e.topic)).size + " topics");
