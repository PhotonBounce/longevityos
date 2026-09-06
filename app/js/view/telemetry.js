/* telemetry — the live route (4.0 §5): THE ONLY POLLER in the app, the 28px
 * strip under #nav on every tab, and the 20-line log that is its accessible
 * equivalent.
 *
 * WHAT IT POLLS. ?a=stats every 15s, ?a=hits every 45s, ?a=history every
 * 5 minutes — each with If-None-Match, so an unchanged board costs the server
 * a 304 and nothing else. Suspended while the document is hidden. After two
 * consecutive failures an endpoint backs off to 60s. A server that answers
 * stats with quiet:true is asking for quiet, and gets 5-minute polling. A
 * 404 on ?a=history is "no history yet" (an older server), never an error.
 * lab.js does not poll: it subscribes to this store and asks it to refresh.
 *
 * WHAT THE STRIP SAYS. Tagged frames: NET (what the server's totals did),
 * LAB (this browser's events, pushed by lab.js), YOU (session totals), CONF
 * (a second volunteer matched — jumps the queue, holds 8s), ATLAS (no server:
 * the atlas's own figures and the one sentence the app exists for). A frame
 * holds 6s. When there is nothing to report the strip shows STANDING LINES —
 * real figures, restated — never filler. THE QUEUE IS BOUNDED: at most two
 * waiting frames per tag (a third pushes the oldest of that tag out — the
 * 20-line log keeps them all) and four CONF frames, so the strip is never
 * minutes behind a fast run and never replays a run that has stopped; a
 * caller's hold is clamped to 15s. Right: a lamp and one word, LINKING (no
 * poll has answered yet) / LIVE (a poll landed within 45s) / QUIET (within
 * 5 minutes, or the server asked for quiet) / NO LINK (the last poll failed,
 * or nothing for 5 minutes). PAUSE stops the SCHEDULED polling and is
 * remembered in los.hud.v1; an explicit refresh() — the Lab on open, after a
 * submit — still works while paused, and the paused line says so.
 *
 * MOTION. The row swap is one 260ms translateY; under reduced motion or the
 * in-page "Hold the instruments still" switch (html[data-still], also in
 * los.hud.v1) the text is committed first and cross-faded in 120ms. The
 * carrier dot pulses only while html[data-running] is set by the Lab.
 *
 * EVERYTHING FROM THE SERVER IS UNTRUSTED. Only integers are read out of
 * payloads here; every line of text is stripped of control and bidi
 * characters and capped. createElement + textContent only; aria-live="off"
 * on the strip (the log is the reading for assistive tech). */

const STATS_MS = 15000;
const HITS_MS = 45000;
const HISTORY_MS = 300000;
const QUIET_MS = 300000;
const BACKOFF_MS = 60000;
const LIVE_MS = 45000;
const QUIET_LAMP_MS = 300000;
const FRAME_MS = 6000;
const CONF_MS = 8000;
const HOLD_MAX = 15000;
const QUEUE_PER_TAG = 2;
const QUEUE_CONF_MAX = 4;
const SWAP_MS = 260;
const FADE_MS = 120;
const LOG_MAX = 20;
const LINE_MAX = 160;
const REQUEST_MS = 12000;
const MAX_BODY = 262144;
const HUD_KEY = "los.hud.v1";
const TAGS = ["NET", "LAB", "YOU", "CONF", "ATLAS"];
const HEADLINE = "No drug has ever been shown to extend human lifespan.";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* ————— sanitizers ————— */

