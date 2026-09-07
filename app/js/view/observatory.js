/* observatory — the Observatory tab (4.0): every instrument the swarm has, in
 * one room. Fifteen figures, each a <figure> built by js/view/charts.js with
 * a headline, an always-open "Read the numbers" table and a <title> on every
 * mark; each redrawn only when its data changes.
 *
 *   1 SWEEP · 2 CONFIRMED PER DAY · 3 THE POOL · 4 SCORE SPECTRUM ·
 *   5 TARGET BOARD · 6 CONSENSUS METER · 7 WITNESSES · 8 INTEGRITY ·
 *   9 PEOPLE · 10 FRESHNESS CLOCKS · 11 FLAG LEDGER ·
 *   12 TEAM BOARD / CONTRIBUTOR BOARD · 13 YOUR SCOPE · 14 SESSION LEDGER ·
 *   15 BANDWIDTH (the host's own meter against its daily budget)
 *
 * WHAT MOVES HERE IS REAL. Every figure is drawn from a server count, a
 * history row, or an event this browser's own client emitted. Nothing counts
 * up, nothing is keyed to a score; the one motion is an LED-bar fill sliding
 * to a number that changed. The server's numbers change only when a poll
 * lands; this browser's numbers change only when its client reports.
 *
 * DIFFERENCED FIGURES READ AGAINST AN ANCHOR. History rows are readings of a
 * rising counter, so SWEEP and CONFIRMED PER DAY print the rise between one
 * reading and the previous one. The reading before the drawn window is the
 * anchor: SWEEP asks for 49 hours and draws 48; the daily bucket's oldest day
 * anchors the 29 after it. A first reading with no earlier one prints
 * "no earlier reading" and counts nothing — it never prints 0 for an hour
 * that did work.
 *
 * THE PAINT IS BUDGETED. paint() draws figures in order until PAINT_BUDGET_MS
 * of wall time has gone, then yields with setTimeout(0) and carries on, so a
 * poll that changes nine figures is never one long task (spec §11: no long
 * task over 80 ms under a 4x CPU throttle). Unchanged figures cost a digest
 * and nothing else, so a call that changes nothing finishes in one go. The
 * mount builds only the room's frame in the click's own task — that task
 * already carries app.js tearing down the tab before — and the figures fill
 * their slots from the next task on, in the same budgeted order.
 *
 * DATA IN. Two doors, both small:
 *   viewObservatory.feed(snapshot)  — {stats, hits, history, historyDay,
 *                                      bandwidth, link} from a store
 *   viewObservatory.session(update) — a swarm-client event (unit, progress,
 *                                      submitted, confirmed, stopped, left,
 *                                      joined), or {type:"record", …} from
 *                                      ?a=me, or {type:"rate", molPerSec}
 *   viewObservatory.pushRate(molPerSec) — figure 13's local sample array
 *
 * TEMP: replaced by viewTelemetry at merge. Until the strip's store is wired
 * to feed(), this module carries its own small poller (stats 15 s, hits 45 s,
 * history 5 min at hours=49 — the extra hour is SWEEP's anchor — plus the
 * daily bucket, If-None-Match, suspended while hidden, backing off after two
 * failures, four times slower when the host says quiet). It runs only while
 * the Observatory is on the page and it never touches ?a=work, ?a=join or any
 * token — it reads, it cannot donate.
 *
 * Every string from the server renders through the charts' sanitisers and
 * textContent; ids are matched against targets.js and never trusted as names.
 */

import { TARGETS } from "../chem/targets.js";
import { viewTelemetry } from "./telemetry.js";
import {
  viewChartInt, viewChartText, viewChartInts, viewChartNum,
  viewChartStepArea, viewChartBars, viewChartDonut, viewChartStacked, viewChartSparkline,
  viewChartLedRows, viewChartReadouts, viewChartBudget
} from "./charts.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ————— the fifteen figures: number, instrument title, what it reads ————— */

export const OBSERVATORY_FIGURES = Object.freeze([
  { n: 1, key: "sweep", title: "SWEEP", reads: "molecules screened per hour, 48 hours, from the history table" },
  { n: 2, key: "confirmed", title: "CONFIRMED PER DAY", reads: "molecules verified per UTC day, 30 days" },
  { n: 3, key: "pool", title: "THE POOL", reads: "the harvested molecules by state" },
  { n: 4, key: "spectrum", title: "SCORE SPECTRUM", reads: "verified hits by score, ten bins of 100" },
  { n: 5, key: "targets", title: "TARGET BOARD", reads: "verified hits by nearest reference target, count only" },
  { n: 6, key: "consensus", title: "CONSENSUS METER", reads: "work units by status" },
  { n: 7, key: "witnesses", title: "WITNESSES", reads: "how many independent browsers agreed on each verified hit" },
  { n: 8, key: "integrity", title: "INTEGRITY", reads: "canary units answered correctly and incorrectly" },
  { n: 9, key: "people", title: "PEOPLE", reads: "contributors seen in the last hour, and 48 hours of readings" },
  { n: 10, key: "clocks", title: "FRESHNESS CLOCKS", reads: "the last harvest, the last verified hit, the last unit issued" },
  { n: 11, key: "flags", title: "FLAG LEDGER", reads: "verified hits with a triage flag reported, none reported, or nothing reported" },
  { n: 12, key: "boards", title: "TEAM BOARD / CONTRIBUTOR BOARD", reads: "the public boards, as credits" },
  { n: 13, key: "scope", title: "YOUR SCOPE", reads: "this browser's molecules per minute, measured on this device — local only" },
  { n: 14, key: "session", title: "SESSION LEDGER", reads: "what this browser's client has reported this session" },
  { n: 15, key: "bandwidth", title: "BANDWIDTH", reads: "bytes the host served per day against its daily budget" }
]);

