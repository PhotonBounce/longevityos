/* verify-sources — every citation is checked against an AUTHORITATIVE source.
 * Runs in CI (needs the open internet); the sandbox that authors this repo
 * cannot reach journals, which is exactly why this exists.
 *
 * Three tiers:
 *   1. PubMed rows      → NCBI E-utilities esummary (batch). The API returns
 *                          the article title for the PMID; a mismatch is
 *                          PROOF of a wrong citation and FAILS the build.
 *   2. ClinicalTrials   → the CT.gov v2 API for the NCT id; mismatch FAILS.
 *   3. Publisher pages  → plain HTML fetch. Journals bot-wall (403s, consent
 *                          shells), so this tier can only VERIFY or WARN —
 *                          an unverifiable page is never assumed correct,
 *                          and never mistaken for proof of error either.
 *
 * Verdict discipline: any API-tier mismatch fails; zero VERIFIED overall
 * fails; warnings are printed and counted, never silently passed. */
import { COMPOUNDS } from "../app/js/data.js";

const norm = (s) => s.toLowerCase().normalize("NFKD")
  .replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const UA = { "user-agent": "LongevityOS-source-verifier/1.0 (+https://github.com/PhotonBounce/longevityos)" };
const rows = [];
for (const c of COMPOUNDS) for (const ev of c.evidence) rows.push({ id: c.id, ev });

let verified = 0, mismatched = 0, unverified = 0;
const report = (icon, id, status, url) => console.log("  " + icon + " " + id + " · " + status + " · " + url);

/* ── tier 1: PubMed via E-utilities ── */
const pubmedRows = rows.filter((r) => /^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/$/.test(r.ev.url));
const pmids = [...new Set(pubmedRows.map((r) => r.ev.url.match(/(\d+)\/$/)[1]))];
let titles = {};
if (pmids.length) {
  const res = await fetch(
    "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=" + pmids.join(","),
    { headers: UA, signal: AbortSignal.timeout(30000) }
  );
  if (!res.ok) { console.error("E-utilities itself unreachable (HTTP " + res.status + ") — cannot verify, failing closed."); process.exit(1); }
  const json = await res.json();
  for (const uid of json?.result?.uids || []) titles[uid] = json.result[uid]?.title || "";
}
for (const { id, ev } of pubmedRows) {
  const pmid = ev.url.match(/(\d+)\/$/)[1];
  const title = titles[pmid];
  if (!title) { mismatched++; report("✗", id, "MISMATCH (PMID " + pmid + " unknown to PubMed)", ev.url); continue; }
  if (norm(title).includes(norm(ev.titleCheck))) { verified++; report("✓", id, "VERIFIED (E-utilities)", ev.url); }
  else { mismatched++; report("✗", id, 'MISMATCH (PubMed title: "' + title + '")', ev.url); }
}

/* ── tier 2: ClinicalTrials.gov via its API ── */
for (const { id, ev } of rows.filter((r) => r.ev.url.startsWith("https://clinicaltrials.gov/study/"))) {
  const nct = ev.url.match(/NCT\d+/)?.[0];
  try {
    const res = await fetch("https://clinicaltrials.gov/api/v2/studies/" + nct, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!res.ok) { unverified++; report("?", id, "UNVERIFIED (CT.gov API " + res.status + ")", ev.url); continue; }
    const body = norm(await res.text());
    if (body.includes(norm(ev.titleCheck))) { verified++; report("✓", id, "VERIFIED (CT.gov API)", ev.url); }
    else { mismatched++; report("✗", id, "MISMATCH (trial record does not mention it)", ev.url); }
  } catch (e) { unverified++; report("?", id, "UNVERIFIED (" + (e.name || "error") + ")", ev.url); }
}

/* ── tier 3: publisher pages — verify or warn, never false-fail ── */
for (const { id, ev } of rows.filter((r) =>
  !/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//.test(r.ev.url) && !r.ev.url.startsWith("https://clinicaltrials.gov/study/"))) {
  try {
    const res = await fetch(ev.url, { headers: { ...UA, accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (res.status === 200 || res.status === 203) {
      const body = norm(await res.text());
      if (body.includes(norm(ev.titleCheck))) { verified++; report("✓", id, "VERIFIED (page)", ev.url); }
      else { unverified++; report("?", id, "UNVERIFIED (page served, title not found — possible bot shell)", ev.url); }
    } else {
      unverified++; report("?", id, "UNVERIFIED (HTTP " + res.status + ")", ev.url);
    }
  } catch (e) { unverified++; report("?", id, "UNVERIFIED (" + (e.name || "error") + ")", ev.url); }
}

console.log(`verify-sources: ${verified} verified, ${mismatched} mismatched, ${unverified} unverified of ${rows.length}`);
if (mismatched > 0) { console.error("MISMATCH against an authoritative API: a citation is wrong — fix the corpus."); process.exit(1); }
if (verified === 0) { console.error("Zero verified sources is a failure, not a pass."); process.exit(1); }
if (unverified > 0) console.log("note: unverified rows are warned, never assumed correct — they recheck on every run.");
process.exit(0);