function safeText(v, max) {
  let s;
  if (typeof v === "string") s = v;
  else if (typeof v === "number" && isFinite(v)) s = String(v);
  else return "";
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, " ")
       .replace(/\s+/g, " ")
       .trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s;
}
function safeInt(v) {
  const n = typeof v === "number" ? v
    : (typeof v === "string" && /^-?[0-9]{1,15}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (!isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 1e15 || i < -1e15 ? null : i;
}
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
const plural = (n, one, many) => groupInt(n) + " " + (n === 1 ? one : many);
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/* ————— the store ————— */

const store = {
  apiBase: "./api/",
  atlas: null,          // { compounds, rows, nulls, ledger } from app.js, optional
  stats: null,          // last good ?a=stats payload, verbatim (subscribers sanitize)
  hits: null,           // last good ?a=hits payload, verbatim
  history: null,        // last good ?a=history payload, verbatim
  statsReachable: null, hitsReachable: null, historyReachable: null,
  historyMissing: false,
  statsError: "", hitsError: "", historyError: "",
  quiet: false,
  lastOkAt: 0,
  paused: false,
  still: false,
  running: false,
  session: { units: 0, confirmed: 0, credits: 0 },
  log: [],              // newest first: { at, tag, text }
  requests: []          // { ep, at, status } — QA reads the timing
};
const subscribers = new Set();
let mounted = null;      // the strip's DOM
const logHosts = new Set();
let hidden = false;
let visibilityHooked = false;
let lampTimer = null;

const totalsOf = (stats) => {
  const t = isPlainObject(stats) && isPlainObject(stats.totals) ? stats.totals : {};
  return {
    harvested: safeInt(t.harvested), screened: safeInt(t.screened), verified: safeInt(t.verified),
    contributors: safeInt(t.contributors), unitsOpen: safeInt(t.units_open), active: safeInt(t.active_1h)
  };
};

function snapshot() {
  return {
    stats: store.stats, hits: store.hits, history: store.history,
    statsReachable: store.statsReachable, hitsReachable: store.hitsReachable, historyReachable: store.historyReachable,
    historyMissing: store.historyMissing,
    statsError: store.statsError, hitsError: store.hitsError, historyError: store.historyError,
    quiet: store.quiet, lastOkAt: store.lastOkAt, paused: store.paused, still: store.still,
    running: store.running, link: linkState(), totals: totalsOf(store.stats),
    session: Object.assign({}, store.session),
    log: store.log.slice()
  };
}

function notify(event) {
  const snap = snapshot();
  for (const fn of subscribers) { try { fn(snap, event); } catch (_) { /* a subscriber may never take the strip down */ } }
}

/* ————— remembered preferences (read at mount, never acted on beyond a class) ————— */

function readPrefs() {
  try {
    if (typeof localStorage === "undefined") return;
    const v = JSON.parse(localStorage.getItem(HUD_KEY) || "null");
    if (!isPlainObject(v)) return;
    store.paused = v.paused === true;
    store.still = v.still === true;
  } catch (_) { /* storage refused: defaults */ }
}
function writePrefs() {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(HUD_KEY, JSON.stringify({ paused: store.paused, still: store.still }));
  } catch (_) { /* storage refused: the preference lives for this page only */ }
}
function applyStill() {
  try {
    if (typeof document === "undefined") return;
    if (store.still) document.documentElement.setAttribute("data-still", "");
    else document.documentElement.removeAttribute("data-still");
  } catch (_) {}
}
function stillMode() {
  try {
    if (store.still) return true;
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (_) { return false; }
}

/* ————— the network ————— */

function apiUrl(action, params) {
  let u = store.apiBase + "?a=" + encodeURIComponent(action);
  for (const k of Object.keys(params || {}).sort()) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    u += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(String(v));
  }
  return u;
}

/* → { ok, unchanged, status, data, etag, error } — never throws */
async function apiGet(action, params, etag) {
  if (typeof fetch !== "function") return { ok: false, status: 0, error: "this browser cannot reach the server" };
  let ctrl = null, timer = null;
  try {
    if (typeof AbortController === "function") {
      ctrl = new AbortController();
      timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, REQUEST_MS);
    }
    const headers = {};
    if (etag) headers["If-None-Match"] = etag;
    const init = { method: "GET", cache: "no-store", headers };
    if (ctrl) init.signal = ctrl.signal;
    const res = await fetch(apiUrl(action, params), init);
    if (res.status === 304) return { ok: true, unchanged: true, status: 304, etag };
    const len = Number(res.headers.get("content-length"));
    if (isFinite(len) && len > MAX_BODY) {
      try { if (ctrl) ctrl.abort(); } catch (_) {}
      return { ok: false, status: res.status, error: "the server sent an implausibly large response" };
    }
    if (!res.ok) {
      try { if (ctrl) ctrl.abort(); } catch (_) {}
      return { ok: false, status: res.status, error: "the server answered " + res.status };
    }
    const body = await res.text();
    if (body.length > MAX_BODY) return { ok: false, status: res.status, error: "the server sent an implausibly large response" };
    let data = null;
    try { data = JSON.parse(body); } catch (_) { return { ok: false, status: res.status, error: "the server sent something that is not JSON" }; }
    if (!isPlainObject(data)) return { ok: false, status: res.status, error: "the server sent an unexpected response" };
    let tag = "";
    try { tag = res.headers.get("etag") || ""; } catch (_) { tag = ""; }
    return { ok: true, unchanged: false, status: res.status, data, etag: tag };
  } catch (_) {
    return { ok: false, status: 0, error: "could not reach the server" };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/* ————— the three endpoints ————— */

function endpoint(name, baseMs, params) {
  return { name, baseMs, params, etag: "", fails: 0, timer: null, inflight: null, lastAt: 0 };
}
const EP = {
  stats: endpoint("stats", STATS_MS, null),
  hits: endpoint("hits", HITS_MS, { limit: 20 }),
  history: endpoint("history", HISTORY_MS, { hours: 48 })
};

function nextDelay(ep) {
  if (ep.fails >= 2) return BACKOFF_MS;
  if (store.quiet) return Math.max(ep.baseMs, QUIET_MS);
  return ep.baseMs;
}
function clearTimer(ep) { if (ep.timer !== null) { clearTimeout(ep.timer); ep.timer = null; } }
function schedule(ep, delay) {
  clearTimer(ep);
  if (store.paused || hidden) return;
  ep.timer = setTimeout(() => { ep.timer = null; poll(ep); }, delay);
}
function poll(ep) {
  if (ep.inflight) return ep.inflight;
  ep.inflight = doPoll(ep).catch(() => {}).then(() => {
    ep.inflight = null;
    schedule(ep, nextDelay(ep));
  });
  return ep.inflight;
}

async function doPoll(ep) {
  const res = await apiGet(ep.name, ep.params, ep.etag);
  const now = Date.now();
  ep.lastAt = now;
  store.requests.push({ ep: ep.name, at: now, status: res.status });
  if (store.requests.length > 200) store.requests.splice(0, store.requests.length - 200);

  if (ep.name === "history" && !res.ok && res.status === 404) {
    /* an older server: no history yet — the link is fine */
    ep.fails = 0;
    store.historyReachable = true;
    store.historyMissing = true;
    store.historyError = "";
    store.lastOkAt = now;
    paintLamp();
    notify({ kind: "history", changed: false });
    return;
  }
  if (!res.ok) {
    ep.fails++;
    const wasReachable = store[ep.name + "Reachable"];
    store[ep.name + "Reachable"] = false;
    store[ep.name + "Error"] = res.error || "could not reach the server";
    if (ep.name === "stats" && wasReachable !== false) {
      pushLine("NET", "No link — the swarm server did not answer (" + store.statsError + "). Retrying" +
        (ep.fails >= 2 ? " every 60 seconds." : "."));
    }
    paintLamp();
    notify({ kind: ep.name, changed: false, failed: true });
    return;
  }
  ep.fails = 0;
  store.lastOkAt = now;
  const wasReachable = store[ep.name + "Reachable"];
  store[ep.name + "Reachable"] = true;
  store[ep.name + "Error"] = "";
  if (ep.name === "history") store.historyMissing = false;
  if (res.unchanged) { paintLamp(); notify({ kind: ep.name, changed: false }); return; }
  ep.etag = res.etag || "";
  const prev = store[ep.name];
  store[ep.name] = res.data;
  if (ep.name === "stats") onStats(prev, res.data, wasReachable);
  else if (ep.name === "hits") onHits(prev, res.data);
  paintLamp();
  notify({ kind: ep.name, changed: true });
}

function onStats(prev, data, wasReachable) {
  const wasQuiet = store.quiet;
  store.quiet = data.quiet === true;
  const t = totalsOf(data);
  if (!prev || wasReachable === false) {
    pushLine("NET", "Link up — " + plural(t.screened, "molecule", "molecules") + " screened so far · " +
      plural(t.verified, "verified hit", "verified hits") + " · " + plural(t.unitsOpen, "open unit", "open units"));
  } else {
    const p = totalsOf(prev);
    const parts = [];
    const d = (a, b) => (a !== null && b !== null ? a - b : 0);
    const ds = d(t.screened, p.screened), dv = d(t.verified, p.verified), dh = d(t.harvested, p.harvested), dc = d(t.contributors, p.contributors);
    if (ds > 0) parts.push("+" + groupInt(ds) + " screened");
    if (dv > 0) parts.push("+" + groupInt(dv) + " verified");
    if (dh > 0) parts.push("+" + groupInt(dh) + " harvested");
    if (dc > 0) parts.push("+" + groupInt(dc) + (dc === 1 ? " contributor" : " contributors"));
    if (parts.length) pushLine("NET", parts.join(" · ") + " since the last poll");
  }
  if (store.quiet && !wasQuiet) pushLine("NET", "The server asked for quiet — polling every 5 minutes");
  if (!store.quiet && wasQuiet) pushLine("NET", "Quiet lifted — polling every 15 seconds");
}

/* ?a=hits is a PAGE (the top rows, 20 asked for), never the whole shortlist
 * — its length is printed as what it is, and the shortlist's real size is
 * the stats total, printed only when a stats poll has supplied it. */
function onHits(prev, data) {
  const n = Array.isArray(data.hits) ? data.hits.length : 0;
  const was = prev && Array.isArray(prev.hits) ? prev.hits.length : -1;
  if (n === was) return;
  const v = totalsOf(store.stats).verified;
  if (n === 0) pushLine("NET", "Public shortlist: nothing has yet been confirmed by two independent volunteers");
  else pushLine("NET", "Public shortlist changed — its top " + plural(n, "entry", "entries") + " listed here, each confirmed by two independent volunteers" +
    (v !== null ? " · " + plural(v, "verified hit", "verified hits") + " on record" : ""));
}

/* ————— lines, frames, log ————— */

const queue = [];   // frames waiting: { tag, text, holdMs }
let frameTimer = null;
let standingIndex = 0;
let current = null;

function utcStamp(at) {
  try { return new Date(at).toISOString().slice(11, 19) + " UTC"; } catch (_) { return ""; }
}

function pushLine(tag, text, holdMs) {
  const t = TAGS.includes(tag) ? tag : "LAB";
  const s = safeText(text, LINE_MAX);
  if (!s) return null;
  const line = { at: Date.now(), tag: t, text: s };
  store.log.unshift(line);
  if (store.log.length > LOG_MAX) store.log.length = LOG_MAX;
  const frame = { tag: t, text: s, holdMs: holdMs || (t === "CONF" ? CONF_MS : FRAME_MS) };
  if (t === "CONF") { queue.unshift(frame); trimQueue(t); showNext(); }
  else { queue.push(frame); trimQueue(t); }
  paintLogs();
  notify({ kind: "log", line });
  if (!current) showNext();
  return line;
}

/* The queue keeps at most QUEUE_PER_TAG waiting frames of a tag (CONF:
 * QUEUE_CONF_MAX, and CONF frames sit at the front, newest first, so the
 * oldest is the last of them); the oldest of that tag goes. The log has it. */
function trimQueue(tag) {
  const max = tag === "CONF" ? QUEUE_CONF_MAX : QUEUE_PER_TAG;
  for (;;) {
    const own = [];
    for (let i = 0; i < queue.length; i++) if (queue[i].tag === tag) own.push(i);
    if (own.length <= max) return;
    queue.splice(tag === "CONF" ? own[own.length - 1] : own[0], 1);
  }
}
/* Drop every waiting frame of a tag — the Lab's stop: the run they describe
 * is over. The log keeps them; only the strip's queue is cleared. */
function dropQueued(tag) {
  const t = TAGS.includes(tag) ? tag : null;
  if (!t) return 0;
  let n = 0;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].tag === t) { queue.splice(i, 1); n++; }
  return n;
}

