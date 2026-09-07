/* lab — the live face of the swarm.
 *
 * WHAT THIS TAB IS. Three honest things at once: an explainer, a control panel
 * for donating this browser's spare CPU, and a scoreboard of what the swarm has
 * produced so far. The scoreboard's output is a RANKED SHORTLIST OF HYPOTHESES
 * for researchers to look at — it is not a discovery, not a drug, not medical
 * advice, and nothing in it has been tested in a living thing.
 *
 * Since 3.0 it is also the place a phone becomes a contributor (the "On a phone
 * or tablet" panel: screen wake lock, a charging gate, a pace dial, install),
 * where teams are made and joined, and where a contributor reads their own
 * record — plus the public "Contributor record" card a shared ?c=<id> link
 * opens to.
 *
 * EVERY STRING ON THIS PAGE THAT CAME FROM THE SERVER IS UNTRUSTED. Leaderboard
 * names are typed by strangers; team names and codes are typed by strangers;
 * formulas, targets and flags are assembled by a server this page does not
 * control. So: createElement + textContent only (no markup sink is used
 * anywhere in this file), lengths capped, control characters stripped, and the
 * few links on the page are built ONLY from values that matched a strict
 * pattern first: a PubChem link from a compound id that matched /^[0-9]{1,12}$/,
 * a team share link from a code that matched /^[A-HJ-NP-Z2-9]{8}$/, a record
 * share link from an id that matched /^[1-9][0-9]{0,11}$/. A link built out of
 * unvalidated server text is an open redirect waiting to happen.
 *
 * NO SERVER IS A SUPPORTED STATE. LongevityOS is an evidence atlas first; the
 * swarm is an extra. Every request here collapses to { ok:false } and the tab
 * degrades to an honest "the swarm server is not reachable from here" panel
 * rather than a broken page or a spinner that never stops.
 *
 * CONSENT. Nothing in this file starts using anyone's CPU. The swarm client is
 * constructed lazily (constructing it starts nothing — it is bookkeeping about
 * a token), and screening begins only when the visitor presses Donate. The
 * phone panel's preferences are remembered, but remembering "keep the screen
 * awake" never requests a wake lock on load, and remembering "only while
 * charging" never starts the loop when a charger appears unless the visitor
 * had it running when they unplugged. What donating costs is spelled out
 * before the first press.
 *
 * 4.0. This file no longer polls. js/view/telemetry.js is the app's ONLY
 * poller (stats / hits / history, ETag-aware, suspended while hidden); the
 * Lab SUBSCRIBES to its store, asks it to refresh after its own events, and
 * reports LAB / YOU / CONF lines into the strip. The numbers on this page are
 * seven-segment readouts (js/view/led.js) that roll old → new in one step —
 * there is no count-up anywhere, and a server figure changes only when a
 * poll lands.
 */

import { createSwarmClient } from "./swarm/client.js";
import { viewLed, viewLedBar, viewPark } from "./view/led.js";
import { viewTelemetry } from "./view/telemetry.js";
import { viewLens } from "./view/lens.js";
import { viewObservatory } from "./view/observatory.js";
import { viewWizard } from "./view/wizard.js";
import { viewSoundBoard } from "./view/sound.js";

/* ————— style conventions, borrowed from app.js verbatim ————— */

const labEl = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const REQUEST_MS = 12000;
const MAX_BODY = 262144;
const HITS_LIMIT = 20;
const BOARD_LIMIT = 20;
const TEAMS_LIMIT = 10;
const NAME_MAX = 24;         // visible cap on another person's chosen name
const TEAM_NAME_MAX = 24;    // the server's own cap on a team name
const FIELD_MAX = 48;        // visible cap on any other server string
const PUBCHEM = "https://pubchem.ncbi.nlm.nih.gov/compound/";
const CID_RE = /^[0-9]{1,12}$/;
/* A team code, exactly as the server mints it: 8 characters from an alphabet
 * with no 0/O or 1/I, so it can be read off a phone screen or said aloud. */
const TEAM_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
/* A contributor id in canonical decimal: no leading zeros, no sign, 1–12
 * digits. Anything else never reaches a URL. */
const ID_RE = /^[1-9][0-9]{0,11}$/;
const PHONE_KEY = "los.phone.v1";
const LEAVE_CONFIRM_MS = 10000;

const OFFLINE_MSG = "The swarm server is not reachable from here. " +
  "The atlas itself works with no server at all — this panel is the only thing that needs one.";

/* THE BADGE RULE. Badges are thresholds on UNITS — work the contributor's
 * browser actually screened. There is no badge for a hit, a high score, a
 * verified molecule or anything else the contributor did not control: a unit
 * that happens to contain a promising molecule was not screened any harder
 * than one that did not. Credit is for effort, never for luck, and the same
 * sentence is printed on the page beside the badges. */
const BADGES = [
  [1, "First unit"],
  [10, "Ten units"],
  [100, "A hundred"],
  [1000, "A thousand"],
  [10000, "Ten thousand"]
];

/* The pace dial: the minimum pause between finishing one unit and asking for
 * the next. The Lab's default is Full; the choice is remembered. */
const PACES = [
  ["full", 0, "Full", "no pause between units"],
  ["gentle", 1000, "Gentle", "a one-second breather between units"],
  ["trickle", 4000, "Trickle", "four seconds between units — the coolest setting, and the slowest"]
];

/* ————— module state: one client, one poller, however many renders ————— */

/* app.js re-renders the whole view on every tab click, so this tab is built
 * from scratch each time it is opened. The donation itself must NOT restart
 * with it: the client lives at module scope and keeps screening across tab
 * switches, while `ui` is re-pointed at whatever DOM is currently on screen. */
let client = null;
let ui = null;
/* UNDER THE LENS: the view instance of the current render, and the session
 * counters it prints (kept here so a tab click does not reset "this session") */
let lens = null;
const lensSession = { shown: 0, base: 0, cur: 0, dropped: 0, offered: 0 };
/* 4.0: the setup wizard of the current render (null when closed) and the ONE
 * sound board the whole page shares. Constructing the board makes no Audio —
 * a remembered preference only ARMS it for the visitor's next gesture. */
let wizard = null;
const sound = viewSoundBoard({ base: "audio/" });
let apiBase = "./api/";
let visibilityHooked = false;
let subscribed = false;

/* Each endpoint carries its OWN reachability. ?a=stats and ?a=hits are separate
 * handlers over separate tables on the server, so one can fail while the other
 * answers; borrowing one flag for both made a hits-only outage render as a
 * spinner that never stops — the exact failure this file's header forbids.
 * Since 4.0 both are copied out of the telemetry store's snapshot. */
const remote = {
  stats: null,        // last good ?a=stats payload (already sanitized)
  hits: null,         // last good ?a=hits payload (already sanitized)
  reachable: null,    // ?a=stats: null = not asked yet, true/false afterwards
  hitsReachable: null,// ?a=hits: null = not asked yet, true/false afterwards
  statsError: "",
  hitsError: ""
};

const donate = {
  phase: "idle",      // idle | joining | running | paused | stopped
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

/* The phone panel. The three preferences are remembered; everything else is
 * live state that exists only while the page does. */
const phone = {
  wake: false,        // preference: keep the screen awake
  charging: false,    // preference: only screen while charging
  pace: 0,            // preference: ms between units
  sentinel: null,     // the live WakeLockSentinel, if one is held
  wakeNote: "",       // what the wake lock is doing right now
  battery: null,      // the BatteryManager, once hooked
  wantRunning: false, // the charging gate paused a RUNNING loop; resume when power returns
  chargeNote: ""      // what the charging gate is doing right now
};

/* Teams. `own` is the team this contributor is in (or null); `invited` is the
 * team a ?team= link pointed at, once the server described it. */
const team = {
  own: null,          // { code, name, members, units, credits, since }
  board: [],          // rows of the team whose board is shown
  boardCode: "",      // which team the board belongs to
  boardName: "",
  top: [],            // top teams from ?a=stats
  inviteCode: "",     // a validated ?team= code
  invited: null,      // { code, name } after ?a=team answered
  inviteError: "",
  busy: false,
  message: "",
  tone: "dim"
};

/* The contributor's own record, as the server last described it. */
const record = {
  known: false,       // ?a=me has answered at least once for this token
  id: null,
  name: "",
  units: null,
  credits: null,
  team: null,         // { code, name } | null
  since: "",
  error: "",
  message: "",
  tone: "dim",
  confirmArmed: 0     // when the first "Leave the swarm" press happened, or 0
};

/* The public record a ?c=<id> link opens to. */
const profile = {
  id: "",             // validated
  state: "idle",      // idle | loading | ok | missing | error
  data: null,
  error: ""
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

/* A team code as the page is willing to show or link it: uppercase, and
 * exactly the server's alphabet, or nothing. */
function safeCode(v) {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return TEAM_CODE_RE.test(s) ? s : null;
}

/* A contributor id as the page is willing to link it: canonical decimal, or
 * nothing. Numbers are accepted only if they print canonically. */
function safeId(v) {
  const s = typeof v === "number" && isFinite(v) ? String(v) : (typeof v === "string" ? v.trim() : "");
  return ID_RE.test(s) ? s : null;
}

/* A unix timestamp (seconds; milliseconds are recognised and folded) rendered
 * as a plain YYYY-MM-DD, or "" for anything outside 2000..2100. The clock is
 * fine here — this is the UI, nowhere near a digest. */
function sinceText(v) {
  let n = safeInt(v);
  if (n === null || n <= 0) return "";
  if (n > 1e12) n = Math.floor(n / 1000);
  if (n < 946684800 || n > 4102444800) return "";
  try { return new Date(n * 1000).toISOString().slice(0, 10); } catch (_) { return ""; }
}

function badgesFor(units) {
  return BADGES.map(([n, label]) => ({ n, label, earned: units !== null && units >= n }));
}

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
      return { ok: false, error: "the server answered " + res.status, status: res.status };
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

function shapeTeamInfo(t) {
  if (!isPlainObject(t)) return null;
  return {
    code: safeCode(t.code),                                   // null ⇒ no link is built, ever
    name: safeText(t.name, TEAM_NAME_MAX) || "unnamed team",
    members: safeInt(t.members),
    units: safeInt(t.units),
    credits: safeInt(t.credits),
    since: sinceText(t.created_at)
  };
}

/* A team reference as it rides inside a contributor record: code + name. */
function shapeTeamRef(t) {
  if (!isPlainObject(t)) return null;
  return { code: safeCode(t.code), name: safeText(t.name, TEAM_NAME_MAX) || "unnamed team" };
}

function shapeRows(list, limit) {
  const rows = [];
  if (!Array.isArray(list)) return rows;
  for (const row of list.slice(0, limit)) {
    if (!isPlainObject(row)) continue;
    rows.push({
      name: safeText(row.name, NAME_MAX) || "anonymous",
      units: safeInt(row.units),
      credits: safeInt(row.credits)
    });
  }
  return rows;
}

function shapeContributor(c) {
  if (!isPlainObject(c)) return null;
  return {
    id: safeId(c.id),
    name: safeText(c.name, NAME_MAX) || "anonymous",
    units: safeInt(c.units),
    credits: safeInt(c.credits),
    rank: safeInt(c.rank),
    since: sinceText(c.created_at),
    team: shapeTeamRef(c.team)
  };
}

function shapeStats(data) {
  const t = isPlainObject(data.totals) ? data.totals : {};
  const teams = [];
  if (Array.isArray(data.teams)) {
    for (const row of data.teams.slice(0, TEAMS_LIMIT)) {
      const s = shapeTeamInfo(row);
      if (s) teams.push(s);
    }
  }
  return {
    harvested: safeInt(t.harvested),
    screened: safeInt(t.screened),
    verified: safeInt(t.verified),
    contributors: safeInt(t.contributors),
    unitsOpen: safeInt(t.units_open),
    board: shapeRows(data.leaderboard, BOARD_LIMIT),
    teams
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
      /* the lens draws the shortlist specimen from this; it goes through the
       * engine's own parser and nowhere else, so it is capped, not sanitized */
      smiles: typeof h.smiles === "string" ? h.smiles.slice(0, 4000) : "",
      formula: safeText(h.formula, FIELD_MAX),
      score: safeInt(h.score),
      target: safeText(h.best_target, FIELD_MAX),
      verifiedBy: safeInt(h.verified_by),
      flags                                          // null ⇒ the server did not report it
    });
  }
  return out;
}