/* the empty-state sentences — the first four verbatim from the design */
export const OBSERVATORY_EMPTY = Object.freeze({
  sweep: "No screening recorded in this window.",
  pool: "The pool is empty — the harvest runs daily.",
  spectrum: "No verified hits yet.",
  integrity: "No canary units answered yet.",
  confirmed: "No confirmed units recorded in this window.",
  targets: "No verified hits yet — nothing to count per target.",
  consensus: "No work units yet.",
  witnesses: "No verified hits yet — no agreement to count.",
  people: "No readings of active contributors yet.",
  flags: "No verified hits yet — no flags to read.",
  boards: "Nobody is on the boards yet.",
  scope: "No readings yet — nothing has run in this browser this session.",
  bandwidth: "No bandwidth readings yet."
});

const LEGEND = Object.freeze([
  ["phosphor", "this browser"], ["trace", "the server"], ["amber", "attention"], ["rose", "conflict or null"], ["violet", "the reference set"]
]);

const HOURS = 48;                  // drawn; the poll asks for one more as the anchor
const DAYS = 30;                   // the daily bucket's cap; its oldest day is the anchor for the 29 after it
const NO_ANCHOR = "— (no earlier reading)";
const PAINT_BUDGET_MS = 8;         // per task; the check falls after each figure, so one figure may overrun
const WORTH_A_LOOK = 700;          // the lens's own rule: 700 and above prints "worth a look"
const SAMPLES_MAX = 60;
const JSON_MAX = 65536;
const LIVE_MS = 45000;
const QUIET_MS = 300000;
const STALE_AMBER_S = 300;
const STALE_WORD_S = 1800;
const ROOM_REFRESH_MIN_MS = 5000;  // entering the room forces a round only if the strip's last landing is older than this

/* ————— module state (survives tab switches; app.js rebuilds the DOM) ————— */

const store = {
  apiBase: "./api/",
  stats: null, hits: null, history: null, historyDay: null, bandwidth: null,
  reachable: { stats: null, hits: null, history: null },
  lastOkAt: 0,
  quiet: false,
  samples: [],                       // [{t, rate}] molecules per second, this device
  session: {
    running: false, units: 0, confirmed: 0, credits: 0, screened: 0,
    unitTotal: 0, lastDone: 0, lastAt: 0, name: "",
    record: { known: false, name: "", units: 0, credits: 0, team: null }
  },
  ui: null                           // { root, slots:{key: host}, link }
};

const targetNames = (() => {
  const m = {};
  try { for (const t of TARGETS) if (t && typeof t.id === "string") m[t.id] = viewChartText(t.name, 48); } catch (_) { /* names stay empty */ }
  return m;
})();

const nowS = () => Math.floor(Date.now() / 1000);
const attached = () => !!(store.ui && store.ui.root && store.ui.root.isConnected);
const hidden = () => { try { return typeof document !== "undefined" && document.visibilityState === "hidden"; } catch (_) { return false; } };

/* ————— helpers ————— */

function utc(sec, withTime) {
  const s = viewChartInt(sec);
  if (!s) return "never";
  try {
    const iso = new Date(s * 1000).toISOString();
    return withTime ? iso.slice(0, 16).replace("T", " ") + " UTC" : iso.slice(0, 10);
  } catch (_) { return "—"; }
}
function hourLabel(sec) {
  const s = viewChartInt(sec);
  try { return new Date(s * 1000).toISOString().slice(5, 16).replace("T", " ") + "Z"; } catch (_) { return "—"; }
}
function ago(sec) {
  const s = viewChartInt(sec);
  if (!s) return "never";
  const d = Math.max(0, nowS() - s);
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + " min ago";
  if (d < 86400) return Math.floor(d / 3600) + " h " + Math.floor((d % 3600) / 60) + " min ago";
  return Math.floor(d / 86400) + " days ago";
}
function bytesWord(n) {
  const b = viewChartInt(n);
  if (b >= 1073741824) return (Math.round(b / 107374182.4) / 10) + " GB";
  if (b >= 1048576) return (Math.round(b / 104857.6) / 10) + " MB";
  if (b >= 1024) return Math.round(b / 1024) + " KB";
  return b + " B";
}
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const intOf = (o, k) => viewChartInt(obj(o)[k]);

/** The history payload as parallel arrays, every column sanitised and capped. */
function shapeHistory(h) {
  const o = obj(h);
  const hour = viewChartInts(o.hour, 96);
  const cols = {};
  for (const c of ["harvested", "screened", "verified", "contributors", "active", "units_open", "units_confirmed", "conflicts", "results", "rows"]) {
    cols[c] = viewChartInts(o[c], 96);
  }
  return { hour, cols, n: hour.length };
}

/* ————— the figures ————— */

/** The latest reading strictly before `firstHour`, or -1 when the payload has none: the anchor. */
function anchorBefore(h, col, firstHour) {
  let at = -1, reading = -1;
  for (let i = 0; i < h.n; i++) {
    if (h.hour[i] < firstHour && h.hour[i] > at) { at = h.hour[i]; reading = h.cols[col][i] || 0; }
  }
  return reading;
}

