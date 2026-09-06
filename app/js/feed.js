/* Fresh findings — the part of the atlas that keeps researching.
 * data/feed.json is written by tools/crawl.mjs on a scheduled runner (PubMed
 * E-utilities). The BUNDLED_FEED below is the honest fallback: it is the
 * atlas's own citation library, labeled as such — a bundled library is never
 * dressed up as a live sweep (the reruns-labeled-as-reruns rule). */

export const FEED_URL = "../data/feed.json";
export const FEED_STALE_DAYS = 14;

export function parseFeed(json) {
  if (!json || typeof json !== "object") return null;
  if (typeof json.fetched_at !== "string" || !Array.isArray(json.entries)) return null;
  const t = Date.parse(json.fetched_at);
  if (Number.isNaN(t)) return null;
  const entries = [];
  for (const e of json.entries.slice(0, 100)) {
    if (!e || typeof e !== "object") continue;
    const title = typeof e.title === "string" ? e.title.slice(0, 300) : "";
    const journal = typeof e.journal === "string" ? e.journal.slice(0, 120) : "";
    const date = typeof e.date === "string" ? e.date.slice(0, 20) : "";
    const pmid = typeof e.pmid === "string" && /^\d{1,9}$/.test(e.pmid) ? e.pmid : "";
    const topic = typeof e.topic === "string" ? e.topic.slice(0, 60) : "";
    if (!title || !pmid) continue;
    entries.push({ title, journal, date, pmid, topic, url: "https://pubmed.ncbi.nlm.nih.gov/" + pmid + "/" });
  }
  if (!entries.length) return null;
  return { fetchedAt: t, entries };
}

export function feedFreshness(feed, now) {
  const days = Math.floor((now - feed.fetchedAt) / 86400000);
  if (days <= 1) return { days, label: "swept within the last day" };
  if (days <= FEED_STALE_DAYS) return { days, label: "last sweep " + days + " days ago" };
  return { days, label: "STALE — last successful sweep " + days + " days ago", stale: true };
}