/* Standing lines: the facts as they stand, restated. Never invented. */
function standingLines() {
  const lines = [];
  const s = store.session;
  const t = totalsOf(store.stats);
  if (store.stats) {
    lines.push(["NET", plural(t.screened, "molecule", "molecules") + " screened · " +
      plural(t.verified, "verified hit", "verified hits") + " · " + plural(t.contributors, "contributor", "contributors") +
      " · " + plural(t.unitsOpen, "open unit", "open units")]);
    if (t.harvested !== null) lines.push(["NET", plural(t.harvested, "molecule", "molecules") + " harvested into the pool so far"]);
  }
  lines.push(["YOU", store.running
    ? "This browser this session: " + plural(s.units, "unit", "units") + " · " + groupInt(s.confirmed) + " confirmed · " + plural(s.credits, "credit", "credits")
    : "Nothing is running — this browser has donated " + plural(s.units, "unit", "units") + " this session"]);
  if (store.statsReachable === false || !store.stats) {
    lines.push(["ATLAS", HEADLINE]);
    if (store.atlas) {
      const a = store.atlas;
      lines.push(["ATLAS", plural(a.compounds, "compound", "compounds") + " in the atlas · " + plural(a.rows, "evidence row", "evidence rows") +
        " · " + plural(a.nulls, "rigorous null", "rigorous nulls") + " on record"]);
      if (a.ledger !== null && a.ledger !== undefined) lines.push(["ATLAS", plural(a.ledger, "intervention", "interventions") + " with human mortality evidence in the ledger"]);
    }
    if (store.statsReachable === false) lines.push(["NET", "The swarm server is not reachable from here — the atlas works without one"]);
  }
  if (store.paused) lines.unshift(["NET", "Paused — no polling on a schedule; the Lab still refreshes when you act. Press RESUME"]);
  return lines;
}

