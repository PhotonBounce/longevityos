/* lab — the live face of the swarm.
 *
 * WHAT THIS TAB IS. Three honest things at once: an explainer, a control panel
 * for donating this browser's spare CPU, and a scoreboard of what the swarm has
 * produced so far. The scoreboard's output is a RANKED SHORTLIST OF HYPOTHESES
 * for researchers to look at — it is not a discovery, not a drug, not medical
 * advice, and nothing in it has been tested in a living thing.
 *
 * EVERY STRING ON THIS PAGE THAT CAME FROM THE SERVER IS UNTRUSTED. Leaderboard
 * names are typed by strangers; formulas, targets and flags are assembled by a
 * server this page does not control. So: createElement + textContent only (no
 * markup sink is used anywhere in this file), lengths capped, control
 * characters stripped, and the one external link on the page (PubChem) is
 * built ONLY from a compound id that
 * matched /^[0-9]{1,12}$/. A link built out of unvalidated server text is an
 * open redirect waiting to happen.
 *
 * NO SERVER IS A SUPPORTED STATE. LongevityOS is an evidence atlas first; the
 * swarm is an extra. Every request here collapses to { ok:false } and the tab
 * degrades to an honest "the swarm server is not reachable from here" panel
 * rather than a broken page or a spinner that never stops.
 *
 * CONSENT. Nothing in this file starts using anyone's CPU. The swarm client is
 * not even constructed until the visitor presses Donate, and what donating
 * costs is spelled out before the first press.
 */

import { createSwarmClient } from "./swarm/client.js";

/* ————— style conventions, borrowed from app.js verbatim ————— */

const labEl = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const POLL_MS = 15000;
const REQUEST_MS = 12000;
const MAX_BODY = 262144;
const HITS_LIMIT = 20;
const BOARD_LIMIT = 20;
const NAME_MAX = 24;         // visible cap on another person's chosen name
const FIELD_MAX = 48;        // visible cap on any other server string
const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/compound/";
const CID_RE = /^[0-9]{1,12}$/;

const OFFLINE_MSG = "The swarm server is not reachable from here. " +
  "The atlas itself works with no server at all — this panel is the only thing that needs one.";

/* ————— module state: one client, one poller, however many renders ————— */

/* app.js re-renders the whole view on every tab click, so this tab is built
 * from scratch each time it is opened. The donation itself must NOT restart
 * with it: the client lives at module scope and keeps screening across tab
 * switches, while `ui` is re-pointed at whatever DOM is currently on screen. */
let client = null;
let ui = null;
let apiBase = "./api/";
let pollTimer = null;
let visibilityHooked = false;

/* Each endpoint carries its OWN reachability. ?a=stats and ?a=hits are separate
 * handlers over separate tables on the server, so one can fail while the other
 * answers; borrowing one flag for both made a hits-only outage render as a
 * spinner that never stops — the exact failure this file's header forbids. */
const remote = {
  stats: null,        // last good ?a=stats payload (already sanitized)
  hits: null,         // last good ?a=hits payload (already sanitized)
  reachable: null,    // ?a=stats: null = not asked yet, true/false afterwards
  hitsReachable: null,// ?a=hits: null = not asked yet, true/false afterwards
  statsError: "",
  hitsError: ""
};

const donate = {
  phase: "idle",      // idle | joining | running | stopped
  unitId: "",
  done: 0,
  total: 0,
  units: 0,
  confirmed: 0,
  credits: 0,
  name: "",
  message: "",
  tone: "dim"         // dim | ok | warn | err
};

/* ————— sanitizers: everything below the line is other people's data ————— */

function safeText(v, max) {
  let s;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" && isFinite(v)) s = String(v);
  else return "";
  /* Control characters and bidi overrides (which can visually reorder a name
   * into something it is not) never reach the DOM; runs of whitespace collapse
   * so nobody can pad a leaderboard row off the screen. */
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
       .replace(/\s+/g, " ")
       .trim();
  /* The cap is a CODE POINT cap (see truncate). The code-unit test is only a
   * cheap pre-filter — code points are never more numerous than code units —
   * and the ellipsis is appended only if something was actually removed. */
  if (s.length > max) {
    const kept = truncate(s, max - 1);
    if (kept.length < s.length) s = kept + "\u2026";
  }
  return s;
}