function paintSweep(host) {
  const h = shapeHistory(store.history);
  const top = nowS() - (nowS() % 3600);
  const first = top - (HOURS - 1) * 3600;
  const byHour = {};
  for (let i = 0; i < h.n; i++) byHour[h.hour[i]] = i;
  const values = new Array(HOURS).fill(0);
  const rows = [];
  let prev = anchorBefore(h, "screened", first);   // the 49th hour the poll asked for
  let total = 0;
  for (let s = 0; s < HOURS; s++) {
    const hr = first + s * 3600;
    const i = byHour[hr];
    if (i === undefined) continue;
    const reading = h.cols.screened[i] || 0;
    if (prev < 0) { rows.push([hourLabel(hr), NO_ANCHOR]); prev = reading; continue; }
    const rise = Math.max(0, reading - prev);
    values[s] = rise;
    total += rise;
    prev = reading;
    rows.push([hourLabel(hr), viewChartNum(rise)]);
  }
  const partial = byHour[top] !== undefined;
  viewChartStepArea(host, { values, partialLast: partial, unit: "molecules" }, {
    n: 1, title: "SWEEP",
    caption: total ? viewChartNum(total) + " molecules screened in the last 48 hours, as the counter rose between readings." : "Nothing screened in the last 48 hours.",
    note: "Each step is the rise in the screened counter between one hourly reading and the next, anchored on the reading before the window. The current hour is dashed and marked IN PROGRESS.",
    empty: OBSERVATORY_EMPTY.sweep, tableHead: ["hour (UTC)", "screened this hour"], tableRows: rows
  });
}

function paintConfirmed(host) {
  const h = shapeHistory(store.historyDay);
  const today = nowS() - (nowS() % 86400);
  const bars = [];
  const rows = [];
  const n = Math.min(DAYS, h.n);
  /* a full payload's oldest day is the anchor, not a bar: its own rise would need a day the server no longer keeps */
  const start = n >= DAYS ? 1 : 0;
  let prev = start && (h.cols.rows[0] || 0) > 0 ? (h.cols.verified[0] || 0) : -1;
  let total = 0;
  let anyData = false;
  for (let i = start; i < n; i++) {
    const day = h.hour[i];
    const hasRows = (h.cols.rows[i] || 0) > 0;
    const partial = day === today;
    if (hasRows && prev < 0) {
      /* the first reading there is: no earlier one to difference against */
      anyData = true;
      prev = h.cols.verified[i] || 0;
      bars.push({ label: utc(day), value: 0, partial, tone: "trace", title: utc(day) + " — no earlier reading to difference against" + (partial ? " (PARTIAL DAY)" : "") });
      rows.push([utc(day) + (partial ? " (partial day)" : ""), NO_ANCHOR]);
      continue;
    }
    const reading = hasRows ? (h.cols.verified[i] || 0) : prev;
    let rise = 0;
    if (hasRows) { anyData = true; rise = Math.max(0, reading - prev); prev = reading; }
    total += rise;
    bars.push({ label: utc(day), value: rise, partial, tone: "trace",
      title: utc(day) + " — " + viewChartNum(rise) + " verified" + (partial ? " (PARTIAL DAY)" : "") + (hasRows ? "" : " — no reading that day") });
    rows.push([utc(day) + (partial ? " (partial day)" : "") + (hasRows ? "" : " (no reading)"), viewChartNum(rise)]);
  }
  viewChartBars(host, { bars: anyData ? bars : [], partialWord: "PARTIAL DAY", unit: "verified" }, {
    n: 2, title: "CONFIRMED PER DAY",
    caption: anyData ? viewChartNum(total) + " molecules verified over the last " + bars.length + " days; today is outlined as a partial day." : "No daily readings yet.",
    note: "Each bar is the rise in the verified counter since the previous day's reading, anchored on the day before the window. A day with no reading carries the previous reading forward; a zero day is drawn as a one-pixel tick, never left blank.",
    empty: OBSERVATORY_EMPTY.confirmed, tableHead: ["day (UTC)", "verified that day"], tableRows: rows
  });
}

function paintPool(host) {
  const t = obj(obj(store.stats).totals);
  const slices = [
    { label: "pending — waiting for a browser", value: intOf(t, "pending"), tone: "trace" },
    { label: "issued — out with volunteers", value: intOf(t, "issued"), tone: "amber" },
    { label: "verified — two browsers agreed", value: intOf(t, "verified"), tone: "phosphor" },
    { label: "conflict — awaiting a third", value: intOf(t, "conflict"), tone: "rose" }
  ];
  const total = slices.reduce((a, b) => a + b.value, 0);
  viewChartDonut(host, { slices, centre: { value: intOf(t, "pending"), label: "pending" } }, {
    n: 3, title: "THE POOL",
    caption: total ? viewChartNum(total) + " harvested molecules; " + viewChartNum(intOf(t, "pending")) + " still waiting for a browser." : "Nothing in the pool.",
    empty: OBSERVATORY_EMPTY.pool, tableHead: ["state", "molecules"], tableRows: slices.map((s) => [s.label, viewChartNum(s.value)])
  });
}

function paintSpectrum(host) {
  const spec = viewChartInts(obj(store.stats).spectrum, 10);
  const bars = spec.map((v, i) => ({
    label: (i * 100) + "–" + (i === 9 ? "1000" : (i * 100 + 99)), value: v,
    tone: i * 100 >= WORTH_A_LOOK ? "amber" : "trace",
    title: "score " + (i * 100) + " to " + (i === 9 ? 1000 : i * 100 + 99) + " — " + viewChartNum(v) + " verified hits" + (i * 100 >= WORTH_A_LOOK ? " (worth a look)" : "")
  }));
  const total = spec.reduce((a, b) => a + b, 0);
  const above = spec.slice(WORTH_A_LOOK / 100).reduce((a, b) => a + b, 0);
  viewChartBars(host, { bars: total ? bars : [], unit: "hits" }, {
    n: 4, title: "SCORE SPECTRUM",
    caption: total ? viewChartNum(total) + " verified hits by score; " + viewChartNum(above) + " at " + WORTH_A_LOOK + " or above, the bins the lens marks worth a look." : "No scores to bin.",
    note: "Threshold rule: " + WORTH_A_LOOK + " and above is drawn amber and labelled worth a look — a triage cue for a person, not a verdict about any molecule.",
    empty: OBSERVATORY_EMPTY.spectrum, tableHead: ["score bin", "verified hits"], tableRows: bars.map((b) => [b.label, viewChartNum(b.value)])
  });
}