function nextFrame() {
  if (queue.length) return queue.shift();
  const lines = standingLines();
  if (!lines.length) return null;
  const [tag, text] = lines[standingIndex % lines.length];
  standingIndex++;
  return { tag, text, holdMs: FRAME_MS };
}

function showNext() {
  if (frameTimer !== null) { clearTimeout(frameTimer); frameTimer = null; }
  const f = nextFrame();
  if (!f) { current = null; return; }
  current = f;
  paintFrame(f);
  if (hidden) return;
  frameTimer = setTimeout(() => { frameTimer = null; showNext(); }, f.holdMs);
}

/* ————— the strip's DOM ————— */

function buildStrip() {
  const strip = el("div", "strip strip-link-linking");
  strip.setAttribute("aria-live", "off");
  strip.setAttribute("data-strip", "");
  strip.setAttribute("data-link", "linking");
  const left = el("div", "strip-left");
  const dot = el("span", "strip-dot");
  dot.setAttribute("aria-hidden", "true");
  left.appendChild(dot);
  const tag = el("span", "strip-tag", "NET");
  left.appendChild(tag);
  strip.appendChild(left);
  const frame = el("div", "strip-frame");
  const rows = el("div", "strip-rows");
  const rowA = el("div", "strip-row", "");
  const rowB = el("div", "strip-row", "");
  rows.appendChild(rowA);
  rows.appendChild(rowB);
  frame.appendChild(rows);
  strip.appendChild(frame);
  const right = el("div", "strip-right");
  const lamp = el("span", "strip-lamp");
  lamp.setAttribute("aria-hidden", "true");
  right.appendChild(lamp);
  const word = el("span", "strip-link", "LINKING");
  right.appendChild(word);
  const btn = el("button", "strip-btn", "PAUSE");
  btn.type = "button";
  btn.setAttribute("data-strip-btn", "");
  btn.addEventListener("click", () => { if (store.paused) resume(); else pause(); });
  right.appendChild(btn);
  strip.appendChild(right);
  return { strip, tag, rows, rowA, rowB, word, btn, swapping: false, pending: null };
}