/* ————— deep links: ?team=CODE and ?c=ID ————— */

/* Read once per render, validated before anything is built from them. A code
 * or id that does not match is simply absent — never echoed, never fetched. */
function deepLinks() {
  const out = { team: "", c: "" };
  try {
    if (typeof location === "undefined") return out;
    const q = new URLSearchParams(location.search);
    // A link somebody else wrote is matched RAW — no trimming, no repair. A
    // code or id that is not exactly the server's shape is not a link at all,
    // so it never becomes a request (probe-deeplink.mjs holds this line).
    const rawTeam = String(q.get("team") || "").toUpperCase();
    if (TEAM_CODE_RE.test(rawTeam)) out.team = rawTeam;
    const rawId = String(q.get("c") || "");
    if (ID_RE.test(rawId)) out.c = rawId;
  } catch (_) { /* a URL we cannot parse carries no links */ }
  return out;
}

function shareUrl(param, value) {
  try {
    return location.origin + location.pathname + "?" + param + "=" + encodeURIComponent(value);
  } catch (_) {
    return "";
  }
}

/* ————— the remembered phone preferences ————— */

/* Read on build, written on every change, and NEVER acted on at load time:
 * a remembered wake-lock preference waits for the next press, and a
 * remembered charging gate never starts anything by itself. */
function readPhonePrefs() {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(PHONE_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return;
    phone.wake = v.wake === true;
    phone.charging = v.charging === true;
    const p = safeInt(v.pace);
    phone.pace = PACES.some((x) => x[1] === p) ? p : 0;
  } catch (_) { /* storage refused: the defaults stand */ }
}

function writePhonePrefs() {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PHONE_KEY, JSON.stringify({ wake: phone.wake, charging: phone.charging, pace: phone.pace }));
  } catch (_) { /* storage refused: the preference lives for this page only */ }
}

/* ————— the telemetry store (4.0: the Lab subscribes, it does not poll) ————— */

function tabIsVisible() {
  try { return typeof document === "undefined" || document.visibilityState !== "hidden"; }
  catch (_) { return true; }
}

function attached() {
  return !!(ui && ui.root && ui.root.isConnected);
}

function clientRunning() {
  try { return !!(client && client.isRunning && client.isRunning()); } catch (_) { return false; }
}

/* Copy what the strip knows into the Lab's own state. The payloads are the
 * server's, verbatim; they are shaped (sanitized) here exactly as before. */
function applyTelemetry(snap) {
  if (!snap) return;
  if (snap.stats) {
    remote.stats = shapeStats(snap.stats);
    team.top = remote.stats.teams;
  }
  remote.reachable = snap.statsReachable;
  remote.statsError = snap.statsError || "";
  if (snap.hits) remote.hits = shapeHits(snap.hits);
  remote.hitsReachable = snap.hitsReachable;
  remote.hitsError = snap.hitsError || "";
}

/* One subscription for the life of the page. Every landed stats poll also
 * refreshes the personal record and the team board — the same cadence the
 * Lab's own 15-second timer had before 4.0, now driven by the one poller. */
function subscribeTelemetry() {
  if (subscribed) return;
  subscribed = true;
  viewTelemetry.subscribe((snap, ev) => {
    try {
      /* only a stats or hits event carries anything the Lab shapes; log,
       * running, link and pause events are the strip's own business */
      if (!ev || (ev.kind !== "stats" && ev.kind !== "hits")) return;
      /* a poll the server answered 304 changed nothing: the panels already
       * show it (a freshly mounted Lab paints once whatever the answer) */
      if (ev.changed === false && ui && ui.painted) return;
      applyTelemetry(snap);
      if (!attached()) return;
      ui.painted = true;
      if (ev.kind === "stats" && ev.changed && !refreshing) { refreshMine(); return; }
      paintStats(); paintBoard(); paintHits(); paintTeams();
    } catch (_) { /* the Lab's problem, never the strip's */ }
  });
}

/* The personal half of a refresh: ?a=me (only with a token) and the team
 * board. Not a poll — it rides on the strip's stats cadence. */
let refreshingMine = false;
async function refreshMine() {
  if (refreshingMine) return;
  refreshingMine = true;
  try {
    const c = ensureClient();
    const wantMe = !!(c && c.status().joined);
    const m = wantMe ? await c.me() : null;
    if (m) applyMe(m);
    await refreshTeam();
  } finally {
    refreshingMine = false;
  }
  if (!attached()) return;
  paintStats();
  paintBoard();
  paintHits();
  paintTeams();
  paintRecord();
}