function paintTargets(host) {
  const src = Array.isArray(obj(store.stats).targets) ? obj(store.stats).targets.slice(0, 12) : [];
  const rows = src.map((t) => {
    const id = viewChartText(obj(t).id, 40);
    const name = targetNames[id];
    return { label: name || "", value: intOf(t, "count"), dim: !name, tone: "trace", note: name ? id : "unlisted id" };
  });
  const total = rows.reduce((a, b) => a + b.value, 0);
  viewChartLedRows(host, { rows: total ? rows : [], unit: "hits" }, {
    n: 5, title: "TARGET BOARD",
    caption: total ? viewChartNum(total) + " verified hits across " + rows.length + " nearest targets — a count, not a ranking by score." : "No targets to count.",
    note: "Names come from the reference set in targets.js only; an id the set does not list is shown dim and unlabelled.",
    empty: OBSERVATORY_EMPTY.targets, tableHead: ["target", "id", "verified hits"], tableRows: rows.map((r) => [r.label || "(unlabelled)", r.note, viewChartNum(r.value)])
  });
}

function paintConsensus(host) {
  const u = obj(obj(store.stats).units);
  const segments = [
    { label: "open — awaiting a second volunteer", value: intOf(u, "open"), tone: "trace" },
    { label: "confirmed — two fingerprints matched", value: intOf(u, "confirmed"), tone: "phosphor" },
    { label: "conflict — a third browser settles it", value: intOf(u, "conflict"), tone: "rose" },
    { label: "stale — abandoned, molecules returned to the pool", value: intOf(u, "stale"), tone: "dim", dim: true }
  ];
  const total = segments.reduce((a, b) => a + b.value, 0);
  viewChartStacked(host, { segments }, {
    n: 6, title: "CONSENSUS METER",
    caption: total ? viewChartNum(intOf(u, "confirmed")) + " of " + viewChartNum(total) + " work units confirmed by two independent browsers." : "No work units yet.",
    note: "Two independent volunteers must produce the same fingerprint before a unit counts.",
    empty: OBSERVATORY_EMPTY.consensus, tableHead: ["status", "units"], tableRows: segments.map((s) => [s.label, viewChartNum(s.value)])
  });
}

function paintWitnesses(host) {
  const w = viewChartInts(obj(store.stats).witnesses, 3);
  const labels = ["2 browsers", "3 browsers", "4 or more"];
  const bars = labels.map((l, i) => ({ label: l, value: w[i] || 0, tone: "phosphor", title: l + " agreed — " + viewChartNum(w[i] || 0) + " verified hits" }));
  const total = bars.reduce((a, b) => a + b.value, 0);
  viewChartBars(host, { bars: total ? bars : [], unit: "hits" }, {
    n: 7, title: "WITNESSES",
    caption: total ? "Every verified hit was agreed by at least two independent browsers; " + viewChartNum(total - (w[0] || 0)) + " by three or more." : "No agreement to count yet.",
    empty: OBSERVATORY_EMPTY.witnesses, tableHead: ["independent browsers agreeing", "verified hits"], tableRows: bars.map((b) => [b.label, viewChartNum(b.value)])
  });
}

function paintIntegrity(host) {
  const c = obj(obj(store.stats).canary);
  const okN = intOf(c, "ok"), bad = intOf(c, "bad"), n = okN + bad;
  const pct = n ? ((okN / n) * 100).toFixed(1) : "0.0";
  const items = n ? [
    { label: "canaries answered correctly", value: pct + "%", note: "n = " + viewChartNum(n), tone: bad ? "amber" : "phosphor" },
    { label: "correct", value: viewChartNum(okN), tone: "phosphor" },
    { label: "incorrect", value: viewChartNum(bad), tone: bad ? "rose" : "dim" }
  ] : [];
  viewChartReadouts(host, { items, big: true }, {
    n: 8, title: "INTEGRITY",
    caption: n ? viewChartNum(okN) + " of " + viewChartNum(n) + " canary units were answered with the known fingerprint." : "No canary has been answered yet.",
    note: "A canary is a work unit whose correct fingerprint the server already knows, mixed into the stream unannounced and indistinguishable from ordinary work. A wrong answer to one marks the sender and discards its unverified work; a right answer is credited like any other unit.",
    empty: OBSERVATORY_EMPTY.integrity, tableHead: ["reading", "value"],
    tableRows: [["correct", viewChartNum(okN)], ["incorrect", viewChartNum(bad)], ["answered", viewChartNum(n)], ["correct share", n ? pct + "%" : "—"]]
  });
}

function paintPeople(host) {
  const h = shapeHistory(store.history);
  const top = nowS() - (nowS() % 3600);
  const byHour = {};
  for (let i = 0; i < h.n; i++) byHour[h.hour[i]] = i;
  const values = new Array(HOURS).fill(-1);
  let n = 0, sum = 0, peak = -1, peakAt = 0, low = -1, lowAt = 0;
  for (let s = 0; s < HOURS; s++) {
    const hr = top - (HOURS - 1 - s) * 3600;
    const i = byHour[hr];
    if (i === undefined) continue;
    const v = h.cols.active[i] || 0;
    values[s] = v;
    n++; sum += v;
    if (peak < 0 || v > peak) { peak = v; peakAt = hr; }
    if (low < 0 || v < low) { low = v; lowAt = hr; }
  }
  const active = intOf(obj(store.stats).totals, "active_1h");
  const known = store.stats !== null;
  const rows = [["active in the last hour", known ? viewChartNum(active) : "—"]];
  if (n) {
    rows.push(["48-hour peak reading", viewChartNum(peak) + " at " + hourLabel(peakAt)]);
    rows.push(["48-hour lowest reading", viewChartNum(low) + " at " + hourLabel(lowAt)]);
    rows.push(["mean of the readings", String(Math.round((sum / n) * 10) / 10)]);
    rows.push(["hourly readings in the window", viewChartNum(n) + " of " + HOURS]);
  }
  viewChartSparkline(host, { values: n ? values : [], big: { value: known ? viewChartNum(active) : "—", label: "active in the last hour", tone: "trace" }, tone: "trace", unit: "contributors" }, {
    n: 9, title: "PEOPLE",
    caption: known ? viewChartNum(active) + " contributors seen in the last hour" + (n ? "; the 48-hour peak reading was " + viewChartNum(peak) + "." : ".") : "No reading of active contributors yet.",
    empty: OBSERVATORY_EMPTY.people, tableHead: ["reading", "contributors"], tableRows: rows
  });
}