function commitRow(m, f) {
  m.rowA.textContent = f.text;
  m.rowB.textContent = "";
  m.tag.textContent = f.tag;
  m.tag.className = "strip-tag strip-tag-" + f.tag;
  m.strip.setAttribute("data-frame-tag", f.tag);
}

function paintFrame(f) {
  const m = mounted;
  if (!m) return;
  if (!m.rowA.textContent) { commitRow(m, f); return; }
  if (stillMode()) {
    /* cross-fade: the text lands first, then fades in — never a half-scroll */
    commitRow(m, f);
    m.rows.classList.remove("fade");
    m.rows.classList.add("fade");
    setTimeout(() => { m.rows.classList.remove("fade"); }, FADE_MS + 40);
    return;
  }
  if (m.swapping) { m.pending = f; return; }
  m.swapping = true;
  m.rowB.textContent = f.text;
  m.rows.classList.add("swap");
  const done = () => {
    if (!m.swapping) return;
    m.swapping = false;
    m.rows.classList.remove("swap");
    commitRow(m, f);
    const p = m.pending;
    m.pending = null;
    if (p) paintFrame(p);
  };
  try { m.rows.addEventListener("animationend", done, { once: true }); } catch (_) {}
  setTimeout(done, SWAP_MS + 60);
}