function hookVisibility() {
  if (visibilityHooked) return;
  visibilityHooked = true;
  try {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    document.addEventListener("visibilitychange", () => {
      try {
        /* the strip re-polls on its own when the page comes back; the Lab
         * only has the wake lock to look after here */
        /* The wake lock is re-acquired when the page comes back — but only if
         * the visitor asked for it AND the swarm is actually running. The
         * client's own visibility handler resumes the loop in the same tick,
         * and it may be registered after this one, so the check is deferred a
         * beat rather than racing it. */
        if (tabIsVisible()) {
          setTimeout(() => { try { if (phone.wake && clientRunning()) acquireWakeLock(); } catch (_) {} }, 50);
        }
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
    /* The record is asked for only when a token exists — a visitor who has
     * never pressed Donate has no record and is never signed up to get one.
     * stats + hits come from the one poller, forced now; the record and the
     * team board are the Lab's own one-shot reads. */
    const c = ensureClient();
    const wantMe = !!(c && c.status().joined);
    const [snap, m] = await Promise.all([
      viewTelemetry.refresh(),
      wantMe ? c.me() : Promise.resolve(null)
    ]);
    applyTelemetry(snap);
    if (m) applyMe(m);
    await refreshTeam();
  } finally {
    refreshing = false;
  }
  if (!attached()) return;
  paintStats();
  paintBoard();
  paintHits();
  paintTeams();
  paintRecord();
}

function applyMe(m) {
  if (!m) return;
  if (!m.ok) {
    /* A token the server no longer knows (401) has already been forgotten by
     * the client; anything else is a passing failure and the last record
     * stands. */
    record.error = safeText(m.error, 60);
    if (m.status === 401) resetRecord();
    return;
  }
  const c = shapeContributor(m.data.contributor);
  if (!c) { record.error = "the server did not describe this contributor"; return; }
  record.known = true;
  record.error = "";
  record.id = c.id;
  record.name = c.name;
  record.units = c.units;
  record.credits = c.credits;
  record.since = c.since;
  record.team = c.team;
  /* 4.0: the Observatory pins this contributor's row on the boards from the same record */
  viewObservatory.session({ type: "record", known: true, name: c.name, units: c.units, credits: c.credits, team: c.team });
  if (c.team && c.team.code) {
    if (!team.own || team.own.code !== c.team.code) {
      team.own = { code: c.team.code, name: c.team.name, members: null, units: null, credits: null, since: "" };
    }
  } else {
    team.own = null;
  }
}

function resetRecord() {
  record.known = false;
  record.id = null;
  record.name = "";
  record.units = null;
  record.credits = null;
  record.since = "";
  record.team = null;
  record.confirmArmed = 0;
  team.own = null;
  team.board = [];
  team.boardCode = "";
  team.boardName = "";
}

/* The board shown is the visitor's own team's, or — before they join — the
 * team the invitation pointed at. */
async function refreshTeam() {
  const code = (team.own && team.own.code) || team.inviteCode;
  if (!code) { team.board = []; team.boardCode = ""; team.boardName = ""; return; }
  const res = await apiGet("team", { code });
  if (!res.ok) {
    if (team.inviteCode && !team.own) team.inviteError = res.status === 404 ? "no team has that code" : safeText(res.error, 60);
    return;
  }
  const info = shapeTeamInfo(res.data.team);
  team.board = shapeRows(res.data.board, BOARD_LIMIT);
  team.boardCode = code;
  team.boardName = info ? info.name : "";
  if (team.own && team.own.code === code && info) team.own = info;
  if (team.inviteCode === code) { team.invited = { code, name: info ? info.name : "" }; team.inviteError = ""; }
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

/* ————— section 2: UNDER THE LENS ————— */

/* One real molecule at a time, drawn as this browser scores it, with the
 * engine's own readouts. The module is app/js/view/lens.js; this only mounts
 * it, feeds it the client's events, and hands it the already-fetched hits for
 * the pre-run specimen. It starts nothing. */
function buildLens(root) {
  const sec = labEl("section", "lab-section lab-lens");
  sec.setAttribute("data-lab", "lens");
  sec.appendChild(labEl("h3", "sect", "Under the lens"));
  const host = labEl("div", "lab-lens-host");
  sec.appendChild(host);
  root.appendChild(sec);
  if (lens) { try { lens.destroy(); } catch (_) {} }
  lens = viewLens(host, { session: lensSession, onDraw: () => sound.play("molecule-lock") });
  if (lens) {
    lens.setRunning(clientRunning());
    if (remote.hits) lens.setHits(remote.hits);
  }
}

/* ————— section 3: live totals ————— */

const STAT_FIELDS = [
  ["harvested", "molecules harvested"],
  ["screened", "screened"],
  ["verified", "verified hits"],
  ["contributors", "contributors"],
  ["unitsOpen", "open work units"],
  ["active", "active this hour"]
];

function buildStats(root) {
  const sec = labEl("section", "lab-section");
  sec.setAttribute("data-lab", "stats");
  sec.appendChild(labEl("h3", "sect", "Live totals"));
  const host = labEl("div", "lab-stats-host");
  sec.appendChild(host);
  root.appendChild(sec);
  ui.statsHost = host;
  ui.statsLeds = null;
  paintStats();
}

/* The readouts are built ONCE and then only re-set: a seven-segment display
 * that is rebuilt on every poll cannot diff its digits, and a number that is
 * rebuilt is a number that flickers. The grid appears the first time stats
 * land and stays; only the note under it is rewritten. */
function paintStats() {
  const host = ui && ui.statsHost;
  if (!host) return;
  if (!remote.stats) {
    host.textContent = "";
    ui.statsLeds = null;
    host.appendChild(remote.reachable === false ? offlinePanel() : labEl("p", "lab-empty", "Asking the swarm server…"));
    return;
  }
  if (!ui.statsLeds) {
    host.textContent = "";
    const grid = labEl("div", "instr-grid console-panel lab-stats");
    grid.setAttribute("data-lab", "stats-grid");
    const leds = {};
    for (const [key, label] of STAT_FIELDS) {
      leds[key] = viewLed(grid, { label, digits: 8, text: groupInt(remote.stats[key]) });
      leds[key].el.setAttribute("data-stat", key);
    }
    host.appendChild(grid);
    viewPark(grid);
    ui.statsLeds = leds;
    ui.statsNote = labEl("p", "lab-note");
    host.appendChild(ui.statsNote);
  } else {
    for (const [key] of STAT_FIELDS) ui.statsLeds[key].set(groupInt(remote.stats[key]));
  }
  ui.statsNote.textContent = remote.reachable === false
    ? "Showing the last figures we managed to fetch — " + OFFLINE_MSG
    : "Server figures, as last polled by the strip above: every 15 seconds while this tab is in front, every 5 minutes when the server asks for quiet. A number changes only when a poll lands.";
}

/* ————— section 3b: the console log and the still switch ————— */

function buildConsole(root) {
  const sec = labEl("section", "lab-section");
  sec.setAttribute("data-lab", "console");
  sec.appendChild(labEl("h3", "sect", "The live route"));
  sec.appendChild(labEl("p", "lab-lede",
    "The strip under the tabs says what the swarm did; this is the same route as a list — the last twenty lines, " +
    "with the time each arrived. NET is the server's totals, LAB and YOU are this browser, CONF is a second volunteer agreeing with it."));
  const panel = labEl("div", "console-panel");
  viewTelemetry.log(panel);
  viewPark(panel);
  sec.appendChild(panel);

  /* "Hold the instruments still": html[data-still] — the same rules as the
   * reduced-motion media query, remembered in los.hud.v1. Turning it on
   * starts nothing and stops nothing but motion. */
  const sw = labEl("label", "instr-switch");
  const box = labEl("input");
  box.type = "checkbox";
  box.checked = viewTelemetry.prefs().still;
  box.setAttribute("data-pref", "still");
  box.addEventListener("change", () => { viewTelemetry.still(box.checked); });
  sw.appendChild(box);
  const text = labEl("span", "lab-toggle-text");
  text.appendChild(labEl("span", "lab-toggle-label", "Hold the instruments still"));
  text.appendChild(labEl("span", "instr-switch-note", "no motion on this page beyond a short fade — remembered on this device"));
  sw.appendChild(text);
  sec.appendChild(sw);
  root.appendChild(sec);
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
  sec.setAttribute("data-lab", "contribute");
  sec.appendChild(labEl("h3", "sect", "Donate this browser"));

  const wizardHost = labEl("div", "lab-wizard-host");
  wizardHost.setAttribute("data-lab", "wizard");
  sec.appendChild(wizardHost);

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

  /* 4.0: the eight-step setup. Opening it starts nothing; its last step is
   * the other of the app's two start sites. */
  const setup = labEl("button", "lab-btn lab-btn-setup", "Set up this browser");
  setup.setAttribute("data-wizard", "open");
  setup.addEventListener("click", () => { openWizard(); });
  actions.appendChild(setup);

  const stop = labEl("button", "lab-btn lab-btn-stop", "Stop");
  stop.addEventListener("click", () => { stopDonating(); });
  actions.appendChild(stop);

  panel.appendChild(actions);

  const status = labEl("p", "lab-status");
  panel.appendChild(status);

  /* the session readouts: an LED bar for the unit in hand, seven-segment
   * counters for the tallies — built once, set on every event */
  const readout = labEl("div", "instr-grid lab-readout console-panel");
  readout.setAttribute("data-lab", "readout");
  const unitBar = viewLedBar(readout, { label: "current unit", value01: 0, text: "—" });
  unitBar.el.setAttribute("data-read", "unit");
  const unitsLed = viewLed(readout, { label: "units this session", digits: 6, text: "0" });
  unitsLed.el.setAttribute("data-read", "units");
  const confirmedLed = viewLed(readout, { label: "confirmed by a second volunteer", digits: 6, text: "0" });
  confirmedLed.el.setAttribute("data-read", "confirmed");
  const creditsLed = viewLed(readout, { label: "your credits", digits: 8, text: "0" });
  creditsLed.el.setAttribute("data-read", "credits");
  panel.appendChild(readout);
  viewPark(readout);

  sec.appendChild(panel);
  root.appendChild(sec);

  ui.nameInput = nameInput;
  ui.goBtn = go;
  ui.setupBtn = setup;
  ui.wizardHost = wizardHost;
  ui.stopBtn = stop;
  ui.status = status;
  ui.unitBar = unitBar;
  ui.unitsLed = unitsLed;
  ui.confirmedLed = confirmedLed;
  ui.creditsLed = creditsLed;
  paintDonate();
}

/* Constructing the client starts nothing: it reads the stored token, registers
 * a visibility listener and waits. It is built lazily so the record and team
 * panels can ask the server about an existing token without a press — and so
 * a visitor who has never joined costs the server nothing at all. */
function ensureClient() {
  if (client) return client;
  try {
    client = createSwarmClient({ apiBase, onEvent: onSwarmEvent, pace: phone.pace });
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
  /* THIS IS A GESTURE. The wake lock, if the visitor asked for one, is
   * requested here — inside the press — never from a timer or a load event. */
  if (phone.wake) acquireWakeLock();
  if (phone.charging) hookBattery();
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
      /* keep the loop's fallback name in step with what is typed — WITHOUT
       * joining again: ?a=join mints a fresh contributor every time, and a
       * second press must not throw away the record, team and badges the
       * first one earned */
      c.setName(donate.name);
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

  /* The charging gate, checked at the door: a visitor who asked for
   * charging-only and is unplugged right now gets a waiting state, not a
   * running one. The press is remembered, so power returning resumes it. */
  if (phone.charging && phone.battery && !isCharging()) {
    phone.wantRunning = true;
    donate.phase = "paused";
    donate.message = "Waiting for a charger — “only while charging” is on. Screening starts when one is connected.";
    donate.tone = "dim";
    paintDonate();
    paintPhone();
    scheduleRefresh();
    return;
  }

  runClient(c);
  donate.phase = "running";
  donate.message = joined
    ? "Screening. Thank you — you can leave this tab open and forget about it."
    : "Screening. (Still trying to sign in with the server; it will retry by itself.)";
  donate.tone = joined ? "ok" : "warn";
  viewTelemetry.push({ tag: "LAB", text: "Screening started — " + paceLabel() + "; only while this tab is open" });
  paintDonate();
  paintPhone();
  scheduleRefresh();
}

function paceLabel() {
  const p = PACES.find((x) => x[1] === phone.pace);
  return p ? p[2].toLowerCase() + " pace" : "full pace";
}

/* The ONE line in this file that starts CPU. Reached from Donate (a press)
 * and from the charging gate resuming a run the visitor pressed for; the
 * wizard's last step is the app's only other start site. */
function runClient(c) {
  try { c.start(); } catch (_) {}
}

/* ————— 4.0: the setup wizard ————— */

function hitsSmiles() {
  return Array.isArray(remote.hits) ? remote.hits.map((h) => h.smiles).filter((s) => typeof s === "string" && s) : [];
}

function openWizard() {
  if (!ui || !ui.wizardHost || !ui.wizardHost.isConnected) return;
  closeWizard();    // one wizard at a time: a superseded one is closed, never orphaned
  ensureClient();   // bookkeeping about a token; starts nothing
  wizard = viewWizard(ui.wizardHost, {
    client: () => client,
    molecules: hitsSmiles(),
    onStart: wizardHook,
    onClose: (info) => {
      wizard = null;
      /* the wizard persisted its choices; the panel catches up, and a run
       * that never began leaves nothing behind */
      readPhonePrefs();
      if (client) { try { client.setPace(phone.pace); } catch (_) {} }
      const reason = info && info.reason;
      if (reason !== "started" && donate.phase === "joining") {
        donate.phase = "stopped";   // a join landing later leaves this line alone
        donate.message = "Setup closed. Nothing is using your CPU.";
        donate.tone = "dim";
        releaseWakeLock();
      }
      paintDonate();
      paintPhone();
      if (reason !== "started" && ui && ui.goBtn && ui.goBtn.isConnected) { try { ui.goBtn.focus(); } catch (_) {} }
    }
  });
  sound.play("wizard-step");
}

/* A wizard is closed here before it can be replaced or orphaned: opening a
 * second one, and rebuilding the Lab (a tab round-trip), both go through it,
 * so a stale instance never keeps its document keydown listener. */
function closeWizard() {
  const w = wizard;
  wizard = null;
  if (w && !w.isClosed()) { try { w.close(); } catch (_) {} }
}

/* The wizard's three moments. "arm" runs synchronously inside its press (the
 * wake lock and the battery hook are gesture-only things); "gate" runs after
 * the join and may veto with a message; "started" paints the running state.
 * Returning a string is a veto: the wizard prints it and starts nothing. */
function wizardHook(phase, choices) {
  readPhonePrefs();
  if (choices && typeof choices.name === "string") donate.name = safeText(choices.name, NAME_MAX);
  if (ui && ui.nameInput) ui.nameInput.value = donate.name;
  const c = ensureClient();
  if (!c) { paintDonate(); return "This browser could not start the screener."; }
  if (phase === "arm") {
    if (phone.wake) acquireWakeLock();
    if (phone.charging) hookBattery();
    donate.phase = "joining";
    donate.message = "Signing up as a contributor…";
    donate.tone = "dim";
    paintDonate();
    paintPhone();
    return true;
  }
  if (phase === "gate") {
    /* CONSENT, RE-CHECKED AFTER THE JOIN: Stop was live the whole time */
    if (donate.phase !== "joining") return "Stopped before the run began. Nothing is using your CPU.";
    if (phone.charging && phone.battery && !isCharging()) {
      phone.wantRunning = true;
      donate.phase = "paused";
      donate.message = "Waiting for a charger — “only while charging” is on. Screening starts when one is connected.";
      donate.tone = "dim";
      paintDonate();
      paintPhone();
      scheduleRefresh();
      return donate.message;
    }
    return true;
  }
  if (phase === "started") {
    donate.phase = "running";
    const joined = !(choices && choices.joined === false);
    donate.message = joined
      ? "Screening. Thank you — you can leave this tab open and forget about it."
      : "Screening. (Still trying to sign in with the server; it will retry by itself.)";
    donate.tone = joined ? "ok" : "warn";
    paintDonate();
    paintPhone();
    scheduleRefresh();
  }
  return true;
}

/* ————— 4.0: which instrument sound a client event gets ————— */

/* Keyed to the EVENT and never to a score. A conflict is the one submission
 * status with its own sound; a confirmation is rate-limited by the board.
 * "link-lost" is 'server unreachable' and nothing else: the client marks a
 * transport failure (no route, no answer in time) with `transport: true`, so
 * an unreadable unit, a screening exception, a stale engine or a canary
 * mismatch never sounds like a cut carrier. "molecule-lock" ('specimen
 * drawn') is NOT keyed here: it belongs to the code path that paints the
 * specimen (the lens), which calls the shared board's play() itself — the
 * sound and the drawing must be one event, not two gates that drift. */
const SOUND_FOR = { unit: "unit-issued", idle: "idle", stopped: "stopped", confirmed: "confirmed" };
function soundFor(ev) {
  if (ev.type === "submitted") return ev.status === "conflict" ? "conflict" : "unit-submitted";
  if (ev.type === "error") return ev.transport === true ? "link-lost" : null;
  return SOUND_FOR[ev.type] || null;
}

function stopDonating() {
  phone.wantRunning = false;
  /* a running client emits `stopped` synchronously from stop(), and that
   * handler writes the strip's "Stopped" line; only a client that was not
   * running (nothing to emit) gets the line from here — one line, never two */
  const willEmit = clientRunning();
  if (client) { try { client.stop(); } catch (_) {} }
  donate.phase = "stopped";
  donate.unitId = "";
  donate.done = 0;
  donate.total = 0;
  donate.message = "Stopped. Nothing is using your CPU.";
  donate.tone = "dim";
  if (!willEmit) viewTelemetry.push({ tag: "LAB", text: "Stopped — nothing is using this CPU" });
  releaseWakeLock();
  paintDonate();
  paintPhone();
}

/* Every event the swarm client emits, turned into one line a person can read.
 * A UI listener may never throw back into the loop, so the whole body is
 * guarded. */
/* progress arrives up to a hundred times a second on a fast device (a chunk of
 * five molecules per message); every consumer below would lay the page out
 * again for each one. The LATEST progress is delivered at most every 120 ms —
 * nothing is lost (done/total are cumulative) and nothing counts up. */
let pendingProgress = null, progressTimer = null;
function flushProgress() {
  progressTimer = null;
  const ev = pendingProgress;
  pendingProgress = null;
  if (ev) onSwarmEvent(Object.assign({}, ev, { coalesced: true }));
}

function onSwarmEvent(ev) {
  try {
    if (!ev || typeof ev.type !== "string") return;
    if (ev.type === "progress" && ev.coalesced !== true) {
      pendingProgress = ev;
      if (progressTimer === null) progressTimer = setTimeout(flushProgress, 120);
      return;
    }
    if (lens) lens.onEvent(ev);
    /* 4.0: the Observatory's SESSION LEDGER and YOUR SCOPE read the same events */
    viewObservatory.session(ev);
    const key = soundFor(ev);
    if (key) sound.play(key);
    if (ev.type === "stopped") sound.suspend();   // room tone stops on Stop; the next gesture resumes it
    if (ev.type === "spotlight") return;   // display only — the lens has it; nothing else changes
    if (ev.type === "joined") {
      /* A join can land AFTER the visitor pressed Stop — the request was
       * already in flight. Signing in costs them nothing, but the status line
       * is the one sentence they read, and while they are stopped it must go
       * on saying so rather than reporting activity they cancelled. */
      if (donate.phase !== "stopped") {
        donate.message = "Signed in as " + (safeText(ev.name, NAME_MAX) || "an anonymous contributor") + ".";
        donate.tone = "ok";
        if (ev.stored === false) donate.message += " (This browser will not remember it after a reload.)";
        viewTelemetry.push({ tag: "LAB", text: "Signed in as " + (safeText(ev.name, NAME_MAX) || "an anonymous contributor") });
      }
    } else if (ev.type === "unit") {
      donate.phase = "running";
      donate.unitId = safeText(ev.unitId, 24);
      donate.done = 0;
      donate.total = safeInt(ev.total) || 0;
      donate.message = "Screening a new work unit.";
      donate.tone = "ok";
      viewTelemetry.push({ tag: "LAB", text: "Unit " + (donate.unitId || "?") + " issued — " + groupInt(donate.total) + " molecules to screen" });
    } else if (ev.type === "progress") {
      donate.done = safeInt(ev.done) || 0;
      if (ev.total !== undefined) donate.total = safeInt(ev.total) || donate.total;
    } else if (ev.type === "submitted") {
      donate.units = safeInt(ev.units) || donate.units;
      donate.credits = safeInt(ev.credits) || donate.credits;
      donate.message = describeStatus(ev.status);
      donate.tone = ev.status === "conflict" || ev.status === "canary_failed" ? "warn" : "ok";
      const uid = safeText(ev.unitId, 24) || donate.unitId || "?";
      if (ev.status === "conflict") {
        viewTelemetry.push({ tag: "LAB", text: "Unit " + uid + " — disagreement is the system working; the unit is not lost, a third browser settles it" });
      } else if (ev.status !== "confirmed") {
        /* a submit the server confirmed on the spot is followed, in the same
         * tick, by the client's own `confirmed` event — the CONF line and the
         * YOU tally are written there, once, never here as well */
        viewTelemetry.push({ tag: "LAB", text: "Unit " + uid + " fingerprint sent — waiting for a second volunteer" });
      }
      if (ev.status !== "confirmed") pushSessionLine();
      scheduleRefresh();
    } else if (ev.type === "confirmed") {
      donate.confirmed = safeInt(ev.confirmed) || donate.confirmed + 1;
      donate.credits = safeInt(ev.credits) || donate.credits;
      donate.message = "A second volunteer agreed with your result — that unit is confirmed.";
      donate.tone = "ok";
      viewTelemetry.push({ tag: "CONF", text: "Unit " + (safeText(ev.unitId, 24) || donate.unitId || "?") + " — a second volunteer's browser produced the same fingerprint as yours. Those molecules are now on the record." });
      pushSessionLine();
      scheduleRefresh();
    } else if (ev.type === "idle") {
      donate.message = "No work units are waiting — checking again shortly.";
      donate.tone = "dim";
      viewTelemetry.push({ tag: "LAB", text: "No work units waiting — checking again shortly" });
    } else if (ev.type === "error") {
      donate.message = safeText(ev.message, 140) || "Something went wrong; retrying.";
      donate.tone = "warn";
      viewTelemetry.push({ tag: "LAB", text: "Retrying — " + (safeText(ev.message, 120) || "something went wrong") });
    } else if (ev.type === "stopped") {
      donate.phase = "stopped";
      donate.unitId = "";
      donate.done = 0;
      donate.total = 0;
      if (donate.tone !== "warn") { donate.message = "Stopped. Nothing is using your CPU."; donate.tone = "dim"; }
      /* the frames still waiting for the strip describe a run that is over —
       * the log keeps every line; the strip says "Stopped" now */
      viewTelemetry.drop("LAB");
      viewTelemetry.drop("YOU");
      viewTelemetry.push({ tag: "LAB", text: "Stopped — nothing is using this CPU" });
      /* The screen may sleep again whatever stopped the loop. */
      releaseWakeLock();
    } else if (ev.type === "team") {
      /* the stored team changed — the panels catch up on the next refresh */
      scheduleRefresh();
    } else if (ev.type === "left") {
      resetRecord();
      donate.phase = "stopped";
      donate.unitId = "";
      donate.done = 0;
      donate.total = 0;
      donate.units = 0;
      donate.confirmed = 0;
      donate.credits = 0;
      donate.message = "You have left the swarm. Nothing is using your CPU.";
      donate.tone = "dim";
      paintTeams();
      paintRecord();
    }
    /* the readouts repaint at most every 120 ms behind a stream of events
     * (a fast device submits several units a second); a stop paints at once */
    if (ev.type === "stopped" || ev.type === "left" || ev.type === "error") paintDonate(); else schedulePaintDonate();
  } catch (_) { /* the UI's problem, never the swarm's */ }
}

function pushSessionLine() {
  viewTelemetry.push({ tag: "YOU", text: "This session: " + groupInt(donate.units) + (donate.units === 1 ? " unit" : " units") + " · " + groupInt(donate.confirmed) + " confirmed · " + groupInt(donate.credits) + " credits" });
}

function describeStatus(status) {
  if (status === "confirmed") return "Confirmed — a second volunteer produced the same fingerprint.";
  if (status === "conflict") return "Your result disagreed with another volunteer's; the unit goes back out to a third.";
  if (status === "canary_failed") return "That unit was a check unit with a known answer, and the answer did not match.";
  return "Submitted — waiting for a second volunteer to agree.";
}

let refreshQueued = false;
let paintTimer = null;
function schedulePaintDonate() {
  if (paintTimer !== null) return;
  paintTimer = setTimeout(() => { paintTimer = null; if (attached()) paintDonate(); }, 120);
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  /* a running client submits units several times a second on a fast device;
   * one forced refresh every five seconds keeps the record honest without
   * rebuilding every panel behind every submit (the strip polls anyway) */
  setTimeout(() => { refreshQueued = false; if (attached()) refresh(); }, clientRunning() ? 5000 : 1200);
}

function paintDonate() {
  if (!ui || !ui.status) return;
  const running = clientRunning() || donate.phase === "joining";
  if (lens) lens.setRunning(clientRunning());
  ui.goBtn.disabled = running;
  ui.goBtn.textContent = donate.phase === "joining" ? "Starting…" : "Donate this browser";
  if (ui.setupBtn) ui.setupBtn.disabled = running;
  ui.stopBtn.disabled = !running;
  ui.stopBtn.hidden = !running;
  ui.nameInput.disabled = running;

  ui.status.className = "lab-status lab-status-" + donate.tone;
  ui.status.textContent = donate.message ||
    "Nothing is running. Press the button and this browser joins the swarm; press Stop and it leaves.";

  const total = donate.total > 0 ? donate.total : 0;
  const done = total ? Math.min(donate.done, total) : 0;
  ui.unitBar.set(total ? done / total : 0,
    total ? (donate.unitId || "unit") + " · " + groupInt(done) + " / " + groupInt(total) + " molecules" : (donate.unitId || "—"));
  ui.unitsLed.set(groupInt(donate.units));
  ui.confirmedLed.set(groupInt(donate.confirmed));
  ui.creditsLed.set(groupInt(donate.credits));
  viewTelemetry.session({ units: donate.units, confirmed: donate.confirmed, credits: donate.credits });
  viewTelemetry.running(clientRunning());
}

/* ————— section 4b: on a phone or tablet ————— */

/* The screen wake lock. Requested ONLY from inside a press (the toggle, or
 * the Donate button) or when the page comes back into view while the swarm is
 * running; released whenever screening stops or the toggle goes off. A
 * browser without the API says so and the toggle is disabled — nothing is
 * faked. */
function wakeLockApi() {
  try {
    return typeof navigator !== "undefined" && navigator.wakeLock && typeof navigator.wakeLock.request === "function"
      ? navigator.wakeLock : null;
  } catch (_) { return null; }
}

async function acquireWakeLock() {
  const api = wakeLockApi();
  if (!api || !phone.wake) return;
  if (phone.sentinel && phone.sentinel.released !== true) return;
  try {
    const s = await api.request("screen");
    phone.sentinel = s;
    phone.wakeNote = "the screen stays on while this page is in front";
    try {
      s.addEventListener("release", () => {
        if (phone.sentinel === s) { phone.sentinel = null; phone.wakeNote = "released — the screen may sleep"; }
        paintPhone();
      });
    } catch (_) {}
  } catch (_) {
    phone.sentinel = null;
    phone.wakeNote = "the browser refused to keep the screen awake just now";
  }
  paintPhone();
}

async function releaseWakeLock() {
  const s = phone.sentinel;
  phone.sentinel = null;
  if (s) {
    try { await s.release(); } catch (_) {}
    phone.wakeNote = "released — the screen may sleep";
  }
  paintPhone();
}

/* The charging gate. When the visitor asks for it, an unplugged device pauses
 * the loop and a charger resumes it — but ONLY if the loop was running when
 * power went away. A stopped swarm never starts because a cable was plugged
 * in; consent is a press, not a plug. */
function batteryApi() {
  try { return typeof navigator !== "undefined" && typeof navigator.getBattery === "function"; }
  catch (_) { return false; }
}

async function hookBattery() {
  if (phone.battery) return phone.battery;
  if (!batteryApi()) return null;
  try {
    const b = await navigator.getBattery();
    if (!b) return null;
    phone.battery = b;
    try { b.addEventListener("chargingchange", onChargingChange); } catch (_) {}
    onChargingChange();
    return b;
  } catch (_) {
    phone.battery = null;
    phone.chargeNote = "the browser would not report the battery";
    paintPhone();
    return null;
  }
}

/* Unknown never pauses anyone: only a battery that says "not charging" does. */
function isCharging() {
  const b = phone.battery;
  return !b || b.charging !== false;
}

function onChargingChange() {
  try {
    if (!phone.charging) { paintPhone(); return; }
    if (!isCharging()) {
      if (clientRunning()) { phone.wantRunning = true; pauseForPower(); }
      phone.chargeNote = phone.wantRunning
        ? "unplugged — paused until a charger is connected"
        : "unplugged — screening stays off until you plug in and press Donate";
    } else if (phone.wantRunning) {
      phone.wantRunning = false;
      resumeFromPower();
      phone.chargeNote = "charging — screening again";
    } else {
      phone.chargeNote = "charging";
    }
    paintPhone();
  } catch (_) { /* a battery event may never take the page down */ }
}

function pauseForPower() {
  if (client) { try { client.stop(); } catch (_) {} }
  donate.phase = "paused";
  donate.unitId = "";
  donate.done = 0;
  donate.total = 0;
  donate.message = "Paused — unplugged. Screening resumes when a charger is connected.";
  donate.tone = "dim";
  paintDonate();
}

function resumeFromPower() {
  const c = ensureClient();
  if (!c) return;
  runClient(c);
  donate.phase = "running";
  donate.message = "Charger connected — screening again.";
  donate.tone = "ok";
  paintDonate();
  if (phone.wake) acquireWakeLock();
}

/* The install prompt. Chromium fires beforeinstallprompt early — often before
 * the Lab exists — so it is captured at module scope and shown when the panel
 * is built. Capturing an event is not a request for anything. */
let deferredInstall = null;
function installed() {
  try {
    if (typeof navigator !== "undefined" && navigator.standalone === true) return true;
    return typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  } catch (_) { return false; }
}
try {
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeinstallprompt", (ev) => {
      try { ev.preventDefault(); } catch (_) {}
      deferredInstall = ev;
      paintInstall();
    });
    window.addEventListener("appinstalled", () => { deferredInstall = null; paintInstall(); });
  }
} catch (_) {}

const PHONE_COPY = [
  "A phone or tablet can screen molecules too. It only works while this page is open: plug it in, " +
  "tap Donate this browser, and leave it on the nightstand.",
  "It stops the moment you close the page, and it never starts on its own. The settings below are " +
  "remembered on this device; none of them starts anything."
];

function toggleRow(label, checked, onChange) {
  const row = labEl("label", "lab-toggle");
  const box = labEl("input");
  box.type = "checkbox";
  box.checked = checked;
  box.addEventListener("change", () => { onChange(box.checked); });
  row.appendChild(box);
  const text = labEl("span", "lab-toggle-text");
  text.appendChild(labEl("span", "lab-toggle-label", label));
  const note = labEl("span", "lab-toggle-note");
  text.appendChild(note);
  row.appendChild(text);
  return { row, box, note };
}

function buildPhone(root) {
  const sec = labEl("section", "lab-section");
  sec.setAttribute("data-lab", "phone");
  sec.appendChild(labEl("h3", "sect", "On a phone or tablet"));
  const panel = labEl("div", "lab-panel");
  for (const line of PHONE_COPY) panel.appendChild(labEl("p", "lab-lede lab-phone-copy", line));

  /* keep the screen awake */
  const wake = toggleRow("Keep the screen awake", phone.wake, (on) => {
    /* the change event of a checkbox is a user gesture: this is the one place
     * a wake lock is first requested */
    phone.wake = on;
    writePhonePrefs();
    if (on) acquireWakeLock();
    else releaseWakeLock();
    paintPhone();
  });
  wake.box.setAttribute("data-pref", "wake");
  if (!wakeLockApi()) {
    wake.box.disabled = true;
    wake.box.checked = false;
    wake.row.classList.add("lab-toggle-off");
  }
  panel.appendChild(wake.row);

  /* only while charging */
  const charge = toggleRow("Only while charging", phone.charging, (on) => {
    phone.charging = on;
    writePhonePrefs();
    if (on) {
      hookBattery();
    } else {
      /* lifting the gate while it holds a paused loop hands the loop back */
      if (phone.wantRunning) { phone.wantRunning = false; resumeFromPower(); }
      phone.chargeNote = "";
    }
    paintPhone();
  });
  charge.box.setAttribute("data-pref", "charging");
  if (!batteryApi()) {
    charge.box.disabled = true;
    charge.box.checked = false;
    charge.row.classList.add("lab-toggle-off");
  }
  panel.appendChild(charge.row);

  /* pace */
  const paceWrap = labEl("div", "lab-pace");
  paceWrap.appendChild(labEl("div", "lab-pace-title", "Pace"));
  const paceOpts = labEl("div", "lab-pace-opts");
  const radios = [];
  for (const [key, ms, label, note] of PACES) {
    const opt = labEl("label", "lab-pace-opt");
    const r = labEl("input");
    r.type = "radio";
    r.name = "lab-pace";
    r.value = String(ms);
    r.setAttribute("data-pace", key);
    r.checked = phone.pace === ms;
    r.addEventListener("change", () => {
      if (!r.checked) return;
      phone.pace = ms;
      writePhonePrefs();
      if (client) { try { client.setPace(ms); } catch (_) {} }
      paintPhone();
    });
    opt.appendChild(r);
    const t = labEl("span", "lab-toggle-text");
    t.appendChild(labEl("span", "lab-toggle-label", label));
    t.appendChild(labEl("span", "lab-toggle-note", note));
    opt.appendChild(t);
    paceOpts.appendChild(opt);
    radios.push(r);
  }
  paceWrap.appendChild(paceOpts);
  panel.appendChild(paceWrap);

  /* install */
  const install = labEl("div", "lab-install");
  install.appendChild(labEl("div", "lab-pace-title", "Install"));
  const installHost = labEl("div", "lab-install-host");
  install.appendChild(installHost);
  panel.appendChild(install);

  sec.appendChild(panel);
  root.appendChild(sec);

  ui.wakeBox = wake.box;
  ui.wakeNote = wake.note;
  ui.chargeBox = charge.box;
  ui.chargeNote = charge.note;
  ui.paceRadios = radios;
  ui.installHost = installHost;
  paintPhone();
  paintInstall();
}

function paintPhone() {
  if (!ui || !ui.wakeBox) return;
  if (!wakeLockApi()) {
    ui.wakeNote.textContent = "this browser cannot keep the screen awake";
  } else if (!phone.wake) {
    ui.wakeNote.textContent = "off — the screen sleeps as usual";
  } else if (phone.sentinel && phone.sentinel.released !== true) {
    ui.wakeNote.textContent = phone.wakeNote || "the screen stays on while this page is in front";
  } else {
    ui.wakeNote.textContent = phone.wakeNote || "on — requested when you tap Donate this browser";
  }
  ui.wakeBox.checked = !!wakeLockApi() && phone.wake;

  if (!batteryApi()) {
    ui.chargeNote.textContent = "not available on this browser — unplugging will not pause it";
  } else if (!phone.charging) {
    ui.chargeNote.textContent = "off — screening continues on battery";
  } else {
    ui.chargeNote.textContent = phone.chargeNote || "on — unplug and screening pauses; plug in and it resumes only if it was running";
  }
  ui.chargeBox.checked = batteryApi() && phone.charging;

  for (const r of ui.paceRadios) r.checked = Number(r.value) === phone.pace;
}

function paintInstall() {
  const host = ui && ui.installHost;
  if (!host) return;
  host.textContent = "";
  if (installed()) {
    host.appendChild(labEl("p", "lab-note lab-install-note", "Installed — this page is running as an app on this device."));
    return;
  }
  if (deferredInstall) {
    const b = labEl("button", "lab-btn lab-btn-secondary", "Add to home screen");
    b.addEventListener("click", async () => {
      const ev = deferredInstall;
      if (!ev) return;
      try { await ev.prompt(); } catch (_) {}
      deferredInstall = null;
      paintInstall();
    });
    host.appendChild(b);
    host.appendChild(labEl("p", "lab-note lab-install-note", "Puts an icon on the home screen; the page still needs to be open to screen."));
    return;
  }
  host.appendChild(labEl("p", "lab-note lab-install-note",
    "On iPhone: Share → Add to Home Screen. On Android: browser menu → Install app."));
}

/* ————— section 4c: teams ————— */

function setTeamMsg(text, tone) {
  team.message = text;
  team.tone = tone || "dim";
  paintTeams();
}

function teamError(code) {
  if (code === "bad_name") return "That team name is not allowed — up to 24 plain characters.";
  if (code === "already_in_team") return "You are already in a team. Leave it first to join another.";
  if (code === "bad_code") return "A team code is 8 letters and digits, with no 0, O, 1 or I.";
  if (code === "unknown_team") return "No team has that code.";
  if (code === "team_full") return "That team is full.";
  if (code === "not_in_team") return "You are not in a team.";
  if (code === "rate_limited") return "The server asked us to slow down — try again in a minute.";
  if (code === "not_joined") return "Sign in first — tap Donate this browser once.";
  return "The server answered: " + (safeText(code, 60) || "unknown error") + ".";
}

/* A team action needs a token. A visitor who has never pressed Donate is
 * signed up first (with whatever name they typed) — that costs no CPU. */
async function ensureJoined() {
  const c = ensureClient();
  if (!c) return null;
  if (c.status().joined) return c;
  const who = await c.join(donate.name);
  return who ? c : null;
}

async function createTeam() {
  if (team.busy) return;
  const name = (ui.teamNameInput.value || "").trim().slice(0, TEAM_NAME_MAX);
  if (!name) { setTeamMsg("Give the team a name — up to 24 characters.", "warn"); return; }
  team.busy = true;
  setTeamMsg("Creating the team…", "dim");
  try {
    const c = await ensureJoined();
    if (!c) { setTeamMsg("Could not sign in with the server, so no team was created.", "warn"); return; }
    const res = await c.teamCreate(name);
    if (!res.ok) { setTeamMsg(teamError(res.error), "warn"); return; }
    applyTeamPayload(res.data);
    ui.teamNameInput.value = "";
    await refreshTeam();
    setTeamMsg("Team created. Share the link — anyone who joins with it counts toward the team.", "ok");
    scheduleRefresh();
  } finally {
    team.busy = false;
    paintTeams();
    paintRecord();
  }
}

async function joinTeam() {
  if (team.busy) return;
  const code = safeCode(ui.teamCodeInput.value || "");
  if (!code) { setTeamMsg(teamError("bad_code"), "warn"); return; }
  team.busy = true;
  setTeamMsg("Joining…", "dim");
  try {
    const c = await ensureJoined();
    if (!c) { setTeamMsg("Could not sign in with the server, so nothing was joined.", "warn"); return; }
    const res = await c.teamJoin(code);
    if (!res.ok) { setTeamMsg(teamError(res.error), "warn"); return; }
    applyTeamPayload(res.data);
    await refreshTeam();
    setTeamMsg("Joined. Your units now count toward the team as well as your own record.", "ok");
    scheduleRefresh();
  } finally {
    team.busy = false;
    paintTeams();
    paintRecord();
  }
}

async function leaveTeam() {
  if (team.busy) return;
  const c = ensureClient();
  if (!c || !c.status().joined) { setTeamMsg(teamError("not_joined"), "warn"); return; }
  team.busy = true;
  setTeamMsg("Leaving the team…", "dim");
  try {
    const res = await c.teamLeave();
    if (!res.ok) { setTeamMsg(teamError(res.error), "warn"); return; }
    team.own = null;
    record.team = null;
    team.board = [];
    team.boardCode = "";
    team.boardName = "";
    await refreshTeam();
    setTeamMsg("You have left the team. Your own record is unchanged.", "ok");
    scheduleRefresh();
  } finally {
    team.busy = false;
    paintTeams();
    paintRecord();
  }
}

function applyTeamPayload(data) {
  const info = shapeTeamInfo(isPlainObject(data) ? data.team : null);
  team.own = info && info.code ? info : null;
  record.team = team.own ? { code: team.own.code, name: team.own.name } : null;
  team.board = [];
  team.boardCode = "";
  team.boardName = "";
}

/* A share link: the URL as plain text in a read-only field plus a Copy
 * button. Copy uses the clipboard when the browser allows it and otherwise
 * selects the text so the visitor can copy it themselves — nothing is faked. */
function shareRow(label, url) {
  const wrap = labEl("div", "lab-share");
  wrap.appendChild(labEl("span", "lab-share-label", label));
  const field = labEl("input", "lab-share-field");
  field.type = "text";
  field.readOnly = true;
  field.value = url;
  field.setAttribute("aria-label", label);
  field.addEventListener("focus", () => { try { field.select(); } catch (_) {} });
  wrap.appendChild(field);
  const btn = labEl("button", "lab-btn lab-btn-secondary lab-copy", "Copy");
  btn.addEventListener("click", async () => {
    let done = false;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(url);
        done = true;
      }
    } catch (_) { done = false; }
    if (!done) {
      try { field.focus(); field.select(); field.setSelectionRange(0, url.length); } catch (_) {}
    }
    btn.textContent = done ? "Copied" : "Selected — copy it";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
  wrap.appendChild(btn);
  return wrap;
}

function rowsTable(rows, nameHeader) {
  const table = labEl("div", "lab-board");
  const head = labEl("div", "lab-board-row lab-board-head");
  head.appendChild(labEl("span", "lab-b-rank", "#"));
  head.appendChild(labEl("span", "lab-b-name", nameHeader));
  head.appendChild(labEl("span", "lab-b-num", "units"));
  head.appendChild(labEl("span", "lab-b-num", "credits"));
  table.appendChild(head);
  let rank = 0;
  for (const row of rows) {
    rank++;
    const r = labEl("div", "lab-board-row");
    r.appendChild(labEl("span", "lab-b-rank", String(rank)));
    /* A span, never an anchor: these names are typed by strangers. */
    r.appendChild(labEl("span", "lab-b-name", row.name));
    r.appendChild(labEl("span", "lab-b-num", groupInt(row.units)));
    r.appendChild(labEl("span", "lab-b-num", groupInt(row.credits)));
    table.appendChild(r);
  }
  return table;
}

function buildTeams(root) {
  const sec = labEl("section", "lab-section");
  sec.setAttribute("data-lab", "teams");
  sec.appendChild(labEl("h3", "sect", "Teams"));
  sec.appendChild(labEl("p", "lab-lede",
    "A team is a shared tally: a household, a lab group, a classroom. Units and credits are still yours — " +
    "the team simply adds them up. Teams count work, never luck, exactly as contributors do."));

  const panel = labEl("div", "lab-panel");

  const card = labEl("div", "lab-team-card");
  panel.appendChild(card);

  /* the forms are built once and shown or hidden, so typed text survives a
   * repaint */
  const forms = labEl("div", "lab-team-forms");

  const createForm = labEl("div", "lab-form");
  createForm.appendChild(labEl("div", "lab-form-title", "Start a team"));
  const createRow = labEl("div", "lab-actions");
  const nameInput = labEl("input", "lab-name");
  nameInput.type = "text";
  nameInput.maxLength = TEAM_NAME_MAX;
  nameInput.placeholder = "Team name (up to 24 characters)";
  nameInput.setAttribute("aria-label", "Team name");
  nameInput.setAttribute("data-team", "name");
  createRow.appendChild(nameInput);
  const createBtn = labEl("button", "lab-btn lab-btn-secondary", "Create team");
  createBtn.setAttribute("data-team", "create");
  createBtn.addEventListener("click", () => { createTeam(); });
  createRow.appendChild(createBtn);
  createForm.appendChild(createRow);
  forms.appendChild(createForm);

  const joinForm = labEl("div", "lab-form");
  joinForm.appendChild(labEl("div", "lab-form-title", "Join a team"));
  const joinRow = labEl("div", "lab-actions");
  const codeInput = labEl("input", "lab-name lab-code");
  codeInput.type = "text";
  codeInput.maxLength = 8;
  codeInput.placeholder = "8-character team code";
  codeInput.autocapitalize = "characters";
  codeInput.spellcheck = false;
  codeInput.setAttribute("aria-label", "Team code");
  codeInput.setAttribute("data-team", "code");
  codeInput.value = team.inviteCode;
  codeInput.addEventListener("input", () => {
    const v = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (v !== codeInput.value) codeInput.value = v;
  });
  joinRow.appendChild(codeInput);
  const joinBtn = labEl("button", "lab-btn lab-btn-secondary", "Join team");
  joinBtn.setAttribute("data-team", "join");
  joinBtn.addEventListener("click", () => { joinTeam(); });
  joinRow.appendChild(joinBtn);
  joinForm.appendChild(joinRow);
  forms.appendChild(joinForm);

  panel.appendChild(forms);

  const msg = labEl("p", "lab-status");
  panel.appendChild(msg);

  const boardHost = labEl("div", "lab-team-board");
  panel.appendChild(boardHost);

  sec.appendChild(panel);

  const topHost = labEl("div", "lab-team-top");
  sec.appendChild(topHost);

  root.appendChild(sec);

  ui.teamCard = card;
  ui.teamForms = forms;
  ui.teamNameInput = nameInput;
  ui.teamCodeInput = codeInput;
  ui.teamCreateBtn = createBtn;
  ui.teamJoinBtn = joinBtn;
  ui.teamMsg = msg;
  ui.teamBoardHost = boardHost;
  ui.teamTopHost = topHost;
  paintTeams();
}

function paintTeams() {
  if (!ui || !ui.teamCard) return;
  const card = ui.teamCard;
  card.textContent = "";
  const own = team.own;

  if (own) {
    card.appendChild(labEl("div", "lab-team-name", own.name));
    const codeLine = labEl("div", "lab-team-codeline");
    codeLine.appendChild(labEl("span", "lab-read-k", "code "));
    codeLine.appendChild(labEl("span", "lab-team-code", own.code || "—"));
    card.appendChild(codeLine);
    const rows = [
      ["members", groupInt(own.members)],
      ["units", groupInt(own.units)],
      ["credits", groupInt(own.credits)]
    ];
    if (own.since) rows.push(["since", own.since]);
    const readout = labEl("div", "lab-readout");
    for (const [k, v] of rows) {
      const row = labEl("div", "lab-read-row");
      row.appendChild(labEl("span", "lab-read-k", k));
      row.appendChild(labEl("span", "lab-read-v", v));
      readout.appendChild(row);
    }
    card.appendChild(readout);
    /* THE LINK RULE: a share link is built only from a code that matched the
     * server's own alphabet; a team whose code did not gets no link. */
    if (own.code) card.appendChild(shareRow("Invite link", shareUrl("team", own.code)));
    const leave = labEl("button", "lab-btn lab-btn-stop", "Leave team");
    leave.setAttribute("data-team", "leave");
    leave.disabled = team.busy;
    leave.addEventListener("click", () => { leaveTeam(); });
    card.appendChild(leave);
    ui.teamForms.hidden = true;
  } else {
    if (team.invited) {
      card.appendChild(labEl("p", "lab-team-invite",
        "Invited to team " + (team.invited.name || "(unnamed)") + " — code " + team.invited.code + ". Joining still takes the button below."));
    } else if (team.inviteCode && team.inviteError) {
      card.appendChild(labEl("p", "lab-team-invite lab-status-warn", "This invitation could not be checked: " + team.inviteError + "."));
    } else if (team.inviteCode) {
      card.appendChild(labEl("p", "lab-team-invite", "Checking the invitation…"));
    } else {
      card.appendChild(labEl("p", "lab-empty", "You are not in a team."));
    }
    ui.teamForms.hidden = false;
    ui.teamCreateBtn.disabled = team.busy;
    ui.teamJoinBtn.disabled = team.busy;
  }

  ui.teamMsg.className = "lab-status lab-status-" + team.tone;
  ui.teamMsg.textContent = team.message;

  const bh = ui.teamBoardHost;
  bh.textContent = "";
  if (team.boardCode) {
    bh.appendChild(labEl("div", "lab-form-title", "Team board — " + (team.boardName || team.boardCode)));
    if (team.board.length) bh.appendChild(rowsTable(team.board, "member"));
    else bh.appendChild(labEl("p", "lab-empty", "Nobody on this team has finished a unit yet."));
  }

  const th = ui.teamTopHost;
  th.textContent = "";
  if (team.top.length) {
    th.appendChild(labEl("div", "lab-form-title", "Top teams"));
    const table = labEl("div", "lab-board");
    const head = labEl("div", "lab-board-row lab-board-head lab-team-row");
    head.appendChild(labEl("span", "lab-b-rank", "#"));
    head.appendChild(labEl("span", "lab-b-name", "team"));
    head.appendChild(labEl("span", "lab-b-num", "members"));
    head.appendChild(labEl("span", "lab-b-num", "units"));
    head.appendChild(labEl("span", "lab-b-num", "credits"));
    table.appendChild(head);
    let rank = 0;
    for (const t of team.top) {
      rank++;
      const r = labEl("div", "lab-board-row lab-team-row");
      r.appendChild(labEl("span", "lab-b-rank", String(rank)));
      r.appendChild(labEl("span", "lab-b-name", t.name));
      r.appendChild(labEl("span", "lab-b-num", groupInt(t.members)));
      r.appendChild(labEl("span", "lab-b-num", groupInt(t.units)));
      r.appendChild(labEl("span", "lab-b-num", groupInt(t.credits)));
      table.appendChild(r);
    }
    th.appendChild(table);
    th.appendChild(labEl("p", "lab-note", "Team names are chosen by their members and shown as plain text."));
  }
}

/* ————— section 4d: your record ————— */

function badgeStrip(units) {
  const strip = labEl("div", "lab-badges");
  for (const b of badgesFor(units)) {
    const chip = labEl("span", "lab-badge" + (b.earned ? " lab-badge-on" : " lab-badge-off"), b.label);
    chip.setAttribute("data-badge", String(b.n));
    chip.setAttribute("data-earned", b.earned ? "1" : "0");
    chip.title = (b.earned ? "earned — " : "not yet — ") + groupInt(b.n) + (b.n === 1 ? " unit" : " units");
    strip.appendChild(chip);
  }
  return strip;
}

function buildRecord(root) {
  const sec = labEl("section", "lab-section");
  sec.setAttribute("data-lab", "record");
  sec.appendChild(labEl("h3", "sect", "Your record"));
  sec.appendChild(labEl("p", "lab-lede",
    "What this browser has done for the swarm, as the server counts it. " +
    "Badges count work, never luck: they mark units screened, and there is no badge for a hit, " +
    "because a unit with a promising molecule in it was not screened any harder than one without."));
  const panel = labEl("div", "lab-panel");
  const host = labEl("div", "lab-record-host");
  panel.appendChild(host);
  const msg = labEl("p", "lab-status");
  panel.appendChild(msg);
  const leaveBtn = labEl("button", "lab-btn lab-btn-stop", "Leave the swarm");
  leaveBtn.setAttribute("data-record", "leave");
  leaveBtn.addEventListener("click", () => { onLeaveClick(); });
  panel.appendChild(leaveBtn);
  panel.appendChild(labEl("p", "lab-note",
    "Leaving hides your name from every board and makes this browser forget its token. " +
    "Work that two volunteers already verified stays counted in the totals — it was real, and it stays real."));
  sec.appendChild(panel);
  root.appendChild(sec);
  ui.recordHost = host;
  ui.recordMsg = msg;
  ui.leaveBtn = leaveBtn;
  paintRecord();
}

function paintRecord() {
  const host = ui && ui.recordHost;
  if (!host) return;
  host.textContent = "";
  const joined = !!(client && client.status().joined);
  if (record.known) {
    const rows = [
      ["id", record.id || "—"],
      ["name", record.name || "anonymous"],
      ["units", groupInt(record.units)],
      ["credits", groupInt(record.credits)],
      ["team", record.team ? record.team.name + (record.team.code ? " (" + record.team.code + ")" : "") : "none"],
      ["since", record.since || "—"]
    ];
    const readout = labEl("div", "lab-readout");
    for (const [k, v] of rows) {
      const row = labEl("div", "lab-read-row");
      row.appendChild(labEl("span", "lab-read-k", k));
      row.appendChild(labEl("span", "lab-read-v", v));
      readout.appendChild(row);
    }
    host.appendChild(readout);
    host.appendChild(badgeStrip(record.units));
    /* THE LINK RULE: a record link is built only from an id that is canonical
     * decimal. */
    if (record.id) host.appendChild(shareRow("Your public record", shareUrl("c", record.id)));
    if (record.error) host.appendChild(labEl("p", "lab-note", "The last refresh did not succeed (" + record.error + ") — showing the last record we fetched."));
    ui.leaveBtn.hidden = false;
  } else if (joined) {
    host.appendChild(labEl("p", "lab-empty", record.error
      ? "Your record could not be fetched (" + record.error + "). This panel retries by itself."
      : "Fetching your record…"));
    ui.leaveBtn.hidden = false;
  } else {
    host.appendChild(labEl("p", "lab-empty",
      "No record yet. One is created the moment you tap Donate this browser and sign in — " +
      "no account, no email, just a token this browser keeps."));
    ui.leaveBtn.hidden = true;
  }
  ui.leaveBtn.textContent = record.confirmArmed ? "Tap again to leave" : "Leave the swarm";
  ui.recordMsg.className = "lab-status lab-status-" + record.tone;
  ui.recordMsg.textContent = record.message;
}

/* Leaving takes two presses within ten seconds. One press explains; the
 * second one acts. A timer lets a single press lapse back to nothing. */
function onLeaveClick() {
  const now = Date.now();
  if (!record.confirmArmed || now - record.confirmArmed > LEAVE_CONFIRM_MS) {
    record.confirmArmed = now;
    record.message = "Tap again within 10 seconds to leave the swarm. Your verified work stays counted; " +
      "your name comes off every board and this browser forgets your token.";
    record.tone = "warn";
    paintRecord();
    setTimeout(() => {
      if (record.confirmArmed && Date.now() - record.confirmArmed >= LEAVE_CONFIRM_MS) {
        record.confirmArmed = 0;
        record.message = "";
        record.tone = "dim";
        paintRecord();
      }
    }, LEAVE_CONFIRM_MS + 250);
    return;
  }
  record.confirmArmed = 0;
  leaveSwarm();
}

async function leaveSwarm() {
  const c = ensureClient();
  if (!c) return;
  record.message = "Leaving…";
  record.tone = "dim";
  paintRecord();
  const res = await c.leave();
  if (!res.ok) {
    record.message = "Could not leave: " + teamError(res.error);
    record.tone = "warn";
    paintRecord();
    return;
  }
  /* the client's `left` event has already reset the record and the team */
  record.message = "You have left the swarm. Verified work stays counted; your name is off the boards, " +
    "and this browser has forgotten your token.";
  record.tone = "ok";
  paintRecord();
  paintTeams();
  paintDonate();
  scheduleRefresh();
}

/* ————— section 0: a public contributor record (?c=<id>) ————— */

async function loadProfile() {
  if (!profile.id) return;
  profile.state = "loading";
  paintProfile();
  const res = await apiGet("contributor", { id: profile.id });
  if (!res.ok) {
    profile.state = res.status === 404 ? "missing" : "error";
    profile.error = safeText(res.error, 80);
  } else {
    const c = shapeContributor(res.data.contributor);
    if (c) { profile.state = "ok"; profile.data = c; }
    else { profile.state = "error"; profile.error = "the server did not describe this contributor"; }
  }
  paintProfile();
}

function buildProfile(root) {
  const sec = labEl("section", "lab-section lab-profile");
  sec.setAttribute("data-lab", "profile");
  sec.appendChild(labEl("h3", "sect", "Contributor record"));
  const host = labEl("div", "lab-panel lab-profile-host");
  sec.appendChild(host);
  root.appendChild(sec);
  ui.profileHost = host;
  paintProfile();
}

function paintProfile() {
  const host = ui && ui.profileHost;
  if (!host) return;
  host.textContent = "";
  if (profile.state === "loading" || profile.state === "idle") {
    host.appendChild(labEl("p", "lab-empty", "Looking up contributor " + profile.id + "…"));
    return;
  }
  if (profile.state === "missing") {
    host.appendChild(labEl("p", "lab-empty lab-profile-missing", "No such contributor."));
    host.appendChild(labEl("p", "lab-note", "The record may have been removed by its owner, or the link may be wrong."));
    return;
  }
  if (profile.state !== "ok" || !profile.data) {
    host.appendChild(labEl("p", "lab-empty", "This record could not be fetched" + (profile.error ? " (" + profile.error + ")" : "") + "."));
    return;
  }
  const d = profile.data;
  host.appendChild(labEl("div", "lab-profile-name", d.name));
  const rows = [
    ["rank", d.rank === null ? "—" : "#" + groupInt(d.rank)],
    ["units", groupInt(d.units)],
    ["credits", groupInt(d.credits)],
    ["team", d.team ? d.team.name + (d.team.code ? " (" + d.team.code + ")" : "") : "none"],
    ["since", d.since || "—"]
  ];
  const readout = labEl("div", "lab-readout");
  for (const [k, v] of rows) {
    const row = labEl("div", "lab-read-row");
    row.appendChild(labEl("span", "lab-read-k", k));
    row.appendChild(labEl("span", "lab-read-v", v));
    readout.appendChild(row);
  }
  host.appendChild(readout);
  host.appendChild(badgeStrip(d.units));
  host.appendChild(labEl("p", "lab-note",
    "Rank and badges count verified units — work, never luck. Names are chosen by contributors and shown as plain text."));
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
  host.appendChild(rowsTable(board, "contributor"));
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
  if (lens && remote.hits) lens.setHits(remote.hits);
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

let prefsRead = false;

export function renderLab(root, options) {
  /* Nothing in this module may take the page down, and that includes a caller
   * handing it something that is not an element. Refuse, do not throw, and do
   * not leave module state half-changed behind the refusal. */
  if (!root || typeof root.appendChild !== "function") return null;

  const opts = isPlainObject(options) ? options : {};
  if (typeof opts.apiBase === "string" && opts.apiBase) apiBase = opts.apiBase;

  /* Remembered preferences are read once. Reading them starts nothing. */
  if (!prefsRead) { prefsRead = true; readPhonePrefs(); }

  /* Deep links are validated before anything is built from them. */
  const links = deepLinks();
  if (links.team && !team.inviteCode) team.inviteCode = links.team;
  if (links.c && profile.id !== links.c) { profile.id = links.c; profile.state = "idle"; profile.data = null; }

  /* A wizard left open on the previous render is closed before the new DOM
   * exists: it must not outlive its host with a live Escape listener. */
  closeWizard();

  const wrap = labEl("div", "lab");
  ui = { root: wrap };

  if (profile.id) buildProfile(wrap);
  buildIntro(wrap);
  buildConsole(wrap);
  buildLens(wrap);
  buildStats(wrap);
  buildContribute(wrap);
  buildPhone(wrap);
  buildTeams(wrap);
  buildRecord(wrap);
  buildBoard(wrap);
  buildHits(wrap);

  wrap.appendChild(labEl("p", "disclaimer",
    "LongevityOS reports published research and screens public chemical data. " +
    "Its screening output is a shortlist of hypotheses for researchers, never a finding about a substance, " +
    "and nothing here is medical advice."));

  root.appendChild(wrap);

  hookVisibility();
  paintDonate();
  paintPhone();
  if (profile.id && (profile.state === "idle" || profile.state === "error")) loadProfile();
  /* app.js rebuilds this whole view on every tab click, so an unconditional
   * refresh here turns idle tab-toggling into two API requests per click. The
   * first open must fetch; after that the panels are already painted from the
   * last payload and the debounced refresh is enough — a visitor must not be
   * able to rate-limit themselves out of the swarm by fidgeting. */
  subscribeTelemetry();
  applyTelemetry(viewTelemetry.snapshot());
  paintStats(); paintBoard(); paintHits(); paintTeams();
  if (refreshedOnce) scheduleRefresh();
  else refresh();
  return wrap;
}

/* QA hook — a test surface only, and deliberately not a running client: the
 * Lab still donates nothing until somebody presses the button. */
try {
  if (typeof window !== "undefined") {
    window.__losLab = {
      refresh,
      snapshot: () => ({
        donate: Object.assign({}, donate),
        reachable: remote.reachable,
        phone: {
          wake: phone.wake, charging: phone.charging, pace: phone.pace, wantRunning: phone.wantRunning,
          held: !!(phone.sentinel && phone.sentinel.released !== true)
        },
        team: {
          own: team.own ? Object.assign({}, team.own) : null, boardCode: team.boardCode, boardRows: team.board.length,
          invited: team.invited, inviteCode: team.inviteCode, top: team.top.length
        },
        record: Object.assign({}, record),
        profile: { id: profile.id, state: profile.state },
        running: clientRunning(),
        pace: client ? client.pace() : null
      }),
      safeText,
      CID_RE,
      TEAM_CODE_RE,
      ID_RE
    };
  }
} catch (_) {}