/* Cut by CODE POINT, never by UTF-16 code unit: slicing mid-surrogate leaves
 * a lone high surrogate that browsers paint as U+FFFD, and ordinary emoji
 * names on a public leaderboard produce exactly that. The walk is bounded by
 * `max`, so a megabyte of text still costs only `max` iterations. A cut that
 * lands on a trailing combining mark is backed off for the same reason: a
 * bare accent is a garbage glyph. No locale, no Intl, no property escapes. */
function truncate(s, max) {
  let cut = 0, n = 0;
  while (cut < s.length && n < max) {
    cut += s.codePointAt(cut) > 0xFFFF ? 2 : 1;
    n++;
  }
  return s.slice(0, cut).replace(/[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20F0\uFE20-\uFE2F]+$/, "");
}

function safeInt(v) {
  const n = typeof v === "number"
    ? v
    : (typeof v === "string" && /^-?[0-9]{1,15}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (!isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i > 1e15 || i < -1e15) return null;
  return i;
}

/* Thousands separators without Intl or toLocaleString: the same number renders
 * the same way for every visitor, whatever their locale. */
function groupInt(n) {
  if (n === null || n === undefined) return "—";
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && s[i - 1] !== "-" && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}

function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

/* ————— the network, wrapped so nothing here can ever throw ————— */

function apiUrl(action, params) {
  let u = apiBase + "?a=" + encodeURIComponent(action);
  for (const k of Object.keys(params || {}).sort()) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    u += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(String(v));
  }
  return u;
}