function linkState() {
  if (store.paused) return "paused";
  if (store.statsReachable === false) return "none";
  /* nothing has answered and nothing has failed: the link is being made,
   * not broken — NO LINK is earned by a failure or a five-minute silence */
  if (!store.lastOkAt) return store.statsReachable === null ? "linking" : "none";
  const age = Date.now() - store.lastOkAt;
  if (age > QUIET_LAMP_MS) return "none";
  if (store.quiet || age > LIVE_MS) return "quiet";
  return "live";
}
const LINK_WORD = { linking: "LINKING", live: "LIVE", quiet: "QUIET", none: "NO LINK", paused: "PAUSED" };

function paintLamp() {
  const m = mounted;
  if (!m) return;
  const st = linkState();
  const cls = "strip strip-link-" + st;
  if (m.strip.className !== cls) {
    m.strip.className = cls;
    m.strip.setAttribute("data-link", st);
    m.word.textContent = LINK_WORD[st];
    notify({ kind: "link", link: st });
  }
  m.btn.textContent = store.paused ? "RESUME" : "PAUSE";
  m.btn.setAttribute("aria-pressed", store.paused ? "true" : "false");
}

function paintLogs() {
  for (const ol of logHosts) {
    /* the Lab builds its tree detached and mounts it in the same task, so a
     * list is fresh until that task ends; after that a detached list is an
     * orphan (a torn-down tab) and is dropped rather than repainted forever */
    if (!ol.isConnected && !ol.__fresh) { logHosts.delete(ol); continue; }
    ol.textContent = "";
    if (!store.log.length) {
      ol.appendChild(el("li", "hud-empty", "Nothing reported yet."));
      continue;
    }
    for (const line of store.log) {
      const li = el("li");
      const time = el("time", "", utcStamp(line.at));
      try { time.setAttribute("datetime", new Date(line.at).toISOString()); } catch (_) {}
      li.appendChild(time);
      li.appendChild(el("span", "hud-tag strip-tag-" + line.tag, line.tag));
      li.appendChild(el("span", "hud-text", line.text));
      ol.appendChild(li);
    }
  }
}