function paintClocks(host) {
  const c = obj(obj(store.stats).clocks);
  const defs = [["harvest", "last molecule harvested"], ["verified", "last hit verified"], ["issued", "last unit issued"]];
  const items = defs.map(([k, label]) => {
    const t = intOf(c, k);
    const age = t ? nowS() - t : -1;
    const tone = !t ? "dim" : age > STALE_AMBER_S ? "amber" : "phosphor";
    return { label, value: ago(t), note: utc(t, true), tone, word: t && age > STALE_WORD_S ? "stale" : "" };
  });
  const known = store.stats !== null;
  viewChartReadouts(host, { items: known ? items : [] }, {
    n: 10, title: "FRESHNESS CLOCKS",
    caption: known ? "Relative and absolute UTC times; amber past five minutes, the word stale past thirty." : "No clocks until the server answers.",
    empty: "No clocks until the server answers.", tableHead: ["clock", "relative", "absolute (UTC)"],
    tableRows: items.map((i) => [i.label, i.value + (i.word ? " — " + i.word : ""), i.note])
  });
}

function paintFlags(host) {
  const hits = Array.isArray(obj(store.hits).hits) ? obj(store.hits).hits.slice(0, 50) : [];
  let alert = 0, none = 0, unreported = 0;
  for (const h of hits) {
    const f = obj(h).flags;
    if (Array.isArray(f)) { if (f.length) alert++; else none++; } else unreported++;
  }
  const segments = [
    { label: "alert reported — a triage flag for a person to look at", value: alert, tone: "amber" },
    { label: "none reported — the record lists no flag", value: none, tone: "trace" },
    { label: "not reported — the record's flags could not be read (null, not an empty list)", value: unreported, tone: "dim", dim: true }
  ];
  const total = alert + none + unreported;
  viewChartStacked(host, { segments }, {
    n: 11, title: "FLAG LEDGER",
    caption: total ? viewChartNum(alert) + " of " + viewChartNum(total) + " listed hits carry a triage flag; " + viewChartNum(unreported) + " report nothing either way." : "No listed hits to read.",
    note: "A flag marks a molecule for a person to look at; the screen has measured nothing about what any of it means in a living thing. Not reported is not the same as none reported: the server sends null when a stored record cannot be read, and an empty list only when the record itself lists nothing.",
    empty: OBSERVATORY_EMPTY.flags, tableHead: ["band", "hits"], tableRows: segments.map((s) => [s.label, viewChartNum(s.value)])
  });
}

function paintBoards(host) {
  const st = obj(store.stats);
  const teams = Array.isArray(st.teams) ? st.teams.slice(0, 10) : [];
  const board = Array.isArray(st.leaderboard) ? st.leaderboard.slice(0, 10) : [];   // the top ten; the Lab's board carries twenty
  const rec = store.session.record;
  const ownTeam = rec.team && typeof rec.team === "object" ? viewChartText(rec.team.code, 8) : "";
  const ownName = rec.known ? viewChartText(rec.name, 24) : "";
  const rows = [];
  let onBoard = false;
  for (const t of teams) {
    const code = viewChartText(obj(t).code, 8);
    const isOwn = !!ownTeam && code === ownTeam;
    rows.push({ label: viewChartText(obj(t).name, 24) || "team", value: intOf(t, "credits"), note: viewChartNum(intOf(t, "members")) + " members · team " + code, tone: isOwn ? "phosphor" : "violet", pinned: isOwn, word: isOwn ? "YOUR TEAM" : "" });
  }
  /* Which board row is this visitor? The server gives one signal — the display
   * name, which is not unique — and the board and the ?a=me record come from
   * different polls, so their credits can disagree for a poll interval after a
   * unit confirms. Exact name+credits wins; failing that, a name carried by
   * exactly one row is pinned and its fresher record credits printed beside
   * it; only a name absent from the board gets an extra row, worded as such. */
  const boardNames = board.map((r) => viewChartText(obj(r).name, 24) || "anonymous");
  const ownIsName = !!ownName && ownName !== "anonymous";
  let ownIndex = ownIsName ? board.findIndex((r, i) => boardNames[i] === ownName && intOf(r, "credits") === rec.credits) : -1;
  if (ownIndex < 0 && ownIsName && boardNames.filter((nm) => nm === ownName).length === 1) ownIndex = boardNames.indexOf(ownName);
  board.forEach((r, i) => {
    const isOwn = i === ownIndex;
    if (isOwn) onBoard = true;
    const credits = intOf(r, "credits");
    const lag = isOwn && credits !== rec.credits ? " · record: " + viewChartNum(rec.credits) : "";
    rows.push({ label: boardNames[i], value: credits, note: viewChartNum(intOf(r, "units")) + " units" + lag, tone: isOwn ? "phosphor" : "trace", pinned: isOwn, word: isOwn ? "you" : "" });
  });
  if (rec.known && !onBoard) {
    const shared = ownIsName && boardNames.includes(ownName);
    rows.push({ label: ownName || "anonymous", value: rec.credits, note: viewChartNum(rec.units) + " units · " + (shared ? "your record; a row above shares your name" : "your record; not shown in the top ten"), tone: "phosphor", pinned: true, word: "you" });
  }
  viewChartLedRows(host, { rows, unit: "credits" }, {
    n: 12, title: "TEAM BOARD / CONTRIBUTOR BOARD",
    caption: rows.length ? viewChartNum(teams.length) + " teams and " + viewChartNum(board.length) + " contributors on the public boards, by credits." : "The boards are empty.",
    note: "Credits count verified units — work, never luck. Your own row is pinned and says so in words; the board is a server reading and can trail your record by one poll.",
    empty: OBSERVATORY_EMPTY.boards, tableHead: ["row", "credits"],
    tableRows: rows.map((r) => [r.label + " · " + r.note + (r.word ? " — " + r.word : ""), viewChartNum(r.value)])
  });
}