async function apiGet(action, params) {
  if (typeof fetch !== "function") return { ok: false, error: "this browser cannot reach the server" };
  let ctrl = null, timer = null;
  try {
    if (typeof AbortController === "function") {
      ctrl = new AbortController();
      timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, REQUEST_MS);
    }
    const init = { method: "GET", cache: "no-store" };
    if (ctrl) init.signal = ctrl.signal;
    const res = await fetch(apiUrl(action, params), init);
    /* MEASURE BEFORE READING. res.text() materialises the whole body into a JS
     * string first, so a post-read length check is decorative: a wedged or
     * hostile server just scales the allocation until the tab dies. The
     * advertised length is checked first and the transfer aborted; the
     * post-read check below still covers servers that send no content-length.
     * An error status is never read at all — the body is not used for it. */
    const len = Number(res.headers.get("content-length"));
    if (isFinite(len) && len > MAX_BODY) {
      try { if (ctrl) ctrl.abort(); } catch (_) {}
      return { ok: false, error: "the server sent an implausibly large response" };
    }
    if (!res.ok) {
      try { if (ctrl) ctrl.abort(); } catch (_) {}
      return { ok: false, error: "the server answered " + res.status };
    }
    const body = await res.text();
    if (body.length > MAX_BODY) return { ok: false, error: "the server sent an implausibly large response" };
    let data = null;
    try { data = JSON.parse(body); } catch (_) { return { ok: false, error: "the server sent something that is not JSON" }; }
    if (!isPlainObject(data)) return { ok: false, error: "the server sent an unexpected response" };
    return { ok: true, data };
  } catch (_) {
    return { ok: false, error: "could not reach the server" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* ————— shaping server payloads into things safe to render ————— */

function shapeStats(data) {
  const t = isPlainObject(data.totals) ? data.totals : {};
  const board = [];
  if (Array.isArray(data.leaderboard)) {
    for (const row of data.leaderboard.slice(0, BOARD_LIMIT)) {
      if (!isPlainObject(row)) continue;
      board.push({
        name: safeText(row.name, NAME_MAX) || "anonymous",
        units: safeInt(row.units),
        credits: safeInt(row.credits)
      });
    }
  }
  return {
    harvested: safeInt(t.harvested),
    screened: safeInt(t.screened),
    verified: safeInt(t.verified),
    contributors: safeInt(t.contributors),
    unitsOpen: safeInt(t.units_open),
    board
  };
}

function shapeHits(data) {
  const out = [];
  if (!Array.isArray(data.hits)) return out;
  for (const h of data.hits.slice(0, HITS_LIMIT)) {
    if (!isPlainObject(h)) continue;
    const rawCid = h.cid === undefined || h.cid === null ? "" : String(h.cid).trim();
    /* ABSENT IS NOT EMPTY. `flags` is the one safety-adjacent field in this
     * table, and the API contract does not promise it — an older or partial
     * server simply omits it. Folding "not told" into "" would make the Lab
     * assert, for every molecule on the public shortlist, that the screen
     * raised no structural alert. null therefore means UNKNOWN and renders as
     * such; only a field the server actually sent can say "none". A present
     * but unusable value (an array of non-strings, a number, an object) is
     * unknown too — it is not a clean bill of health either. */
    let flags = null;
    if (typeof h.flags === "string" || Array.isArray(h.flags)) {
      const list = Array.isArray(h.flags) ? h.flags.filter((f) => typeof f === "string") : [h.flags];
      const whole = !Array.isArray(h.flags) || list.length === h.flags.length;  // nothing dropped
      const raw = list.join(", ");
      const shown = safeText(raw, FIELD_MAX);
      /* Only a value that arrived whole and survived sanitizing may stand for
       * "the screen raised nothing". If entries were discarded, or the text
       * sanitized away to nothing it did not start as, we were told something
       * we cannot render — which is unknown, not clear. Fail closed. */
      flags = (whole && (raw === "" || shown !== "")) ? shown : null;
    }
    out.push({
      cid: CID_RE.test(rawCid) ? rawCid : null,      // null ⇒ no link is built, ever
      cidText: safeText(rawCid, 16),
      formula: safeText(h.formula, FIELD_MAX),
      score: safeInt(h.score),
      target: safeText(h.best_target, FIELD_MAX),
      verifiedBy: safeInt(h.verified_by),
      flags                                          // null ⇒ the server did not report it
    });
  }
  return out;
}

/* ————— polling ————— */

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

function tabIsVisible() {
  try { return typeof document === "undefined" || document.visibilityState !== "hidden"; }
  catch (_) { return true; }
}

function attached() {
  return !!(ui && ui.root && ui.root.isConnected);
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    /* Two reasons to go quiet: the visitor switched away from this tab (a
     * hidden page has no business making requests), or the Lab was torn down
     * by a tab change inside the app and this timer is the last thing left of
     * it. Both are checked here rather than trusted to a listener. */
    if (!attached()) { stopPolling(); return; }
    if (!tabIsVisible()) return;
    refresh();
  }, POLL_MS);
}

function hookVisibility() {
  if (visibilityHooked) return;
  visibilityHooked = true;
  try {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    document.addEventListener("visibilitychange", () => {
      try {
        if (tabIsVisible() && attached()) refresh();
      } catch (_) { /* a visibility handler may never take the page down */ }
    });
  } catch (_) {}
}

/* One refresh at a time. Without this, a tab-click storm (app.js re-renders the
 * whole view on every click) stacks parallel round-trips and a bored visitor
 * can rate-limit themselves out of the swarm. */
let refreshing = false;
let refreshedOnce = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshedOnce = true;
  try {
    const [s, h] = await Promise.all([apiGet("stats"), apiGet("hits", { limit: HITS_LIMIT })]);
    if (s.ok) {
      remote.stats = shapeStats(s.data);
      remote.reachable = true;
      remote.statsError = "";
    } else {
      remote.reachable = false;
      remote.statsError = s.error || "could not reach the server";
    }
    /* Recorded separately on purpose: a hits-only outage must not blank the
     * stats grid, and a stats-only outage must not leave hits spinning. */
    if (h.ok) {
      remote.hits = shapeHits(h.data);
      remote.hitsReachable = true;
      remote.hitsError = "";
    } else {
      remote.hitsReachable = false;
      remote.hitsError = h.error || "could not reach the server";
    }
  } finally {
    refreshing = false;
  }
  if (!attached()) return;
  paintStats();
  paintBoard();
  paintHits();
}