/* ————— control ————— */

function pause() {
  store.paused = true;
  writePrefs();
  for (const ep of Object.values(EP)) clearTimer(ep);
  paintLamp();
  pushLine("NET", "Paused — scheduled polling stops until RESUME; the Lab still refreshes when you act");
  notify({ kind: "pause", paused: true });
}
function resume() {
  store.paused = false;
  writePrefs();
  paintLamp();
  pushLine("NET", "Resumed — polling the swarm server again");
  for (const ep of Object.values(EP)) poll(ep);
  notify({ kind: "pause", paused: false });
}

/* A forced round: stats + hits now, whatever the schedule says. Resolves to
 * the snapshot once both have landed. Callers: the Lab on open, after a
 * submit, and window.__losLab.refresh. */
function refresh() {
  /* a poll already in flight may predate the event that asked for this
   * refresh, so it is waited for and then followed by a fresh one */
  const force = (ep) => (ep.inflight ? ep.inflight.then(() => poll(ep)) : poll(ep));
  return Promise.all([force(EP.stats), force(EP.hits)]).then(() => { paintLamp(); return snapshot(); });
}

function hookVisibility() {
  if (visibilityHooked) return;
  visibilityHooked = true;
  try {
    if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
    hidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", () => {
      try {
        hidden = document.visibilityState === "hidden";
        if (hidden) {
          for (const ep of Object.values(EP)) clearTimer(ep);
          if (frameTimer !== null) { clearTimeout(frameTimer); frameTimer = null; }
        } else {
          if (!store.paused) for (const ep of Object.values(EP)) poll(ep);
          showNext();
        }
        notify({ kind: "visibility", hidden });
      } catch (_) {}
    });
  } catch (_) {}
}

/* ————— the export ————— */

/* viewTelemetry(mount, { apiBase, atlas }) — mount the strip once at boot.
 * Returns the store's public surface. Mounting starts the polling (reads,
 * not CPU — and not even those if the visitor paused it last time). */
export function viewTelemetry(mount, options) {
  const opts = isPlainObject(options) ? options : {};
  if (typeof opts.apiBase === "string" && opts.apiBase) store.apiBase = opts.apiBase;
  if (isPlainObject(opts.atlas)) {
    store.atlas = {
      compounds: safeInt(opts.atlas.compounds), rows: safeInt(opts.atlas.rows),
      nulls: safeInt(opts.atlas.nulls), ledger: safeInt(opts.atlas.ledger)
    };
  }
  if (mount && typeof mount.appendChild === "function") {
    if (!mounted || mounted.strip.parentNode !== mount) {
      readPrefs();
      applyStill();
      if (mounted && mounted.strip.parentNode) mounted.strip.parentNode.removeChild(mounted.strip);
      mounted = buildStrip();
      mount.textContent = "";
      mount.appendChild(mounted.strip);
      hookVisibility();
      paintLamp();
      if (lampTimer === null) lampTimer = setInterval(paintLamp, 5000);
      /* a document already hidden at mount polls when it becomes visible */
      if (!store.paused && !hidden) for (const ep of Object.values(EP)) poll(ep);
      showNext();
    }
  }
  return viewTelemetry.store();
}