function paintScope(host) {
  const samples = store.samples.slice(-SAMPLES_MAX);
  const perMin = samples.map((s) => Math.round(s.rate * 60));
  const sorted = perMin.slice().sort((a, b) => a - b);
  const latest = perMin.length ? perMin[perMin.length - 1] : 0;
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const peak = sorted.length ? sorted[sorted.length - 1] : 0;
  viewChartSparkline(host, { values: perMin, big: { value: perMin.length ? viewChartNum(latest) : "—", label: "molecules per minute, this device", tone: "phosphor" }, tone: "phosphor", unit: "per minute" }, {
    n: 13, title: "YOUR SCOPE",
    caption: perMin.length ? viewChartNum(latest) + " molecules a minute at the last reading; " + perMin.length + " readings this session." : "Nothing is running in this browser.",
    note: "MEASURED ON THIS DEVICE — LOCAL ONLY. Sixty readings at most, taken from this browser's own progress events; nothing here comes from the server.",
    empty: OBSERVATORY_EMPTY.scope, tableHead: ["reading", "molecules per minute"],
    tableRows: [["latest", perMin.length ? viewChartNum(latest) : "—"], ["median", perMin.length ? viewChartNum(median) : "—"], ["peak", perMin.length ? viewChartNum(peak) : "—"], ["readings", viewChartNum(perMin.length)]]
  });
}

function paintSession(host) {
  const s = store.session;
  const items = [
    { label: "units submitted", value: viewChartNum(s.units), tone: "phosphor" },
    { label: "confirmed by a second volunteer", value: viewChartNum(s.confirmed), tone: "phosphor" },
    { label: "credits this session", value: viewChartNum(s.credits), tone: "phosphor" },
    { label: "molecules screened this session", value: viewChartNum(s.screened), tone: "phosphor" }
  ];
  const rec = s.record;
  viewChartReadouts(host, { items, big: true }, {
    n: 14, title: "SESSION LEDGER",
    caption: s.running ? "Running — this browser's client is screening now." : s.units ? "Stopped — the readings below are this session's." : "Nothing has run in this browser this session.",
    note: rec.known ? "On the record for this token: " + viewChartNum(rec.units) + " verified units, " + viewChartNum(rec.credits) + " credits" + (rec.team && rec.team.name ? ", team " + viewChartText(rec.team.name, 24) : "") + "." : "Counts come from this browser's own client events; the public record joins them once the server answers ?a=me.",
    tableHead: ["reading", "value"], tableRows: items.map((i) => [i.label, i.value]).concat(rec.known ? [["on the record — verified units", viewChartNum(rec.units)], ["on the record — credits", viewChartNum(rec.credits)]] : [])
  });
}

function paintBandwidth(host) {
  const bw = obj(store.bandwidth);
  const days = Array.isArray(bw.days) ? bw.days.slice(0, 14) : [];
  const budget = intOf(bw, "budget_bytes");
  const today = intOf(bw, "today_bytes");
  const quiet = bw.quiet === true || (budget > 0 && today > budget);
  const bars = days.map((d) => {
    const day = viewChartText(obj(d).day, 10), bytes = intOf(d, "bytes");
    return { label: day, value: bytes, title: day + " — " + bytesWord(bytes) + " (" + viewChartNum(bytes) + " bytes)" + (budget && bytes > budget ? " — over the budget" : "") };
  });
  viewChartBudget(host, { bars, line: budget ? { value: budget, label: "daily budget " + bytesWord(budget) } : null, word: "QUIET", over: quiet }, {
    n: 15, title: "BANDWIDTH",
    tone: quiet ? "amber" : undefined,
    caption: days.length
      ? "The host served " + bytesWord(today) + " of JSON today against a daily budget of " + bytesWord(budget) + (quiet ? " — over it, so every client is asked to be QUIET and polls four times slower." : ".")
      : "No bandwidth readings from the host yet.",
    note: "Every JSON body the API sends is counted by its length; the owner asked to watch this host's bandwidth, so it is plainly on the page.",
    empty: OBSERVATORY_EMPTY.bandwidth, tableHead: ["day (UTC)", "bytes"],
    tableRows: bars.map((b) => [b.label + (budget && b.value > budget ? " — over budget" : ""), viewChartNum(b.value)]).concat([["daily budget", viewChartNum(budget)], ["today so far" + (quiet ? " — QUIET" : ""), viewChartNum(today)]])
  });
}

const PAINTERS = {
  sweep: paintSweep, confirmed: paintConfirmed, pool: paintPool, spectrum: paintSpectrum, targets: paintTargets,
  consensus: paintConsensus, witnesses: paintWitnesses, integrity: paintIntegrity, people: paintPeople, clocks: paintClocks,
  flags: paintFlags, boards: paintBoards, scope: paintScope, session: paintSession, bandwidth: paintBandwidth
};

/* ————— the room ————— */

function linkState() {
  if (!store.lastOkAt) return store.reachable.stats === false ? "NO LINK" : "WAITING";
  const age = Date.now() - store.lastOkAt;
  if (store.quiet) return "QUIET";
  if (age <= LIVE_MS) return "LIVE";
  if (age <= QUIET_MS) return "QUIET";
  return "NO LINK";
}