/* ————— section 1+2: explainer and the honesty banner ————— */

function buildIntro(root) {
  const intro = labEl("section", "lab-intro");
  intro.appendChild(labEl("h2", "sect-title", "The Lab"));
  intro.appendChild(labEl("p", "lab-lede",
    "Your browser compares newly harvested molecules against known longevity-active drugs — " +
    "shape, chemical features and structural warnings — and sends back a score and a fingerprint of its work."));
  intro.appendChild(labEl("p", "lab-lede",
    "Two independent volunteers must produce exactly the same fingerprint before a result counts, " +
    "so no single machine (or single bad actor) can put anything on the board alone."));
  root.appendChild(intro);

  /* Always visible, never dismissible, above everything it qualifies. */
  const banner = labEl("section", "lab-banner");
  banner.appendChild(labEl("p", "lab-banner-title", "What this is, and what it is not"));
  banner.appendChild(labEl("p", "lab-banner-body",
    "This produces a ranked shortlist of hypotheses for researchers to look at. " +
    "It is not a discovery, not a drug, and not medical advice. " +
    "A molecule scoring well here means it resembles compounds that have been studied — nothing more. " +
    "Nothing on this page has been tested in a living thing, and no result here says anything about " +
    "whether a substance is effective or safe."));
  root.appendChild(banner);
}

/* ————— section 3: live totals ————— */

const STAT_FIELDS = [
  ["harvested", "molecules harvested"],
  ["screened", "screened"],
  ["verified", "verified hits"],
  ["contributors", "contributors"],
  ["unitsOpen", "open work units"]
];

function buildStats(root) {
  const sec = labEl("section", "lab-section");
  sec.appendChild(labEl("h3", "sect", "Live totals"));
  const host = labEl("div", "lab-stats-host");
  sec.appendChild(host);
  root.appendChild(sec);
  ui.statsHost = host;
  paintStats();
}

function paintStats() {
  const host = ui && ui.statsHost;
  if (!host) return;
  host.textContent = "";
  if (!remote.stats) {
    host.appendChild(remote.reachable === false ? offlinePanel() : labEl("p", "lab-empty", "Asking the swarm server…"));
    return;
  }
  const grid = labEl("div", "lab-stats");
  for (const [key, label] of STAT_FIELDS) {
    const cell = labEl("div", "lab-stat");
    cell.appendChild(labEl("div", "lab-stat-num", groupInt(remote.stats[key])));
    cell.appendChild(labEl("div", "lab-stat-label", label));
    grid.appendChild(cell);
  }
  host.appendChild(grid);
  if (remote.reachable === false) host.appendChild(labEl("p", "lab-note", "Showing the last figures we managed to fetch — " + OFFLINE_MSG));
  else host.appendChild(labEl("p", "lab-note", "Refreshed every 15 seconds while this tab is in front."));
}

function noticePanel(title, body, reason) {
  const p = labEl("div", "lab-offline");
  p.appendChild(labEl("p", "lab-offline-title", title));
  p.appendChild(labEl("p", "lab-offline-body", body));
  if (reason) p.appendChild(labEl("p", "lab-note", "Reason reported: " + safeText(reason, 120)));
  return p;
}

function offlinePanel() {
  return noticePanel("No swarm server here", OFFLINE_MSG, remote.statsError);
}

/* The server answering for one endpoint and failing for another is a real
 * state, and saying "not reachable from here" when it plainly is would be a
 * lie. Name the part that failed instead. */
function hitsPanel() {
  if (remote.reachable === false) return offlinePanel();
  return noticePanel(
    "The hits list did not load",
    "The swarm server answered, but the list of verified hits could not be fetched. " +
    "Nothing else on this page is affected, and this panel retries by itself.",
    remote.hitsError);
}

/* ————— section 4: the contribute panel ————— */

const COSTS = [
  "One CPU core, only while this tab is open and in front — close it or press Stop and it ends immediately.",
  "A few kilobytes of traffic per work unit: about forty molecules in, a list of scores out.",
  "No personal data. No account, no email, no cookies for tracking — just a random token so your units can be credited.",
  "A display name is optional, and shows only on the leaderboard below."
];

