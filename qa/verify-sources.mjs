/* verify-sources — fetches every cited URL and checks the article title
 * against the page. Runs in CI (needs the open internet); the sandbox that
 * authors this repo cannot reach journals, which is exactly why this exists.
 *
 * Verdict discipline: VERIFIED / MISMATCH / UNREACHABLE are counted
 * separately. Any MISMATCH fails. Zero VERIFIED fails. UNREACHABLE (a 403
 * from a bot-hostile journal, a timeout) warns — an errored check must never
 * silently count as a pass. */
import { COMPOUNDS } from "../app/js/data.js";

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

let verified = 0, mismatched = 0, unreachable = 0;
const rows = [];
for (const c of COMPOUNDS) for (const ev of c.evidence) rows.push({ id: c.id, ev });

for (const { id, ev } of rows) {
  let status;
  try {
    const res = await fetch(ev.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: { "user-agent": "Mozilla/5.0 (LongevityOS source-verifier; +https://github.com/PhotonBounce/longevityos)" }
    });
    if (res.status === 200) {
      const body = norm(await res.text());
      status = body.includes(norm(ev.titleCheck)) ? "VERIFIED" : "MISMATCH";
    } else {
      status = "UNREACHABLE(" + res.status + ")";
    }
  } catch (e) {
    status = "UNREACHABLE(" + (e.name || "error") + ")";
  }
  if (status === "VERIFIED") verified++;
  else if (status === "MISMATCH") mismatched++;
  else unreachable++;
  console.log((status === "VERIFIED" ? "  ✓ " : status === "MISMATCH" ? "  ✗ " : "  ? ") + id + " · " + status + " · " + ev.url);
}

console.log(`verify-sources: ${verified} verified, ${mismatched} mismatched, ${unreachable} unreachable of ${rows.length}`);
if (mismatched > 0) { console.error("MISMATCH: a citation link does not carry its claimed article — fix the corpus."); process.exit(1); }
if (verified === 0) { console.error("Zero verified sources is a failure, not a pass."); process.exit(1); }
if (unreachable > 0) console.log("note: unreachable sources are warned, never assumed correct — recheck on the next run.");
process.exit(0);
