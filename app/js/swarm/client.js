/* client — the donation controller.
 *
 * THE CONSENT RULE, first and loudest: this module NEVER starts using anybody's
 * CPU on its own. Importing it starts nothing, constructing the client starts
 * nothing, and there is no page-load hook, no timer and no "resume where we
 * left off" anywhere in this file. Screening begins only when a human presses
 * a button and the UI calls start(). That is not a stylistic preference —
 * silently spending a visitor's battery and their phone's heat budget while
 * they read a page is precisely the behaviour that got in-page cryptominers
 * blocked by every browser and ad blocker on earth, and it would be a lie
 * about what this project is. If a later optimisation ever wants to "warm the
 * loop up automatically", the answer is no.
 *
 * WHAT IT DOES. One polite loop: ask the server for a work unit, hand the unit
 * to the single Web Worker, submit the digest the worker produced, pause, and
 * go again. Everything a live UI needs is emitted through onEvent.
 *
 * It also keeps the contributor's record: the token, the chosen name and —
 * since 3.0 — the team they are in. me()/teamCreate()/teamJoin()/teamLeave()/
 * leave() are bookkeeping about that token; none of them starts anything.
 * Events: joined, unit, progress, spotlight, submitted, confirmed, idle, error,
 * stopped, plus team (the stored team changed) and left (the record was
 * erased). `spotlight` carries one molecule every fortieth chunk of screening,
 * chosen by its POSITION (a chunk counter, never a score — the first molecule
 * of that chunk), with its own screenMolecule() result — the lens on the page
 * draws it. It is display only and is never part of what is submitted.
 *
 * WHAT IT REFUSES TO DO. Hammer a server that has no work (30s idle back-off),
 * retry a failure at full speed (exponential 2/4/8…60s), run two workers, keep
 * screening after the tab is hidden unless the visitor asked for that, throw
 * out of any public method, or lose the contributor token because a browser
 * refused localStorage.
 *
 * DETERMINISM. Nothing here touches the screening path: the client never
 * computes, adjusts or inspects a score. Its timers use the clock, which is
 * fine — a pause length is never an input to a digest.
 */

/* The engine is imported here ONLY for the no-worker fallback below (the
 * single-file build, and any browser without module workers). The normal path
 * never calls it on this thread. */
import { screenUnit, screenMolecule, referenceSet } from "../chem/score.js";

const STORE_KEY = "los.swarm.v1";

/* Pacing. A volunteer's browser is a guest on their machine, and the swarm's
 * throughput comes from many contributors, not from squeezing one. The pace is
 * the visitor's own dial (Full / Gentle / Trickle in the Lab): the minimum gap
 * between finishing one unit and asking for the next, 0..PACE_MAX ms. It can
 * be changed while the loop runs and the sleep it produces is cancellable —
 * stop() is immediate, never "after the current pause". */
const PACE_MAX = 10000;
const DEFAULTS = {
  paceMs: 0,           // between finishing one unit and asking for the next
  idleMs: 30000,       // the server has nothing to screen — come back later
  backoffMinMs: 2000,  // first retry after a failure
  backoffMaxMs: 60000, // and never slower than this
  requestMs: 20000,    // per-request timeout
  unitMs: 120000       // a unit that takes longer than this gets a fresh worker
};

/* ————— storage that is allowed to refuse ————— */

/* Private windows, "block all cookies", enterprise policy, a full quota: every
 * one of these throws on plain localStorage access. The client works entirely
 * from memory when that happens; the only thing lost is the token surviving a
 * reload, and a fresh join costs nothing. */
function readStore() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const token = typeof v.token === "string" ? v.token : "";
    if (!token) return null;
    return {
      token,
      contributor: v.contributor === undefined ? null : v.contributor,
      name: typeof v.name === "string" ? v.name : "",
      team: cleanTeam(v.team)
    };
  } catch (_) {
    return null;
  }
}

function writeStore(identity) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(STORE_KEY, JSON.stringify({
      token: identity.token,
      contributor: identity.contributor,
      name: identity.name,
      team: identity.team || null
    }));
    return true;
  } catch (_) {
    return false;
  }
}

function clearStore() {
  try {
    if (typeof localStorage !== "undefined") localStorage.removeItem(STORE_KEY);
  } catch (_) { /* storage was refused; the in-memory identity is gone either way */ }
}

/* A team, as this client is willing to remember it: an 8-character code from
 * the server's own alphabet (no 0/O/1/I) and a short name. Anything else —
 * including a stored record a hostile page wrote — becomes "no team". */
const TEAM_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
function cleanTeam(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const code = typeof t.code === "string" ? t.code.toUpperCase() : "";
  if (!TEAM_CODE_RE.test(code)) return null;
  const name = typeof t.name === "string" ? t.name.slice(0, 24) : "";
  return { code, name };
}