function buildContribute(root) {
  const sec = labEl("section", "lab-section");
  sec.appendChild(labEl("h3", "sect", "Donate this browser"));

  const panel = labEl("div", "lab-panel");

  const costs = labEl("ul", "lab-cost");
  for (const c of COSTS) costs.appendChild(labEl("li", "", c));
  panel.appendChild(costs);

  const actions = labEl("div", "lab-actions");

  const nameInput = labEl("input", "lab-name");
  nameInput.type = "text";
  nameInput.maxLength = NAME_MAX;
  nameInput.placeholder = "Display name (optional)";
  nameInput.value = donate.name;
  nameInput.setAttribute("aria-label", "Display name, optional");
  nameInput.addEventListener("input", () => { donate.name = nameInput.value.slice(0, NAME_MAX); });
  actions.appendChild(nameInput);

  const go = labEl("button", "lab-btn", "Donate this browser");
  go.addEventListener("click", () => { startDonating(); });
  actions.appendChild(go);

  const stop = labEl("button", "lab-btn lab-btn-stop", "Stop");
  stop.addEventListener("click", () => { stopDonating(); });
  actions.appendChild(stop);

  panel.appendChild(actions);

  const status = labEl("p", "lab-status");
  panel.appendChild(status);

  const bar = labEl("div", "lab-progress");
  const fill = labEl("div", "lab-progress-fill");
  bar.appendChild(fill);
  panel.appendChild(bar);

  const readout = labEl("div", "lab-readout");
  panel.appendChild(readout);

  sec.appendChild(panel);
  root.appendChild(sec);

  ui.nameInput = nameInput;
  ui.goBtn = go;
  ui.stopBtn = stop;
  ui.status = status;
  ui.progressBar = bar;
  ui.progressFill = fill;
  ui.readout = readout;
  paintDonate();
}

function ensureClient() {
  if (client) return client;
  try {
    client = createSwarmClient({ apiBase, onEvent: onSwarmEvent });
  } catch (_) {
    client = null;
    donate.phase = "stopped";
    donate.message = "This browser could not start the screener.";
    donate.tone = "err";
  }
  return client;
}

async function startDonating() {
  const c = ensureClient();
  if (!c) { paintDonate(); return; }
  donate.phase = "joining";
  donate.message = "Signing up as a contributor…";
  donate.tone = "dim";
  paintDonate();
  let joined = false;
  try {
    const st = c.status();
    joined = !!(st && st.joined);
    if (!joined) {
      const who = await c.join(donate.name);
      joined = !!who;
    } else if (donate.name) {
      /* keep the loop's fallback name in step with what is typed */
      c.join(donate.name);
    }
  } catch (_) { /* join never throws, but never trust that from here */ }

  /* CONSENT, RE-CHECKED AFTER THE AWAIT. The join is a network round-trip, and
   * the Stop button is deliberately live for the whole of it — so the visitor
   * can and does press it while we are suspended here. Nothing else writes
   * donate.phase during a join (the client is not running, so no unit/stopped
   * events fire, and "joined" does not touch phase), so a phase that is no
   * longer "joining" means exactly one thing: they said no. Starting the
   * screener now would take a stranger's CPU after they refused it. */
  if (donate.phase !== "joining") { paintDonate(); return; }

  try { c.start(); } catch (_) {}
  donate.phase = "running";
  donate.message = joined
    ? "Screening. Thank you — you can leave this tab open and forget about it."
    : "Screening. (Still trying to sign in with the server; it will retry by itself.)";
  donate.tone = joined ? "ok" : "warn";
  paintDonate();
}

function stopDonating() {
  if (client) { try { client.stop(); } catch (_) {} }
  donate.phase = "stopped";
  donate.unitId = "";
  donate.done = 0;
  donate.total = 0;
  donate.message = "Stopped. Nothing is using your CPU.";
  donate.tone = "dim";
  paintDonate();
}

/* Every event the swarm client emits, turned into one line a person can read.
 * A UI listener may never throw back into the loop, so the whole body is
 * guarded. */