viewTelemetry.store = function () {
  return { subscribe, snapshot, pause, resume, refresh, push: viewTelemetry.push, drop: viewTelemetry.drop, log: viewTelemetry.log, running: viewTelemetry.running, session: viewTelemetry.session, still: viewTelemetry.still, prefs: viewTelemetry.prefs };
};
function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}
viewTelemetry.subscribe = subscribe;
viewTelemetry.snapshot = snapshot;
viewTelemetry.pause = pause;
viewTelemetry.resume = resume;
viewTelemetry.refresh = refresh;

/* A local event from lab.js (or any view): { tag, text, holdMs? }. A hold
 * is clamped to HOLD_MAX — no caller parks a frame on the strip for longer. */
viewTelemetry.push = function (line) {
  if (!isPlainObject(line)) return null;
  const hold = Math.min(Math.max(safeInt(line.holdMs) || 0, 0), HOLD_MAX);
  return pushLine(typeof line.tag === "string" ? line.tag.toUpperCase() : "LAB", line.text, hold);
};
/* Drop the frames of a tag still waiting for the strip (the log keeps them). */
viewTelemetry.drop = function (tag) {
  return dropQueued(typeof tag === "string" ? tag.toUpperCase() : "");
};

/* Mount the always-open log into `host`; returns the <ol>. */
viewTelemetry.log = function (host) {
  const ol = el("ol", "hud-log");
  ol.setAttribute("data-hud-log", "");
  ol.setAttribute("aria-label", "The last twenty lines from the telemetry strip");
  if (host && typeof host.appendChild === "function") host.appendChild(ol);
  logHosts.add(ol);
  ol.__fresh = true;
  const settle = () => { ol.__fresh = false; };
  try { queueMicrotask(settle); } catch (_) { setTimeout(settle, 0); }
  paintLogs();
  return ol;
};

/* The Lab tells the strip whether the client is running (the carrier dot
 * pulses only then) and what this session's tallies are. */
viewTelemetry.running = function (on) {
  const next = on === true;
  if (store.running === next) return next;   /* the Lab calls this on every progress chunk — a repeat is silent */
  store.running = next;
  try {
    if (typeof document !== "undefined") {
      if (store.running) document.documentElement.setAttribute("data-running", "");
      else document.documentElement.removeAttribute("data-running");
    }
  } catch (_) {}
  notify({ kind: "running", running: store.running });
  return store.running;
};
viewTelemetry.session = function (s) {
  if (!isPlainObject(s)) return Object.assign({}, store.session);
  for (const k of ["units", "confirmed", "credits"]) {
    const v = safeInt(s[k]);
    if (v !== null) store.session[k] = v;
  }
  return Object.assign({}, store.session);
};

/* "Hold the instruments still": html[data-still], remembered. */
viewTelemetry.still = function (on) {
  if (on !== undefined) { store.still = on === true; writePrefs(); applyStill(); notify({ kind: "still", still: store.still }); }
  return store.still;
};
viewTelemetry.prefs = function () { return { paused: store.paused, still: store.still }; };

/* QA hook — a test surface only: reads the store and the request timings,
 * forces polls. Nothing here starts CPU work. */
try {
  if (typeof window !== "undefined") {
    window.__losStrip = {
      snapshot, refresh, push: viewTelemetry.push, pause, resume,
      link: linkState,
      requests: () => store.requests.slice(),
      log: () => store.log.slice(),
      queue: () => queue.length,
      queued: () => queue.map((f) => ({ tag: f.tag, text: f.text, holdMs: f.holdMs })),
      frame: () => (current ? { tag: current.tag, text: current.text, holdMs: current.holdMs } : null),
      hosts: () => logHosts.size,
      drop: viewTelemetry.drop,
      still: viewTelemetry.still,
      endpoints: () => Object.fromEntries(Object.values(EP).map((e) => [e.name, { etag: e.etag, fails: e.fails, scheduled: e.timer !== null, lastAt: e.lastAt }]))
    };
  }
} catch (_) {}