/* ————— small helpers ————— */

function errText(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  try { return String(err); } catch (_) { return "unknown error"; }
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function createSwarmClient(options = {}) {
  const opts = isPlainObject(options) ? options : {};
  const apiBase = typeof opts.apiBase === "string" && opts.apiBase ? opts.apiBase : "./api/";
  const rawEvent = typeof opts.onEvent === "function" ? opts.onEvent : () => {};
  const cfg = {
    /* `pace` is the public name; `paceMs` is still honoured for older callers. */
    paceMs: clampPace(opts.pace !== undefined ? opts.pace : opts.paceMs, DEFAULTS.paceMs),
    idleMs: numberOr(opts.idleMs, DEFAULTS.idleMs),
    backoffMinMs: numberOr(opts.backoffMinMs, DEFAULTS.backoffMinMs),
    backoffMaxMs: numberOr(opts.backoffMaxMs, DEFAULTS.backoffMaxMs),
    requestMs: numberOr(opts.requestMs, DEFAULTS.requestMs),
    unitMs: numberOr(opts.unitMs, DEFAULTS.unitMs)
  };
  /* Opt-in only: by default the loop stops the moment the tab is hidden. */
  let background = opts.background === true;

  function numberOr(v, d) {
    return typeof v === "number" && isFinite(v) && v >= 0 ? v : d;
  }
  function clampPace(v, d) {
    const n = typeof v === "number" && isFinite(v) ? v : d;
    return Math.min(PACE_MAX, Math.max(0, Math.floor(n)));
  }

  const state = {
    identity: readStore(),      // { token, contributor, name } | null
    running: false,
    gen: 0,
    pendingName: "",
    pausedByVisibility: false,
    loopActive: false,
    stored: false,
    unitsDone: 0,
    unitsConfirmed: 0,
    credits: 0,
    backoffMs: 0,
    lastUnitId: null,
    lastStatus: null,
    lastError: null,
    done: 0,
    total: 0
  };
  state.stored = !!state.identity;

  /* onEvent belongs to the UI; a throwing listener must never break the loop. */
  function emit(type, data) {
    try { rawEvent(Object.assign({ type }, data || {})); } catch (_) { /* the UI's problem, not the swarm's */ }
  }

  /* The generation whose "stopped" event has already been emitted. Declared up
   * here because both halt() and the loop's finally read it. */
  let stoppedGen = -1;

  /* ————— cancellable sleep ————— */

  let wake = null;
  function sleep(ms) {
    return new Promise((resolve) => {
      let t = null;
      const finish = () => { if (t !== null) { clearTimeout(t); t = null; } wake = null; resolve(); };
      t = setTimeout(finish, ms);
      wake = finish;
    });
  }
  function wakeNow() {
    if (wake) { const w = wake; wake = null; w(); }
  }

  /* ————— the network ————— */

  function url(action, params) {
    let u = apiBase + "?a=" + encodeURIComponent(action);
    for (const k of Object.keys(params || {}).sort()) {
      const v = params[k];
      if (v === undefined || v === null || v === "") continue;
      u += "&" + encodeURIComponent(k) + "=" + encodeURIComponent(String(v));
    }
    return u;
  }

  /* Nothing this API sends is anywhere near this big — every documented
   * response is under 10 KB. */
  const MAX_BYTES = 262144;

  /* The ceiling is enforced WHILE the body arrives, not after it has landed.
   * `await res.text()` on a hostile or broken server materialises the whole
   * thing first and only then lets us reject it, which protects the parser and
   * not the tab: the out-of-memory kill has already happened by the time the
   * check runs. So the body is read in chunks, the byte count is watched, and
   * the request is aborted the moment it goes over.
   *
   * Streams are not universally available (an old embedding, a test double),
   * so res.text() stays as the fallback path. It still rejects an oversized
   * response — it just cannot protect memory, which is exactly the situation
   * we were in before. */
  async function readCapped(res, ctrl) {
    let reader = null;
    try {
      if (res && res.body && typeof res.body.getReader === "function" && typeof TextDecoder === "function") {
        reader = res.body.getReader();
      }
    } catch (_) {
      reader = null;
    }
    if (!reader) {
      const text = await res.text();
      return text.length > MAX_BYTES ? { tooBig: true } : { text };
    }
    const dec = new TextDecoder();
    let out = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (!chunk || chunk.done) break;
      const value = chunk.value;
      bytes += value && typeof value.byteLength === "number" ? value.byteLength : 0;
      if (bytes > MAX_BYTES) {
        try { if (ctrl) ctrl.abort(); } catch (_) {}
        try { await reader.cancel(); } catch (_) {}
        return { tooBig: true };
      }
      if (value) out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
    return { text: out };
  }

  /* Every failure mode of a fetch collapses to { ok:false, error } here: DNS
   * failure, offline, CORS, 4xx, 5xx, a timeout, HTML where JSON was promised,
   * a response too large to be one of ours. The loop above never sees an
   * exception and never has to guess. */
  async function call(action, { params, body, readError } = {}) {
    if (typeof fetch !== "function") return { ok: false, error: "this browser cannot reach the server" };
    let ctrl = null, timer = null;
    try {
      if (typeof AbortController === "function") {
        ctrl = new AbortController();
        timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, cfg.requestMs);
      }
      const init = { method: body ? "POST" : "GET", cache: "no-store" };
      if (ctrl) init.signal = ctrl.signal;
      if (body) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url(action, params), init);
      if (!res.ok) {
        /* The loop never reads a non-2xx body — the status is the whole
         * message there, and forgetIdentityOn() upstream needs only that. The
         * team and record methods DO want the server's short error code
         * (bad_code, team_full, unknown_team…), so they ask for it explicitly;
         * it is read under the same byte cap and only ever used as a code. */
        if (readError) {
          try {
            const read = await readCapped(res, ctrl);
            if (!read.tooBig) {
              const parsed = JSON.parse(read.text);
              if (isPlainObject(parsed) && typeof parsed.error === "string" && /^[a-z_]{1,32}$/.test(parsed.error)) {
                return { ok: false, error: parsed.error, status: res.status };
              }
            }
          } catch (_) { /* fall through to the status-only message */ }
        }
        try { if (res.body && typeof res.body.cancel === "function") await res.body.cancel(); } catch (_) {}
        return { ok: false, error: "server said " + res.status, status: res.status };
      }
      const read = await readCapped(res, ctrl);
      if (read.tooBig) return { ok: false, error: "server sent an implausibly large response" };
      const text = read.text;
      let data = null;
      try { data = JSON.parse(text); } catch (_) { return { ok: false, error: "server sent something that is not JSON" }; }
      if (!isPlainObject(data)) return { ok: false, error: "server sent an unexpected response" };
      if (typeof data.error === "string" && data.error) return { ok: false, error: data.error };
      return { ok: true, data };
    } catch (err) {
      const msg = /abort/i.test(errText(err)) ? "the server did not answer in time" : "could not reach the server";
      return { ok: false, error: msg };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /* ————— the one worker ————— */

  let worker = null;
  let pending = null;   // { unitId, resolve, timer }

  /* Resolved against the DOCUMENT, not against this module: the single-file
   * build inlines this file into a classic <script>, where `import.meta` is a
   * syntax error, so the module's own URL is unavailable by construction. A
   * host that moves the file can override it. */
  function workerUrl() {
    if (typeof opts.workerUrl === "string" && opts.workerUrl) return opts.workerUrl;
    try {
      if (typeof window !== "undefined" && typeof window.__LOS_WORKER_URL === "string" && window.__LOS_WORKER_URL) {
        return window.__LOS_WORKER_URL;
      }
    } catch (_) {}
    return "js/swarm/worker.js";
  }

  /* The single-file build has no separate worker file to load, and some
   * embeddings have no module workers at all. Screening then happens on this
   * thread — chunked, with a real yield between chunks, so the page keeps
   * answering. It is slower and less polite, which is exactly why it is the
   * fallback and not the default. */
  let workerBroken = false;   // set once a worker has failed to load or crashed twice
  let workerFailures = 0;

  function workersUsable() {
    if (workerBroken) return false;
    if (typeof Worker !== "function") return false;
    try { if (typeof window !== "undefined" && window.__LOS_SINGLE_FILE) return false; } catch (_) {}
    return true;
  }

  let localRefs = null;
  /* the same spotlight rule the worker follows: every fortieth chunk, the
   * first molecule of that chunk — a counter, never a score */
  const SPOTLIGHT_EVERY = 40;
  let localChunkCounter = 0;
  async function screenOnThisThread(unit, unitId) {
    try {
      if (!localRefs) localRefs = referenceSet();
      const mols = Array.isArray(unit.molecules) ? unit.molecules : [];
      const total = mols.length;
      const CHUNK = 5;
      if (total > CHUNK) {
        for (let i = 0; i < total; i += CHUNK) {
          if (!state.running) return { ok: false, error: "stopped" };
          /* real work, discarded: it paces the loop and reports honest
           * progress. The digest below is the single authoritative call. */
          screenUnit({ unit_id: unitId, molecules: mols.slice(i, i + CHUNK) }, localRefs);
          state.done = Math.min(i + CHUNK, total);
          state.total = total;
          emit("progress", { unitId, done: state.done, total });
          if (localChunkCounter % SPOTLIGHT_EVERY === 0) {
            let m = null, smi = null, cid = "";
            try { m = mols[i]; smi = m && m.smiles; cid = m && m.id !== undefined ? String(m.id) : ""; } catch (_) { smi = null; }
            emit("spotlight", { unitId, index: i, cid, smiles: typeof smi === "string" ? smi : "", result: screenMolecule(smi, localRefs) });
          }
          localChunkCounter++;
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      const result = screenUnit(unit, localRefs);
      state.done = total;
      emit("progress", { unitId, done: total, total });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  }

  function killWorker() {
    if (worker) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
  }

  /* Exactly one worker, ever. Screening is CPU-bound, so a second one would
   * not go faster — it would just take another core from the person who lent
   * us this one. */
  function ensureWorker() {
    if (worker) return worker;
    if (typeof Worker !== "function") return null;
    try {
      worker = new Worker(workerUrl(), { type: "module" });
    } catch (_) {
      worker = null;
      return null;
    }
    worker.onmessage = (ev) => {
      const d = (ev && ev.data) || {};
      if (d.type === "progress") {
        state.done = typeof d.done === "number" ? d.done : state.done;
        state.total = typeof d.total === "number" ? d.total : state.total;
        emit("progress", { unitId: pending ? pending.unitId : state.lastUnitId, done: state.done, total: state.total });
        return;
      }
      if (d.type === "spotlight") {
        /* display only: forwarded as it came, tagged with the unit in flight.
         * A stopped loop forwards nothing — the worker may still be finishing
         * the unit that was in flight when Stop was pressed, and its specimen
         * must not light a stage the visitor just switched off. */
        if (!state.running) return;
        emit("spotlight", {
          unitId: pending ? pending.unitId : (typeof d.unitId === "string" ? d.unitId : state.lastUnitId),
          index: d.index, cid: d.cid, smiles: d.smiles, result: d.result
        });
        return;
      }
      if (d.type === "done") {
        /* A unit that came back whole is proof the worker is healthy, so the
         * failure count starts again from zero. Without this reset the counter
         * is a lifetime tally: two unrelated hiccups an hour apart would demote
         * a perfectly good browser to main-thread screening for ever. */
        workerFailures = 0;
        settle({ ok: true, result: d.result });
        return;
      }
      if (d.type === "error") { settle({ ok: false, error: String(d.message || "the screener failed") }); return; }
    };
    worker.onerror = () => {
      /* A worker that will not even load (a 404, a blocked module script) must
       * not stall the swarm for ever: after two failures the client screens on
       * the main thread instead and says so through the loop's error event. */
      workerFailures++;
      if (workerFailures >= 2) workerBroken = true;
      settle({ ok: false, error: workerBroken ? "the background screener is unavailable — screening on the page instead" : "the screener crashed" });
      killWorker();   // a crashed worker is replaced, never reused
    };
    return worker;
  }

  function settle(outcome) {
    if (!pending) return;
    const p = pending;
    pending = null;
    if (p.timer !== null) clearTimeout(p.timer);
    p.resolve(outcome);
  }

  function screenInWorker(unit, unitId) {
    if (!workersUsable()) return screenOnThisThread(unit, unitId);
    return new Promise((resolve) => {
      const w = ensureWorker();
      if (!w) { resolve(screenOnThisThread(unit, unitId)); return; }
      const timer = setTimeout(() => {
        /* A unit that never comes back means a wedged worker; drop it and let
         * the next unit start from a clean one. A wedge counts against the
         * worker exactly as a crash does — otherwise a worker that hangs on
         * every single unit is recreated for ever and the main-thread fallback,
         * which would at least get the work done, is never reached. */
        workerFailures++;
        if (workerFailures >= 2) workerBroken = true;
        killWorker();
        settle({ ok: false, error: workerBroken
          ? "the background screener is unavailable — screening on the page instead"
          : "the screener took too long" });
      }, cfg.unitMs);
      pending = { unitId, resolve, timer };
      try {
        w.postMessage({ type: "screen", unit });
      } catch (_) {
        settle({ ok: false, error: "could not hand the unit to the screener" });
      }
    });
  }

  /* ————— identity ————— */

  async function join(name) {
    const wanted = typeof name === "string" ? name.slice(0, 40) : "";
    const res = await call("join", { body: { name: wanted } });
    if (!res.ok) {
      state.lastError = res.error;
      emit("error", { where: "join", message: res.error });
      return null;   // join NEVER throws: a UI button must not blow up the page
    }
    const token = typeof res.data.token === "string" ? res.data.token : "";
    if (!token) {
      state.lastError = "the server did not issue a token";
      emit("error", { where: "join", message: state.lastError });
      return null;
    }
    state.identity = {
      token,
      contributor: res.data.contributor === undefined ? null : res.data.contributor,
      name: typeof res.data.name === "string" ? res.data.name : wanted,
      team: null   // a fresh token is a fresh contributor, and a contributor starts in no team
    };
    state.stored = writeStore(state.identity);
    emit("joined", {
      contributor: state.identity.contributor,
      name: state.identity.name,
      stored: state.stored
    });
    return { contributor: state.identity.contributor, name: state.identity.name };
  }

  /* ————— teams and the personal record ————— */

  /* Every method below returns { ok, data } or { ok, error } and never throws:
   * these are wired straight to buttons. None of them touches the loop, the
   * worker or anyone's CPU — they are bookkeeping about a token that already
   * exists. A method that needs a token and has none says so instead of
   * minting one: joining the swarm is the Lab's decision, made on a press. */
  const NO_TOKEN = { ok: false, error: "not_joined" };

  function shapeTeam(t) {
    return cleanTeam(t);
  }

  function rememberTeam(team) {
    if (!state.identity) return;
    state.identity.team = team;
    state.stored = writeStore(state.identity);
  }

  async function me() {
    if (!state.identity) return NO_TOKEN;
    const res = await call("me", { params: { token: state.identity.token }, readError: true });
    if (!res.ok) { forgetIdentityOn(res); return { ok: false, error: res.error, status: res.status }; }
    const c = isPlainObject(res.data.contributor) ? res.data.contributor : null;
    if (c) {
      /* The server's view of this contributor is the truth about them; the
       * stored record is only a cache of it. */
      if (typeof c.name === "string") state.identity.name = c.name.slice(0, 40);
      rememberTeam(shapeTeam(c.team));
    }
    return { ok: true, data: res.data };
  }

  async function teamCreate(name) {
    if (!state.identity) return NO_TOKEN;
    const wanted = typeof name === "string" ? name.slice(0, 24) : "";
    const res = await call("team_create", { body: { token: state.identity.token, name: wanted }, readError: true });
    if (!res.ok) { forgetIdentityOn(res); return { ok: false, error: res.error, status: res.status }; }
    const team = shapeTeam(res.data.team);
    if (!team) return { ok: false, error: "the server did not describe the team" };
    rememberTeam(team);
    emit("team", { team });
    return { ok: true, data: res.data };
  }

  async function teamJoin(code) {
    if (!state.identity) return NO_TOKEN;
    const wanted = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!TEAM_CODE_RE.test(wanted)) return { ok: false, error: "bad_code" };
    const res = await call("team_join", { body: { token: state.identity.token, code: wanted }, readError: true });
    if (!res.ok) { forgetIdentityOn(res); return { ok: false, error: res.error, status: res.status }; }
    const team = shapeTeam(res.data.team);
    if (!team) return { ok: false, error: "the server did not describe the team" };
    rememberTeam(team);
    emit("team", { team });
    return { ok: true, data: res.data };
  }

  async function teamLeave() {
    if (!state.identity) return NO_TOKEN;
    const res = await call("team_leave", { body: { token: state.identity.token }, readError: true });
    if (!res.ok) { forgetIdentityOn(res); return { ok: false, error: res.error, status: res.status }; }
    rememberTeam(null);
    emit("team", { team: null });
    return { ok: true, data: res.data };
  }

  /* Leaving the swarm: the server hides this contributor from every board
   * (their verified work stays counted in the totals — it was real), and this
   * browser forgets the token. The loop is stopped FIRST, so no unit is ever
   * screened for a record that is being forgotten. */
  async function leave() {
    if (!state.identity) return NO_TOKEN;
    const res = await call("leave", { body: { token: state.identity.token }, readError: true });
    if (!res.ok) { forgetIdentityOn(res); return { ok: false, error: res.error, status: res.status }; }
    if (state.running) halt("left");
    const was = state.identity;
    state.identity = null;
    state.stored = false;
    state.pendingName = "";
    clearStore();
    emit("left", { contributor: was.contributor, name: was.name });
    return { ok: true, data: res.data };
  }

  /* ————— the loop ————— */

  /* A 401 is not a transport failure, it is the server saying "I have never
   * heard of you". Retrying the same token behind an exponential backoff means
   * retrying it for ever at 60s a go: the volunteer donates nothing and the
   * only cure is clearing site data. This is not exotic — the swarm database
   * is created on demand, so a single reset of it invalidates every stored
   * token at once. Drop the identity and the next lap of the loop re-joins. */
  function forgetIdentityOn(res) {
    if (!res || res.status !== 401) return false;
    state.identity = null;
    state.stored = false;
    clearStore();
    return true;
  }

  function bumpBackoff() {
    state.backoffMs = state.backoffMs
      ? Math.min(state.backoffMs * 2, cfg.backoffMaxMs)
      : cfg.backoffMinMs;
    return state.backoffMs;
  }

  /* A work unit is never bigger than the server's own batch (LOS_BATCH = 40).
   * This ceiling is five times that, and it exists because the only other
   * bound on a unit is call()'s 256 KB response cap — which a misconfigured or
   * hostile server can fill with thousands of molecules. Screening those is one
   * long block on whichever thread gets them, and on the main-thread fallback
   * that block is the page freezing. A unit we cannot screen politely is a unit
   * we refuse, not one we try. */
  const MAX_UNIT_MOLECULES = 200;

  function validUnit(u) {
    if (!isPlainObject(u)) return null;
    const id = u.unit_id === undefined || u.unit_id === null ? "" : String(u.unit_id);
    if (!id) return null;
    if (!Array.isArray(u.molecules)) return null;
    if (u.molecules.length > MAX_UNIT_MOLECULES) return null;
    /* Both stamps are normalised here so the gate below compares like with
     * like. An absent or malformed stamp becomes "", which the server's own
     * contract defines as "unspecified — do not gate on it". */
    return {
      unit_id: id,
      molecules: u.molecules,
      engine: typeof u.engine === "string" ? u.engine : "",
      targets_digest: /^[0-9a-f]{64}$/.test(String(u.targets_digest || "")) ? String(u.targets_digest) : ""
    };
  }

  /* THE TRUST MODEL, ENFORCED ON THIS SIDE. The whole point of the swarm is
   * that two strangers screening the same unit produce the same digest, so
   * "two people agreed" means two INDEPENDENT engines agreed. A unit is
   * stamped by the server with the engine version and reference-set digest it
   * was queued for; if this page computed its answer with anything else, the
   * answer is not an independent confirmation of that unit — it is a different
   * question, answered confidently.
   *
   * The server cannot catch this for us: it has no JavaScript, so it cannot
   * compute targetsDigest() and cannot tell a current bundle from a stale one.
   * And ENGINE_VERSION alone is not the discriminator either — every edit to
   * targets.js changes the reference-set digest while the version string sits
   * still. So the check lives here, it compares BOTH stamps, and a mismatch
   * stops the loop rather than quietly poisoning an agreement count. */
  function engineMismatch(unit, result) {
    if (unit.engine && unit.engine !== result.engine) {
      return "this page's screening engine is " + result.engine + ", but that unit was queued for " + unit.engine;
    }
    if (unit.targets_digest && unit.targets_digest !== result.targetsDigest) {
      return "this page's reference set does not match the one that unit was queued for";
    }
    return "";
  }

  /* `gen` is how a stop()/start() pair cannot leave the client wedged: each
   * begin() takes a new generation, and a loop whose generation is stale exits
   * without touching the running flag that the newer loop owns. */
  async function loop(myGen) {
    if (state.loopActive) return;
    state.loopActive = true;
    try {
      while (state.running && myGen === state.gen) {
        if (!state.identity) {
          const who = await join(state.pendingName || "");
          if (!state.running) break;
          if (!who) { await sleep(bumpBackoff()); continue; }
        }

        const res = await call("work", { params: { token: state.identity.token } });
        if (!state.running) break;

        if (!res.ok) {
          forgetIdentityOn(res);
          state.lastError = res.error;
          emit("error", { where: "work", message: res.error, retryInMs: bumpBackoff() });
          await sleep(state.backoffMs);
          continue;
        }
        state.backoffMs = 0;

        if (res.data.idle === true || !res.data.unit) {
          emit("idle", { retryInMs: cfg.idleMs, message: "No work units are waiting — checking again shortly." });
          await sleep(cfg.idleMs);
          continue;
        }

        const unit = validUnit(res.data.unit);
        if (!unit) {
          emit("error", { where: "work", message: "the server sent a work unit we cannot read", retryInMs: bumpBackoff() });
          await sleep(state.backoffMs);
          continue;
        }

        state.lastUnitId = unit.unit_id;
        state.done = 0;
        state.total = unit.molecules.length;
        emit("unit", { unitId: unit.unit_id, total: state.total, engine: unit.engine || null });

        const run = await screenInWorker(unit, unit.unit_id);
        if (!state.running) break;

        if (!run.ok || !isPlainObject(run.result) || typeof run.result.digest !== "string") {
          state.lastError = run.error || "the screener produced nothing";
          emit("error", { where: "screen", unitId: unit.unit_id, message: state.lastError, retryInMs: bumpBackoff() });
          await sleep(state.backoffMs);
          continue;
        }

        const result = run.result;

        /* Between screening and submitting: does the answer we just computed
         * actually answer the question we were asked? If not, submitting it
         * would spend this volunteer's good faith confirming a stale peer. */
        const mismatch = engineMismatch(unit, result);
        if (mismatch) {
          state.lastError = "this page is running an out-of-date screening engine — reload to donate again";
          emit("error", {
            where: "engine",
            unitId: unit.unit_id,
            message: state.lastError,
            detail: mismatch,
            wanted: { engine: unit.engine || null, targetsDigest: unit.targets_digest || null },
            got: { engine: result.engine, targetsDigest: result.targetsDigest }
          });
          halt("stale-engine");
          break;
        }

        const sub = await call("submit", {
          body: {
            token: state.identity.token,
            unit_id: unit.unit_id,
            engine: result.engine,
            digest: result.digest,
            results: Array.isArray(result.results) ? result.results : []
          }
        });
        if (!state.running) break;

        if (!sub.ok) {
          forgetIdentityOn(sub);
          state.lastError = sub.error;
          emit("error", { where: "submit", unitId: unit.unit_id, message: sub.error, retryInMs: bumpBackoff() });
          await sleep(state.backoffMs);
          continue;
        }
        state.backoffMs = 0;

        const status = typeof sub.data.status === "string" ? sub.data.status : "pending";
        const credited = typeof sub.data.credited === "number" ? sub.data.credited : 0;
        const accepted = sub.data.accepted !== false;
        /* Only work the server actually took counts. A submission it refused —
         * a duplicate, a failed canary — is not a unit this volunteer screened
         * for the project, and counting it would make status().units disagree
         * with the leaderboard the server publishes. */
        if (accepted) state.unitsDone++;
        state.credits += credited;
        state.lastStatus = status;
        emit("submitted", {
          unitId: unit.unit_id,
          digest: result.digest,
          accepted,
          status,
          credited,
          credits: state.credits,
          units: state.unitsDone
        });
        /* A failed canary is terminal, not a bad day. The server has just
         * flagged this contributor, deleted their unconfirmed results and
         * excluded them from every future agreement count — so every further
         * unit this browser screens is heat and battery spent on nothing. Stop,
         * and say so, rather than let the UI show a happily climbing counter
         * for work that is being thrown away. */
        if (status === "canary_failed") {
          state.lastError = "this browser answered a unit whose correct result the server already knew — screening stopped";
          emit("error", { where: "canary", unitId: unit.unit_id, message: state.lastError });
          halt("canary_failed");
          break;
        }
        if (status === "confirmed") {
          state.unitsConfirmed++;
          emit("confirmed", {
            unitId: unit.unit_id,
            credited,
            credits: state.credits,
            units: state.unitsDone,
            confirmed: state.unitsConfirmed,
            status
          });
        }

        await sleep(cfg.paceMs);
      }
    } catch (err) {
      /* Nothing above is supposed to throw; if something does, the loop ends
       * quietly with an error event rather than leaving a zombie "running"
       * client behind. */
      state.lastError = errText(err);
      emit("error", { where: "loop", message: state.lastError });
    } finally {
      state.loopActive = false;
      state.done = 0;
      /* Two ways a loop ends: someone called halt(), which has already emitted
       * the stopped event with the real reason, or the loop fell over on its
       * own, which nobody has reported yet. stoppedGen tells the two apart, so
       * exactly one stopped event is emitted per generation and it never has to
       * guess why it stopped. A loop whose generation has been superseded says
       * nothing at all — the newer generation owns the client now. */
      if (myGen === state.gen && stoppedGen !== myGen) {
        state.running = false;
        stoppedGen = myGen;
        emit("stopped", { reason: state.lastError ? "error" : "finished", units: state.unitsDone, credits: state.credits });
      }
    }
  }

  /* ————— visibility ————— */

  /* A hidden tab is a person who has moved on. Browsers already throttle
   * background timers, but the honest behaviour is to stop outright and pick
   * up when they come back — unless they explicitly asked for background
   * work. */
  function onVisibility() {
    try {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        if (state.running && !background) {
          state.pausedByVisibility = true;
          halt("hidden");
        }
      } else if (state.pausedByVisibility) {
        state.pausedByVisibility = false;
        begin();
      }
    } catch (_) { /* never let a visibility handler take the page down */ }
  }
  try {
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibility);
    }
  } catch (_) {}

  /* halt() is the authoritative reporter of WHY the loop stopped, because it is
   * the only place that knows: a plain stop(), a hidden tab, a failed canary, a
   * stale engine. It used to defer to the loop's finally whenever a loop was
   * running, and the finally then re-derived the reason from state.lastError —
   * which halt() had just cleared — so every deliberate stop was reported as
   * "finished". Worse, a stop() immediately followed by start() lost the event
   * entirely: halt() stayed quiet because a loop was active, and that loop then
   * stayed quiet because its generation had been superseded.
   *
   * So halt() emits, now, always; the loop's finally checks stoppedGen and does
   * not emit a second time. And lastError is left alone — a UI that stops after
   * a failure still needs to be able to read the failure out of status(). */
  function halt(reason) {
    state.running = false;
    stoppedGen = state.gen;
    settle({ ok: false, error: "stopped" });
    wakeNow();
    emit("stopped", { reason, units: state.unitsDone, credits: state.credits });
  }

  function begin() {
    if (state.running && state.loopActive) return;
    state.gen++;
    const myGen = state.gen;
    state.running = true;
    state.backoffMs = 0;
    /* A fresh run starts from a clean slate; the previous run's error has been
     * readable in status() right up to this moment. */
    state.lastError = null;
    wakeNow();                       // hurry a previous generation out of its sleep
    if (!state.loopActive) { loop(myGen); return; }
    /* A previous loop is still unwinding (it is inside a fetch, say). Wait for
     * it to let go rather than running two loops against one worker. */
    const kick = () => {
      if (!state.running || myGen !== state.gen) return;
      if (state.loopActive) { setTimeout(kick, 20); return; }
      loop(myGen);
    };
    setTimeout(kick, 0);
  }

  /* ————— the public surface ————— */

  return {
    /* Ask the server for a contributor token. Safe to call more than once;
     * an existing stored token is replaced by the new one — which also means
     * a NEW contributor: the server has no rename, so a UI that only wants to
     * change the fallback name uses setName() and keeps the record it has. */
    join(name) {
      state.pendingName = typeof name === "string" ? name : "";
      return join(state.pendingName);
    },

    /* The name to sign up with if the loop ever has to (re-)join on its own —
     * after a 401, say. Touches nothing on the server and nothing stored. */
    setName(name) {
      state.pendingName = typeof name === "string" ? name.slice(0, 40) : "";
      return state.pendingName;
    },

    /* THE ONLY DOOR INTO SOMEONE'S CPU. Called from a click handler, never
     * from module scope, never from a load event. */
    start() {
      state.pausedByVisibility = false;
      begin();
      return true;
    },

    stop() {
      state.pausedByVisibility = false;
      halt("stopped");
      return true;
    },

    status() {
      return {
        running: state.running,
        paused: state.pausedByVisibility,
        joined: !!state.identity,
        stored: state.stored,
        contributor: state.identity ? state.identity.contributor : null,
        name: state.identity ? state.identity.name : "",
        units: state.unitsDone,
        confirmed: state.unitsConfirmed,
        credits: state.credits,
        unitId: state.lastUnitId,
        done: state.done,
        total: state.total,
        lastStatus: state.lastStatus,
        lastError: state.lastError,
        backoffMs: state.backoffMs,
        background,
        team: state.identity ? (state.identity.team || null) : null,
        pace: cfg.paceMs
      };
    },

    isRunning() { return state.running; },

    contributor() {
      return state.identity
        ? {
            id: state.identity.contributor,
            contributor: state.identity.contributor,   // the older name for `id`, kept
            name: state.identity.name,
            team: state.identity.team || null,
            token: !!state.identity.token
          }
        : null;
    },

    /* The visitor's own throttle. Takes effect from the next unit; a loop
     * already sleeping keeps its current pause, and stop() still cuts any
     * pause short. */
    setPace(ms) { cfg.paceMs = clampPace(ms, cfg.paceMs); return cfg.paceMs; },
    pace() { return cfg.paceMs; },

    /* Bookkeeping about an existing token — see the section above. */
    me,
    teamCreate,
    teamJoin,
    teamLeave,
    leave,

    /* Opting in to background work is a separate, explicit act. */
    setBackground(on) { background = on === true; return background; },

    /* Release everything: used by a UI that is tearing the Lab down. */
    dispose() {
      halt("disposed");
      killWorker();
      try {
        if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
          document.removeEventListener("visibilitychange", onVisibility);
        }
      } catch (_) {}
    }
  };
}

/* QA hook — a test surface only. Note what it is NOT: it exposes the factory,
 * not a running client, so even a page with this hook donates nothing until
 * someone calls start(). */
try {
  if (typeof window !== "undefined") window.__losSwarm = { createSwarmClient };
} catch (_) {}