function onSwarmEvent(ev) {
  try {
    if (!ev || typeof ev.type !== "string") return;
    if (ev.type === "joined") {
      /* A join can land AFTER the visitor pressed Stop — the request was
       * already in flight. Signing in costs them nothing, but the status line
       * is the one sentence they read, and while they are stopped it must go
       * on saying so rather than reporting activity they cancelled. */
      if (donate.phase !== "stopped") {
        donate.message = "Signed in as " + (safeText(ev.name, NAME_MAX) || "an anonymous contributor") + ".";
        donate.tone = "ok";
        if (ev.stored === false) donate.message += " (This browser will not remember it after a reload.)";
      }
    } else if (ev.type === "unit") {
      donate.phase = "running";
      donate.unitId = safeText(ev.unitId, 24);
      donate.done = 0;
      donate.total = safeInt(ev.total) || 0;
      donate.message = "Screening a new work unit.";
      donate.tone = "ok";
    } else if (ev.type === "progress") {
      donate.done = safeInt(ev.done) || 0;
      if (ev.total !== undefined) donate.total = safeInt(ev.total) || donate.total;
    } else if (ev.type === "submitted") {
      donate.units = safeInt(ev.units) || donate.units;
      donate.credits = safeInt(ev.credits) || donate.credits;
      donate.message = describeStatus(ev.status);
      donate.tone = ev.status === "conflict" || ev.status === "canary_failed" ? "warn" : "ok";
      scheduleRefresh();
    } else if (ev.type === "confirmed") {
      donate.confirmed = safeInt(ev.confirmed) || donate.confirmed + 1;
      donate.credits = safeInt(ev.credits) || donate.credits;
      donate.message = "A second volunteer agreed with your result — that unit is confirmed.";
      donate.tone = "ok";
      scheduleRefresh();
    } else if (ev.type === "idle") {
      donate.message = "No work units are waiting — checking again shortly.";
      donate.tone = "dim";
    } else if (ev.type === "error") {
      donate.message = safeText(ev.message, 140) || "Something went wrong; retrying.";
      donate.tone = "warn";
    } else if (ev.type === "stopped") {
      donate.phase = "stopped";
      donate.unitId = "";
      donate.done = 0;
      donate.total = 0;
      if (donate.tone !== "warn") { donate.message = "Stopped. Nothing is using your CPU."; donate.tone = "dim"; }
    }
    paintDonate();
  } catch (_) { /* the UI's problem, never the swarm's */ }
}

function describeStatus(status) {
  if (status === "confirmed") return "Confirmed — a second volunteer produced the same fingerprint.";
  if (status === "conflict") return "Your result disagreed with another volunteer's; the unit goes back out to a third.";
  if (status === "canary_failed") return "That unit was a check unit with a known answer, and the answer did not match.";
  return "Submitted — waiting for a second volunteer to agree.";
}

let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; if (attached()) refresh(); }, 1200);
}

function paintDonate() {
  if (!ui || !ui.status) return;
  const running = !!(client && client.isRunning && client.isRunning()) || donate.phase === "joining";
  ui.goBtn.disabled = running;
  ui.goBtn.textContent = donate.phase === "joining" ? "Starting…" : "Donate this browser";
  ui.stopBtn.disabled = !running;
  ui.stopBtn.hidden = !running;
  ui.nameInput.disabled = running;

  ui.status.className = "lab-status lab-status-" + donate.tone;
  ui.status.textContent = donate.message ||
    "Nothing is running. Press the button and this browser joins the swarm; press Stop and it leaves.";

  const total = donate.total > 0 ? donate.total : 0;
  const done = total ? Math.min(donate.done, total) : 0;
  ui.progressBar.hidden = !total;
  ui.progressFill.style.width = total ? String(Math.floor((done * 100) / total)) + "%" : "0%";

  ui.readout.textContent = "";
  const rows = [
    ["current unit", donate.unitId || "—"],
    ["molecules in this unit", total ? groupInt(done) + " / " + groupInt(total) : "—"],
    ["your units submitted", groupInt(donate.units)],
    ["confirmed by a second volunteer", groupInt(donate.confirmed)],
    ["your credits", groupInt(donate.credits)]
  ];
  for (const [k, v] of rows) {
    const row = labEl("div", "lab-read-row");
    row.appendChild(labEl("span", "lab-read-k", k));
    row.appendChild(labEl("span", "lab-read-v", v));
    ui.readout.appendChild(row);
  }
}

