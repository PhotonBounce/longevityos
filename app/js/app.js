import { HEADLINE, DISCLAIMER, COMPOUNDS, ITP_NOTE } from "./data.js";
import { RUNGS, strongest, hasRigorousNull, rungLabel, ORGANISM_LABEL } from "./grades.js";
import { EVIDENCE_HEADLINE, EVIDENCE_NOTE, EVIDENCE_RUNGS, HUMAN_EVIDENCE, strongestHuman, hasHumanNull, rungLabelHuman, KIND_LABEL, DESIGN_LABEL, OUTCOME_LABEL } from "./evidence.js";
import { FEED_URL, parseFeed, feedFreshness } from "./feed.js";
import { renderLab } from "./lab.js";

/* The Lab talks to the swarm server that ships beside the app. A page served
 * from photon-bounce.com/longevityos/ finds it at ./api/; QA overrides it. */
const API_BASE = (typeof window !== "undefined" && window.__LOS_API) || "./api/";

/* All dynamic text renders via textContent — nothing from data or the feed is
 * ever parsed as HTML. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = { tab: "atlas", filter: "all", query: "", compound: null, feed: null, feedError: false, evidenceFilter: "all" };
/* A shared link into the Lab (?team=CODE or ?c=ID) opens on the Lab tab. The
 * Lab validates the values itself; this only picks the tab. */
try { if (/[?&](team|c)=/.test(location.search)) state.tab = "lab"; } catch (_) { /* no location, no deep link */ }

/* ————— atlas ————— */