function paintLink() {
  if (!attached()) return;
  const link = store.ui.link;
  const state = linkState();
  const text = state + (store.lastOkAt ? " — last reading " + ago(Math.floor(store.lastOkAt / 1000)) : " — no reading from the server yet") + (store.quiet ? " — the host asked for quiet, so polling is four times slower" : "");
  if (link.textContent !== text) link.textContent = text;
  const cls = "obs-link obs-link-" + state.toLowerCase().replace(/\s+/g, "-");
  if (link.className !== cls) link.className = cls;
}

const clock = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
const brush = { cursor: 0, timer: null };

/** Draw figures from the cursor until the budget is spent; yield and resume if any remain. */
function paintSome() {
  brush.timer = null;
  if (!attached()) { brush.cursor = 0; return; }
  const started = clock();
  while (brush.cursor < OBSERVATORY_FIGURES.length) {
    const f = OBSERVATORY_FIGURES[brush.cursor++];
    const host = store.ui.slots[f.key];
    if (host) {
      try { PAINTERS[f.key](host); } catch (_) { /* a figure that will not draw leaves the others alone */ }
    }
    if (brush.cursor < OBSERVATORY_FIGURES.length && clock() - started > PAINT_BUDGET_MS) {
      brush.timer = setTimeout(paintSome, 0);
      return;
    }
  }
  brush.cursor = 0;
  paintLink();
}

/** The same paint, starting in the next task rather than this one. */
function paintSoon() {
  if (brush.timer !== null) clearTimeout(brush.timer);
  brush.cursor = 0;
  brush.timer = setTimeout(paintSome, 0);
}

/** Redraw every figure whose data changed — in one task when cheap, across tasks when not. */
function paint() {
  if (!attached()) return;
  if (brush.timer !== null) { clearTimeout(brush.timer); brush.timer = null; }
  brush.cursor = 0;            // data may have changed for any figure: start over (unchanged ones cost a digest)
  paintSome();
}

/**
 * Mount the Observatory into `root`. Rebuilt by app.js on every tab click;
 * the data lives in the module, so the figures return at once.
 */
export function viewObservatory(root, options) {
  if (!root || typeof root.appendChild !== "function") return null;
  const opts = options && typeof options === "object" ? options : {};
  if (typeof opts.apiBase === "string" && opts.apiBase) store.apiBase = opts.apiBase;

  const wrap = el("section", "obs");
  wrap.setAttribute("data-obs", "room");
  const head = el("div", "obs-head");
  head.appendChild(el("h2", "sect-title", "Observatory"));
  head.appendChild(el("p", "prose obs-lede",
    "Every instrument the swarm has, in one room. Molecules screened each hour, how much of the pool is left, how scores are distributed, " +
    "how often two volunteers agreed — and how often they did not. Every chart has its numbers printed underneath, and nothing here moves unless a number changed."));
  const key = el("ul", "obs-key");
  for (const [t, word] of LEGEND) {
    const li = el("li", "obs-key-item obs-tone-" + t);
    li.appendChild(el("i", "obs-swatch"));
    li.appendChild(el("span", "obs-key-word", t + " = " + word));
    key.appendChild(li);
  }
  head.appendChild(key);
  const link = el("p", "obs-link", "WAITING");
  link.setAttribute("data-obs", "link");
  head.appendChild(link);
  wrap.appendChild(head);

  const grid = el("div", "obs-grid");
  const slots = {};
  for (const f of OBSERVATORY_FIGURES) {
    const slot = el("div", "obs-slot obs-slot-" + f.key);
    slot.setAttribute("data-fig", String(f.n));
    slot.setAttribute("data-key", f.key);
    slots[f.key] = slot;
    grid.appendChild(slot);
  }
  wrap.appendChild(grid);
  wrap.appendChild(el("p", "obs-foot",
    "Reads only: this page shows the public counts the strip already polls, and never asks for work, never joins, and never sends a token. " +
    "Nothing on it is a finding about any molecule; the screen produces a shortlist of hypotheses for people who do this for a living."));
  root.appendChild(wrap);

  store.ui = { root: wrap, slots, link };
  paintSoon();      // the figures land from the next task on; the click's task is app.js's
  subscribeStore(); // the strip's store is the app's only poller; this room only reads it
  return wrap;
}

/* ————— data in ————— */

/** A store snapshot: {stats, hits, history, historyDay, bandwidth, link:{lastOkAt, quiet}}. */
viewObservatory.feed = function feed(snapshot) {
  const s = obj(snapshot);
  if ("stats" in s) { store.stats = obj(s.stats); if (s.stats && typeof s.stats.quiet === "boolean") store.quiet = s.stats.quiet; }
  if ("hits" in s) store.hits = obj(s.hits);
  if ("history" in s) store.history = obj(s.history);
  if ("historyDay" in s) store.historyDay = obj(s.historyDay);
  if ("bandwidth" in s) store.bandwidth = obj(s.bandwidth);
  else if (s.historyDay && obj(s.historyDay).bandwidth) store.bandwidth = obj(obj(s.historyDay).bandwidth);
  else if (s.history && obj(s.history).bandwidth) store.bandwidth = obj(obj(s.history).bandwidth);
  if (s.link && typeof s.link === "object") {
    if (typeof s.link.lastOkAt === "number" && Number.isFinite(s.link.lastOkAt)) store.lastOkAt = Math.max(0, s.link.lastOkAt);
    if (typeof s.link.quiet === "boolean") store.quiet = s.link.quiet;
  }
  paint();
};

/** Figure 13: one reading of this device's molecules per second. */
viewObservatory.pushRate = function pushRate(molPerSec) {
  if (typeof molPerSec !== "number" || !Number.isFinite(molPerSec) || molPerSec < 0) return;
  store.samples.push({ t: Date.now(), rate: Math.min(1e6, molPerSec) });
  if (store.samples.length > SAMPLES_MAX) store.samples.splice(0, store.samples.length - SAMPLES_MAX);
  paint();
};