/* ————— section 5: the leaderboard ————— */

function buildBoard(root) {
  const sec = labEl("section", "lab-section");
  sec.appendChild(labEl("h3", "sect", "Leaderboard"));
  const host = labEl("div", "lab-board-host");
  sec.appendChild(host);
  root.appendChild(sec);
  ui.boardHost = host;
  paintBoard();
}

function paintBoard() {
  const host = ui && ui.boardHost;
  if (!host) return;
  host.textContent = "";
  if (!remote.stats) {
    host.appendChild(remote.reachable === false ? offlinePanel() : labEl("p", "lab-empty", "Loading…"));
    return;
  }
  const board = remote.stats.board;
  if (!board.length) { host.appendChild(labEl("p", "lab-empty", "Nobody has finished a unit yet. You could be first.")); return; }
  const table = labEl("div", "lab-board");
  const head = labEl("div", "lab-board-row lab-board-head");
  head.appendChild(labEl("span", "lab-b-rank", "#"));
  head.appendChild(labEl("span", "lab-b-name", "contributor"));
  head.appendChild(labEl("span", "lab-b-num", "units"));
  head.appendChild(labEl("span", "lab-b-num", "credits"));
  table.appendChild(head);
  let rank = 0;
  for (const row of board) {
    rank++;
    const r = labEl("div", "lab-board-row");
    r.appendChild(labEl("span", "lab-b-rank", String(rank)));
    /* A span, never an anchor: these names are typed by strangers. */
    r.appendChild(labEl("span", "lab-b-name", row.name));
    r.appendChild(labEl("span", "lab-b-num", groupInt(row.units)));
    r.appendChild(labEl("span", "lab-b-num", groupInt(row.credits)));
    table.appendChild(r);
  }
  host.appendChild(table);
  host.appendChild(labEl("p", "lab-note", "Names are chosen by contributors and shown as plain text."));
  if (remote.reachable === false) {
    host.appendChild(labEl("p", "lab-note", "This is the last board we managed to fetch — " + OFFLINE_MSG));
  }
}

/* ————— section 6: top verified hits ————— */

function buildHits(root) {
  const sec = labEl("section", "lab-section");
  sec.appendChild(labEl("h3", "sect", "Top verified hits"));
  sec.appendChild(labEl("p", "lab-lede",
    "Each row is a molecule two independent volunteers scored identically. " +
    "Read it as a place to look next, not as a result."));
  const host = labEl("div", "lab-hits-host");
  sec.appendChild(host);
  root.appendChild(sec);
  ui.hitsHost = host;
  paintHits();
}