function matches(c) {
  if (state.filter === "itp" && !c.itp) return false;
  if (state.filter === "human" && !c.evidence.some((e) => e.organism.startsWith("human"))) return false;
  if (state.filter === "null" && !hasRigorousNull(c)) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    const hay = [c.name, c.klass, c.what, ...(c.aka || [])].join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderAtlas(root) {
  const banner = el("div", "banner");
  banner.appendChild(el("p", "banner-headline", HEADLINE));
  root.appendChild(banner);

  const controls = el("div", "controls");
  const search = el("input", "search");
  search.type = "search";
  search.placeholder = "Search compounds, classes, mechanisms…";
  search.value = state.query;
  search.addEventListener("input", () => { state.query = search.value; render(); });
  controls.appendChild(search);
  for (const [key, label] of [["all", "All"], ["itp", "ITP-tested"], ["human", "Human data"], ["null", "Has a rigorous null"]]) {
    const b = el("button", "chip" + (state.filter === key ? " chip-on" : ""), label);
    b.addEventListener("click", () => { state.filter = key; render(); });
    controls.appendChild(b);
  }
  root.appendChild(controls);

  const grid = el("div", "grid");
  const shown = COMPOUNDS.filter(matches);
  for (const c of shown) {
    const card = el("button", "card");
    card.setAttribute("data-id", c.id);
    const top = el("div", "card-top");
    top.appendChild(el("span", "card-name", c.name));
    top.appendChild(el("span", "rung rung-" + strongest(c), rungLabel(strongest(c))));
    card.appendChild(top);
    card.appendChild(el("div", "card-class", c.klass));
    card.appendChild(el("p", "card-what", c.what));
    const tags = el("div", "card-tags");
    if (c.itp) tags.appendChild(el("span", "tag tag-itp", "ITP"));
    if (hasRigorousNull(c)) tags.appendChild(el("span", "tag tag-null", "rigorous null on record"));
    card.appendChild(tags);
    card.addEventListener("click", () => { state.compound = c.id; state.tab = "dossier"; render(); });
    grid.appendChild(card);
  }
  if (!shown.length) grid.appendChild(el("p", "empty", "Nothing matches that filter."));
  root.appendChild(grid);
  root.appendChild(el("p", "itp-note", ITP_NOTE));
}

/* ————— dossier ————— */

function renderDossier(root) {
  const c = COMPOUNDS.find((x) => x.id === state.compound) || COMPOUNDS[0];
  const back = el("button", "back", "← Atlas");
  back.addEventListener("click", () => { state.tab = "atlas"; render(); });
  root.appendChild(back);

  const head = el("div", "dossier-head");
  head.appendChild(el("h2", "dossier-name", c.name));
  if (c.aka && c.aka.length) head.appendChild(el("div", "dossier-aka", "also: " + c.aka.join(", ")));
  head.appendChild(el("div", "dossier-class", c.klass));
  head.appendChild(el("span", "rung rung-" + strongest(c), "strongest evidence: " + rungLabel(strongest(c))));
  root.appendChild(head);

  root.appendChild(el("h3", "sect", "What it is"));
  root.appendChild(el("p", "prose", c.what));

  root.appendChild(el("h3", "sect", "Where it stands in humans"));
  root.appendChild(el("p", "prose", c.humanStatus));

  root.appendChild(el("h3", "sect", "The evidence"));
  const table = el("div", "evidence");
  for (const ev of c.evidence) {
    const row = el("div", "ev-row" + (ev.outcome === "null" ? " ev-null" : ""));
    const meta = el("div", "ev-meta");
    meta.appendChild(el("span", "org org-" + ev.organism, ORGANISM_LABEL[ev.organism] || ev.organism));
    meta.appendChild(el("span", "ev-year", String(ev.year)));
    if (ev.outcome === "null") meta.appendChild(el("span", "ev-nulltag", "NULL / CONTRARY"));
    row.appendChild(meta);
    row.appendChild(el("p", "ev-finding", ev.finding));
    const cite = el("a", "ev-cite", ev.cite);
    cite.href = ev.url; cite.target = "_blank"; cite.rel = "noopener";
    row.appendChild(cite);
    table.appendChild(row);
  }
  root.appendChild(table);

  root.appendChild(el("h3", "sect", "Known risks"));
  const ul = el("ul", "risks");
  for (const r of c.risks) ul.appendChild(el("li", "", r));
  root.appendChild(ul);

  root.appendChild(el("h3", "sect", "The honest bottom line"));
  root.appendChild(el("p", "verdict", c.verdict));

  root.appendChild(el("p", "disclaimer", DISCLAIMER));
}

/* ————— ladder ————— */

function renderLadder(root) {
  root.appendChild(el("h2", "sect-title", "The evidence ladder"));
  root.appendChild(el("p", "prose",
    "Every card's badge is computed from its evidence rows — organism and outcome decide the rung, " +
    "nothing else. Read the ladder top-down and notice what sits on the top rung: nothing."));
  for (const r of RUNGS) {
    const row = el("div", "ladder-row");
    row.appendChild(el("span", "rung rung-" + r.key, r.label));
    row.appendChild(el("p", "ladder-blurb", r.blurb));
    root.appendChild(row);
  }
  root.appendChild(el("h3", "sect", "About the ITP"));
  root.appendChild(el("p", "prose", ITP_NOTE));
  root.appendChild(el("p", "disclaimer", DISCLAIMER));
}

/* ————— fresh findings ————— */

function bundledFeed() {
  const entries = [];
  for (const c of COMPOUNDS) for (const ev of c.evidence) {
    entries.push({ title: ev.cite + " — " + ev.finding, journal: "", date: String(ev.year), pmid: "", topic: c.name, url: ev.url });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return entries;
}

function renderFeed(root) {
  root.appendChild(el("h2", "sect-title", "Fresh findings"));
  if (state.feed) {
    const fr = feedFreshness(state.feed, Date.now());
    root.appendChild(el("p", "feed-status" + (fr.stale ? " feed-stale" : ""), "Live literature sweep (PubMed) — " + fr.label + "."));
    for (const e of state.feed.entries) {
      const row = el("div", "feed-row");
      const a = el("a", "feed-title", e.title);
      a.href = e.url; a.target = "_blank"; a.rel = "noopener";
      row.appendChild(a);
      row.appendChild(el("div", "feed-meta", [e.journal, e.date, e.topic].filter(Boolean).join(" · ")));
      root.appendChild(row);
    }
  } else {
    root.appendChild(el("p", "feed-status feed-stale",
      "No live sweep available here — showing the atlas's own citation library instead (bundled with the app, not a live feed)."));
    for (const e of bundledFeed()) {
      const row = el("div", "feed-row");
      const a = el("a", "feed-title", e.title);
      a.href = e.url; a.target = "_blank"; a.rel = "noopener";
      row.appendChild(a);
      row.appendChild(el("div", "feed-meta", [e.date, e.topic].filter(Boolean).join(" · ")));
      root.appendChild(row);
    }
  }
}

/* ————— sources ————— */

function renderSources(root) {
  root.appendChild(el("h2", "sect-title", "Every source in this atlas"));
  root.appendChild(el("p", "prose",
    "Every evidence row links a primary source. The repository's CI re-fetches each of these " +
    "links and checks the article title against the page — a dead or wrong link fails the build."));
  for (const c of COMPOUNDS) {
    root.appendChild(el("h3", "sect", c.name));
    for (const ev of c.evidence) {
      const row = el("div", "src-row");
      const a = el("a", "src-cite", ev.cite + " (" + ev.year + ")");
      a.href = ev.url; a.target = "_blank"; a.rel = "noopener";
      row.appendChild(a);
      root.appendChild(row);
    }
  }
}

/* ————— what has evidence (in people) ————— */

const EV_FILTERS = [["all", "All"], ["rct", "Randomised trials"], ["obs", "Observational"], ["null", "Nulls & harms"]];
const EV_KINDS = ["behaviour", "medical", "diet", "supplement", "environment", "procedure"];
const EV_ORDER = EVIDENCE_RUNGS.map((r) => r.key);

function evidenceMatches(item) {
  const f = state.evidenceFilter;
  const rung = strongestHuman(item);
  if (f === "rct") return rung === "E3" || rung === "E2";
  if (f === "obs") return rung === "E1";
  if (f === "null") return hasHumanNull(item);
  if (f.startsWith("kind:")) return item.kind === f.slice(5);
  return true;
}

function renderEvidence(root) {
  const banner = el("div", "banner ev-banner");
  banner.appendChild(el("p", "banner-headline", EVIDENCE_HEADLINE));
  root.appendChild(banner);
  root.appendChild(el("p", "disclaimer ev-disclaimer", DISCLAIMER));
  root.appendChild(el("p", "prose ev-note", EVIDENCE_NOTE));

  const controls = el("div", "controls ev-controls");
  const chip = (key, label, extra) => {
    const b = el("button", "chip" + (extra ? " " + extra : "") + (state.evidenceFilter === key ? " chip-on" : ""), label);
    b.setAttribute("data-filter", key);
    b.addEventListener("click", () => { state.evidenceFilter = key; render(); });
    controls.appendChild(b);
  };
  for (const [key, label] of EV_FILTERS) chip(key, label, "");
  for (const kind of EV_KINDS) chip("kind:" + kind, KIND_LABEL[kind] || kind, "chip-kind");
  root.appendChild(controls);

  /* E3 first, then E2, E1, E0 — the rung is computed, never typed — then by name */
  const items = HUMAN_EVIDENCE.filter(evidenceMatches).slice().sort((a, b) => {
    const d = EV_ORDER.indexOf(strongestHuman(a)) - EV_ORDER.indexOf(strongestHuman(b));
    return d !== 0 ? d : a.name.localeCompare(b.name);
  });
  const list = el("div", "ev-list");
  for (const item of items) {
    const rung = strongestHuman(item);
    const card = el("article", "ev-card");
    card.setAttribute("data-id", item.id);
    card.setAttribute("data-rung", rung);

    const top = el("div", "card-top ev-top");
    top.appendChild(el("h3", "card-name ev-name", item.name));
    const badge = el("span", "rung ev-rung ev-rung-" + rung, rungLabelHuman(rung));
    badge.setAttribute("data-rung", rung);
    top.appendChild(badge);
    card.appendChild(top);

    const tags = el("div", "card-tags");
    tags.appendChild(el("span", "tag ev-kind ev-kind-" + item.kind, KIND_LABEL[item.kind] || item.kind));
    if (hasHumanNull(item)) tags.appendChild(el("span", "tag tag-null", "null or harm on record"));
    card.appendChild(tags);

    card.appendChild(el("p", "card-what", item.what));
    const who = el("p", "ev-who");
    who.appendChild(el("span", "ev-who-label", "Who was studied: "));
    who.appendChild(el("span", "ev-who-text", item.who));
    card.appendChild(who);

    const rows = el("div", "evidence ev-rows");
    for (const r of item.rows) {
      const isNull = r.outcome === "null" || r.outcome === "harm";
      const row = el("div", "ev-row" + (isNull ? " ev-null" : ""));
      const meta = el("div", "ev-meta");
      meta.appendChild(el("span", "ev-design ev-design-" + r.design, DESIGN_LABEL[r.design] || r.design));
      meta.appendChild(el("span", "ev-outcome ev-outcome-" + r.outcome, OUTCOME_LABEL[r.outcome] || r.outcome));
      meta.appendChild(el("span", "ev-year", String(r.year)));
      if (isNull) meta.appendChild(el("span", "ev-nulltag", "NULL / HARM"));
      row.appendChild(meta);
      row.appendChild(el("p", "ev-finding", r.finding));
      row.appendChild(el("p", "ev-effect", r.effect));
      const cite = el("a", "ev-cite", r.cite);
      cite.href = r.url; cite.target = "_blank"; cite.rel = "noopener";
      row.appendChild(cite);
      rows.appendChild(row);
    }
    card.appendChild(rows);
    card.appendChild(el("p", "caveat", item.caveat));
    list.appendChild(card);
  }
  if (!items.length) list.appendChild(el("p", "empty", "Nothing matches that filter."));
  root.appendChild(list);

  root.appendChild(el("p", "ev-footer",
    "Nothing on this page is advice. Each result belongs to the people the trial enrolled — the trial population " +
    "defines what a number means — and what it means for anyone else is a question for a physician, with this page in hand."));
}

/* ————— shell ————— */

const TABS = [
  ["atlas", "Atlas"], ["evidence", "What has evidence"], ["lab", "The Lab"], ["ladder", "The Ladder"],
  ["feed", "Fresh findings"], ["sources", "Sources"]
];

function render() {
  const nav = $("#nav");
  nav.textContent = "";
  for (const [key, label] of TABS) {
    const b = el("button", "tab" + ((state.tab === key || (key === "atlas" && state.tab === "dossier")) ? " tab-on" : ""), label);
    b.setAttribute("data-tab", key);
    b.addEventListener("click", () => { state.tab = key; render(); });
    nav.appendChild(b);
  }
  const root = $("#view");
  root.textContent = "";
  if (state.tab === "atlas") renderAtlas(root);
  else if (state.tab === "dossier") renderDossier(root);
  else if (state.tab === "evidence") renderEvidence(root);
  else if (state.tab === "lab") renderLab(root, { apiBase: API_BASE });
  else if (state.tab === "ladder") renderLadder(root);
  else if (state.tab === "feed") renderFeed(root);
  else if (state.tab === "sources") renderSources(root);
  window.scrollTo(0, 0);
}

async function loadFeed() {
  try {
    const res = await fetch(FEED_URL, { cache: "no-store" });
    if (!res.ok) return;
    const feed = parseFeed(await res.json());
    if (feed) { state.feed = feed; if (state.tab === "feed") render(); }
  } catch (_) { state.feedError = true; }
}

render();
loadFeed();

/* QA hook — test surface only. */
window.__los = { state, COMPOUNDS, strongest, hasRigorousNull, parseFeed, render, HUMAN_EVIDENCE, strongestHuman };