/** Figure 14 (and 12, 13): a swarm-client event, a ?a=me record, or a rate. */
viewObservatory.session = function session(update) {
  const ev = obj(update);
  const s = store.session;
  const type = typeof ev.type === "string" ? ev.type : "";
  const now = Date.now();
  if (type === "unit") {
    s.running = true;
    s.unitTotal = viewChartInt(ev.total, 100000);
    s.lastDone = 0;
    s.lastAt = now;
  } else if (type === "progress") {
    const done = viewChartInt(ev.done, 100000);
    if (done < s.lastDone) { s.lastDone = done; s.lastAt = now; }
    else if (s.lastAt && now - s.lastAt >= 1000) {
      viewObservatory.pushRate((done - s.lastDone) / ((now - s.lastAt) / 1000));
      s.lastDone = done;
      s.lastAt = now;
    }
    if (ev.total !== undefined) s.unitTotal = viewChartInt(ev.total, 100000) || s.unitTotal;
    return;   // nothing on the page reads progress except YOUR SCOPE, and pushRate() paints when it takes a sample
  } else if (type === "submitted") {
    if (typeof ev.units === "number") s.units = viewChartInt(ev.units, 1e9);
    if (typeof ev.credits === "number") s.credits = viewChartInt(ev.credits, 1e9);
    if (ev.accepted !== false) s.screened += s.unitTotal;
  } else if (type === "confirmed") {
    if (typeof ev.confirmed === "number") s.confirmed = viewChartInt(ev.confirmed, 1e9); else s.confirmed++;
    if (typeof ev.credits === "number") s.credits = viewChartInt(ev.credits, 1e9);
  } else if (type === "stopped") {
    s.running = false;
    s.lastAt = 0;
  } else if (type === "left") {
    s.running = false; s.units = 0; s.confirmed = 0; s.credits = 0; s.screened = 0; s.name = "";
    s.record = { known: false, name: "", units: 0, credits: 0, team: null };
  } else if (type === "joined") {
    s.name = viewChartText(ev.name, 24);
  } else if (type === "record") {
    const team = ev.team && typeof ev.team === "object" ? { code: viewChartText(ev.team.code, 8), name: viewChartText(ev.team.name, 24) } : null;
    s.record = { known: ev.known !== false, name: viewChartText(ev.name, 24), units: viewChartInt(ev.units, 1e9), credits: viewChartInt(ev.credits, 1e9), team };
  } else if (type === "rate") {
    viewObservatory.pushRate(ev.molPerSec);
    return;
  } else {
    return;
  }
  paint();
};

/* ————— data in: the telemetry store (the app's only poller) ————— */

let unsubscribe = null;

function feedFromStore(snap) {
  const sn = obj(snap);
  store.reachable = {
    stats: sn.statsReachable !== false,
    hits: sn.hitsReachable !== false,
    history: sn.historyReachable !== false && sn.historyMissing !== true
  };
  viewObservatory.feed({
    stats: sn.stats, hits: sn.hits, history: sn.history, historyDay: sn.historyDay,
    link: { lastOkAt: typeof sn.lastOkAt === "number" ? sn.lastOkAt : 0, quiet: sn.quiet === true }
  });
}

const FEED_KINDS = { stats: 1, hits: 1, history: 1, historyDay: 1, link: 1, pause: 1, visibility: 1 };

function subscribeStore() {
  if (unsubscribe !== null) { feedFromStore(viewTelemetry.snapshot()); return; }
  unsubscribe = viewTelemetry.subscribe((snap, ev) => {
    if (!attached()) { unsubscribeStore(); return; }
    if (ev && FEED_KINDS[ev.kind]) feedFromStore(snap);
  });
  const snap = viewTelemetry.snapshot();
  feedFromStore(snap);
  /* a fresh reading for a fresh room — refresh() re-polls stats and hits; the
   * five-minute endpoints keep their own cadence (a room re-entered a hundred
   * times must not make a hundred history requests). And not even those two
   * when the strip landed a poll within the last five seconds: during a run
   * the Lab already forces a round every five seconds, so a room re-entered
   * thirty times in two seconds costs one request, not thirty — a visitor
   * must never be able to rate-limit themselves out of the swarm by
   * fidgeting (probe-churn, 4.0). */
  const landed = snap && typeof snap.lastOkAt === "number" && snap.lastOkAt > 0 ? snap.lastOkAt : 0;
  if (landed && Date.now() - landed < ROOM_REFRESH_MIN_MS) return;
  try { const r = viewTelemetry.refresh(); if (r && typeof r.then === "function") r.then(feedFromStore).catch(() => {}); } catch (_) { /* the store is optional in QA */ }
}
function unsubscribeStore() {
  if (unsubscribe !== null) { try { unsubscribe(); } catch (_) {} unsubscribe = null; }
}
const subscribed = () => unsubscribe !== null && attached();

/* QA hook — a test surface only: it reads, it feeds, it never donates. */
try {
  if (typeof window !== "undefined") {
    window.__losObs = {
      paint,
      feed: viewObservatory.feed,
      session: viewObservatory.session,
      pushRate: viewObservatory.pushRate,
      figures: OBSERVATORY_FIGURES,
      empty: OBSERVATORY_EMPTY,
      snapshot: () => ({
        link: linkState(), quiet: store.quiet, lastOkAt: store.lastOkAt, samples: store.samples.length,
        session: JSON.parse(JSON.stringify(store.session)), reachable: Object.assign({}, store.reachable),
        polling: subscribed(), hasStats: !!store.stats, hasHistory: !!store.history, hasDay: !!store.historyDay,
        painting: brush.timer !== null
      })
    };
  }
} catch (_) { /* no window, no hook */ }