function paintHits() {
  const host = ui && ui.hitsHost;
  if (!host) return;
  host.textContent = "";
  if (!remote.hits) {
    host.appendChild(remote.hitsReachable === false ? hitsPanel() : labEl("p", "lab-empty", "Loading…"));
    return;
  }
  if (!remote.hits.length) {
    host.appendChild(labEl("p", "lab-empty", "No molecule has been confirmed by two volunteers yet."));
    if (remote.hitsReachable === false) host.appendChild(staleHitsNote());
    return;
  }
  const scroll = labEl("div", "lab-scroll");
  const table = labEl("div", "lab-hits");
  const head = labEl("div", "lab-hit-row lab-hit-head");
  for (const [cls, label] of [["lab-h-rank", "#"], ["lab-h-formula", "formula"], ["lab-h-score", "score"],
                              ["lab-h-target", "closest reference"], ["lab-h-flags", "flags"], ["lab-h-link", "record"]]) {
    head.appendChild(labEl("span", cls, label));
  }
  table.appendChild(head);

  let rank = 0;
  let unreported = 0;
  for (const h of remote.hits) {
    rank++;
    const row = labEl("div", "lab-hit-row");
    if (h.verifiedBy !== null) row.title = "agreed on by " + groupInt(h.verifiedBy) + " independent volunteers";
    row.appendChild(labEl("span", "lab-h-rank", String(rank)));
    row.appendChild(labEl("span", "lab-h-formula", h.formula || "—"));
    row.appendChild(labEl("span", "lab-h-score", h.score === null ? "—" : groupInt(h.score)));
    row.appendChild(labEl("span", "lab-h-target", h.target || "—"));
    /* "none" is a claim — that the screen looked and raised nothing. It may
     * only be printed for a server that actually reported the field. */
    if (h.flags === null) {
      unreported++;
      const cell = labEl("span", "lab-h-flags lab-h-unknown", "not reported");
      cell.title = "This server did not send a flags field for this hit. That is not the same as no alerts.";
      row.appendChild(cell);
    } else {
      row.appendChild(labEl("span", "lab-h-flags" + (h.flags ? " lab-h-flagged" : ""), h.flags || "none"));
    }

    /* THE LINK RULE. A PubChem URL is built only from a compound id that is
     * nothing but digits; anything else renders as inert text. */
    if (h.cid) {
      const a = labEl("a", "lab-h-link", "CID " + h.cid);
      a.href = PUBCHEM + h.cid;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      row.appendChild(a);
    } else {
      row.appendChild(labEl("span", "lab-h-link lab-h-nolink", h.cidText ? "no valid id" : "—"));
    }
    table.appendChild(row);
  }
  scroll.appendChild(table);
  host.appendChild(scroll);
  host.appendChild(labEl("p", "lab-note",
    "Flags are structural warnings from the screen — a reason for a chemist to look closely, never a verdict about a substance."));
  if (unreported) {
    host.appendChild(labEl("p", "lab-note",
      "“not reported” means this server sent no usable flags field for that hit. It is not the same as “none”, " +
      "and nothing here should be read as a molecule having been checked and cleared."));
  }
  if (remote.hitsReachable === false) host.appendChild(staleHitsNote());
}

function staleHitsNote() {
  return labEl("p", "lab-note",
    "This is the last list we managed to fetch — the most recent request for it did not succeed" +
    (remote.hitsError ? " (" + safeText(remote.hitsError, 120) + ")." : "."));
}

/* ————— the export ————— */

export function renderLab(root, options) {
  /* Nothing in this module may take the page down, and that includes a caller
   * handing it something that is not an element. Refuse, do not throw, and do
   * not leave module state half-changed behind the refusal. */
  if (!root || typeof root.appendChild !== "function") return null;

  const opts = isPlainObject(options) ? options : {};
  if (typeof opts.apiBase === "string" && opts.apiBase) apiBase = opts.apiBase;

  const wrap = labEl("div", "lab");
  ui = { root: wrap };

  buildIntro(wrap);
  buildStats(wrap);
  buildContribute(wrap);
  buildBoard(wrap);
  buildHits(wrap);

  wrap.appendChild(labEl("p", "disclaimer",
    "LongevityOS reports published research and screens public chemical data. " +
    "Its screening output is a shortlist of hypotheses for researchers, never a finding about a substance, " +
    "and nothing here is medical advice."));

  root.appendChild(wrap);

  hookVisibility();
  paintDonate();
  /* app.js rebuilds this whole view on every tab click, so an unconditional
   * refresh here turns idle tab-toggling into two API requests per click. The
   * first open must fetch; after that the panels are already painted from the
   * last payload and the debounced refresh is enough — a visitor must not be
   * able to rate-limit themselves out of the swarm by fidgeting. */
  if (refreshedOnce) scheduleRefresh();
  else refresh();
  startPolling();
  return wrap;
}

/* QA hook — a test surface only, and deliberately not a running client: the
 * Lab still donates nothing until somebody presses the button. */
try {
  if (typeof window !== "undefined") {
    window.__losLab = {
      refresh,
      snapshot: () => ({ donate: Object.assign({}, donate), reachable: remote.reachable }),
      safeText,
      CID_RE
    };
  }
} catch (_) {}
