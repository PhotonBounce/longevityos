/* sound — the console's instrument sounds (4.0, spec §8).
 *
 * WHAT THIS IS. Eleven short recordings keyed to REAL events — a unit
 * arriving, a fingerprint sent, a second volunteer matching — and nothing
 * else. No sound is keyed to a score: a unit scoring 12/1000 sounds exactly
 * like one scoring 940, because the swarm has measured nothing that deserves
 * a fanfare.
 *
 * THE CONSENT RULE, in three parts, all enforced by the SHAPE of this file
 * rather than by a flag somebody could flip:
 *
 *   1. No Audio element is constructed before a gesture. The only `new Audio(`
 *      in this module is inside a function that runs strictly after enable(),
 *      and enable() refuses anything that is not a TRUSTED pointer or keyboard
 *      event — a script-dispatched click is not a person. There is no
 *      AudioContext here at all.
 *   2. A remembered preference ARMS, it never acts. A visitor who switched
 *      sounds on last week loads a silent page whose speaker reads "press
 *      anywhere to start sound"; their next tap SPENDS that arming, and the
 *      first sound they hear is the console waking up. Nothing is fetched —
 *      not the manifest, not one file — until that tap.
 *   3. Files are loaded lazily, one at a time, only after arming, and only
 *      those a manifest says exist. A missing manifest or a missing file means
 *      silence, never an error — the page is complete without a byte of audio.
 *
 * Every state a visitor could hear is also printed as text (the speaker's own
 * label, the wizard's toggles), so a visitor who cannot hear loses nothing.
 *
 * The recordings themselves are generated on a runner from the prompts in
 * SFX below (tools/gen-audio.mjs) and are never committed; the manifest they
 * write beside them (app/audio/manifest.json) is the only thing this module
 * trusts about what exists.
 */

/* ————— the table (spec §8, verbatim) ————— */

/* `file` is the event key the rest of the app plays by. Seconds and prompts
 * are the generator's inputs; they are exported so the generator and the
 * page can never disagree about what a sound is. */
export const SFX = Object.freeze([
  { event: "sound armed", file: "console-wake", seconds: 1.4, loop: false,
    prompt: "Vintage lab instrument powering on: soft electrical thunk, low hum rising and settling, one relay click. Dry, no music." },
  { event: "unit arrives", file: "unit-issued", seconds: 0.5, loop: false,
    prompt: "One soft square-wave data blip with a tiny relay click. Dry, quiet, no melody." },
  /* 0.5 s is the shortest the generator will render (see SFX_MIN_SECONDS in
   * tools/gen-audio.mjs); the transient is asked for at the very start and
   * the rest is silence, so what the visitor hears is still a tick. */
  { event: "specimen drawn", file: "molecule-lock", seconds: 0.5, loop: false,
    prompt: "A tiny glassy click like a lens element seating, right at the start, then silence. Barely audible, no ring, no tail." },
  { event: "fingerprint sent", file: "unit-submitted", seconds: 0.6, loop: false,
    prompt: "Brief upward two-tone data chirp from an old telemetry console, dry, faint tape tick." },
  { event: "second volunteer matched", file: "confirmed", seconds: 1.2, loop: false,
    prompt: "Two soft bell tones a fifth apart, warm, relay latching underneath, short decay. Calm, not triumphant." },
  { event: "disagreement", file: "conflict", seconds: 0.7, loop: false,
    prompt: "Low soft double thud, slight detuned wobble, like a relay resetting. Neutral, no buzzer." },
  { event: "no work waiting", file: "idle", seconds: 0.5, loop: false,
    prompt: "Quiet descending two-note blip, thin, dry, ending in silence." },
  { event: "server unreachable", file: "link-lost", seconds: 0.6, loop: false,
    prompt: "Thin steady carrier tone cut by a soft click and brief hiss. Quiet, no alarm." },
  { event: "wizard step", file: "wizard-step", seconds: 0.5, loop: false,
    prompt: "Tiny rotary-selector detent click at the very start, then silence. Dry, single transient, no tail." },
  { event: "stopped", file: "stopped", seconds: 0.5, loop: false,
    prompt: "Short falling hum with one relay click at the end. Quiet, final." },
  { event: "room tone (opt-in)", file: "room-tone", seconds: 12, loop: true,
    prompt: "Seamless night control-room tone: very low HVAC rumble, faint hum, distant relay tick. No rhythm, no seam." }
]);

const STORE_KEY = "los.sound.v1";
const FILE_RE = /^[a-z0-9-]{1,40}\.mp3$/;         // a manifest entry is a bare file name, never a path
const GESTURES = new Set(["pointerdown", "pointerup", "click", "keydown", "keyup", "touchend", "mousedown", "mouseup"]);
/* the two loud moments are rate-limited so a burst of confirmations (a backlog
 * landing at once) is one sound, not a peal; everything else once per 120ms */
const RATE_MS = { confirmed: 1500, "molecule-lock": 2000 };
const RATE_DEFAULT_MS = 120;
const LOAD_TIMEOUT_MS = 8000;
const KNOWN = new Set(SFX.map((s) => s.file));

function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

/* A gesture is a trusted pointer or keyboard event. `isTrusted` is the
 * browser's own word that a human produced it; a synthesised event dispatched
 * from script carries false and is refused. */
function isGesture(ev) {
  try {
    if (!ev || typeof ev !== "object") return false;
    if (typeof Event !== "undefined" && !(ev instanceof Event)) return false;   // a forged plain object is not an event
    return ev.isTrusted === true && typeof ev.type === "string" && GESTURES.has(ev.type);
  } catch (_) { return false; }
}

function readPrefs() {
  const p = { sfx: false, voice: false, room: false };
  try {
    if (typeof localStorage === "undefined") return p;
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return p;
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) return p;
    p.sfx = v.sfx === true;
    p.voice = v.voice === true;
    p.room = v.room === true;
  } catch (_) { /* storage refused: everything stays off */ }
  return p;
}

function writePrefs(p) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(STORE_KEY, JSON.stringify({ sfx: p.sfx, voice: p.voice, room: p.room }));
    return true;
  } catch (_) { return false; }
}

/* One board per page: the header's speaker, the Lab's event hooks and the
 * wizard's sample button must all be talking about the same arming state, so
 * the first caller's base wins and every later call gets the same instance. */
let shared = null;

export function viewSoundBoard(options) {
  if (shared) return shared;
  const opts = isPlainObject(options) ? options : {};
  const base = typeof opts.base === "string" && opts.base ? opts.base : "audio/";

  const prefs = readPrefs();
  const st = {
    enabled: false,        // a gesture has been spent: Audio may now exist
    armed: false,          // a remembered preference is waiting for a gesture
    suspended: false,      // room tone paused by hidden/Stop; the next gesture resumes it
    manifest: null,        // null = not asked; false = missing/unreadable; object = parsed
    manifestPromise: null,
    cache: new Map(),      // file key → { audio, ready, failed }
    loadChain: Promise.resolve(),
    lastPlay: new Map(),   // file key → last accepted play time
    room: null,            // the looping Audio, once made
    playsRequested: 0,     // QA counters — never shown
    playsAccepted: 0,
    listeners: new Set(),
    hooked: false
  };

  function notify() {
    for (const fn of st.listeners) { try { fn(label()); } catch (_) { /* a listener's problem */ } }
  }

  function label() {
    if (!prefs.sfx && !prefs.room) return "sound off";
    if (!st.enabled) return "press anywhere to start sound";
    if (st.suspended && prefs.room) return "sound on · room tone paused";
    return prefs.room && prefs.sfx ? "sound on · room tone" : prefs.room ? "room tone on" : "sound on";
  }

  /* ————— arming: a remembered preference waits for a person ————— */

  function onSpend(ev) {
    if (!isGesture(ev)) return;           // a synthesised event does not spend anything
    /* "press anywhere" means a press: a pointer, or Enter/Space. Tabbing
     * through the page, an arrow key or the Escape that leaves the wizard is
     * navigation, and navigation starts no sound. */
    if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
    unhook();
    if (!st.enabled) enable(ev);
    else if (st.suspended) resume(ev);
  }
  function hook() {
    if (st.hooked) return;
    try {
      if (typeof document === "undefined") return;
      document.addEventListener("pointerdown", onSpend, true);
      document.addEventListener("keydown", onSpend, true);
      st.hooked = true;
    } catch (_) {}
  }
  function unhook() {
    if (!st.hooked) return;
    try {
      document.removeEventListener("pointerdown", onSpend, true);
      document.removeEventListener("keydown", onSpend, true);
    } catch (_) {}
    st.hooked = false;
  }
  function arm() {
    if (st.enabled || (!prefs.sfx && !prefs.room)) return false;
    st.armed = true;
    hook();
    notify();
    return true;
  }

  /* ————— the manifest: what exists ————— */

  function cleanEntries(v) {
    const out = {};
    if (!isPlainObject(v)) return out;
    for (const k of Object.keys(v)) {
      const e = v[k];
      if (!/^[a-z0-9-]{1,40}$/.test(k) || !isPlainObject(e) || typeof e.file !== "string" || !FILE_RE.test(e.file)) continue;
      out[k] = { file: e.file, bytes: Number.isInteger(e.bytes) ? e.bytes : 0 };
    }
    return out;
  }

  /* Fetched once, only after a gesture (every caller sits behind enable() or a
   * press handler). Anything that is not a well-formed manifest is treated as
   * "no audio on this build" — silently. */
  function ensureManifest() {
    if (st.manifestPromise) return st.manifestPromise;
    st.manifestPromise = (async () => {
      try {
        if (typeof fetch !== "function") { st.manifest = false; return st.manifest; }
        const res = await fetch(base + "manifest.json", { cache: "no-cache" });
        if (!res || !res.ok) { st.manifest = false; return st.manifest; }
        const text = await res.text();
        if (text.length > 65536) { st.manifest = false; return st.manifest; }
        const v = JSON.parse(text);
        if (!isPlainObject(v)) { st.manifest = false; return st.manifest; }
        st.manifest = { sfx: cleanEntries(v.sfx), voice: cleanEntries(v.voice) };
      } catch (_) {
        st.manifest = false;
      }
      return st.manifest;
    })();
    return st.manifestPromise;
  }

  /* ————— loading: one file at a time, after arming, only what exists ————— */

  function loadFile(key) {
    const have = st.cache.get(key);
    if (have) return Promise.resolve(have);
    const entry = st.manifest && st.manifest.sfx[key];
    if (!entry) return Promise.resolve(null);
    const slot = { audio: null, ready: false, failed: false };
    st.cache.set(key, slot);
    st.loadChain = st.loadChain.then(() => new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(slot); };
      try {
        /* THE construction site. Reached only through play()/room(), which
         * refuse until enable() has been spent by a trusted gesture. */
        const a = new Audio();
        a.preload = "auto";
        a.loop = key === "room-tone";
        a.addEventListener("canplaythrough", () => { slot.ready = true; finish(); }, { once: true });
        a.addEventListener("error", () => { slot.failed = true; finish(); }, { once: true });
        a.src = base + "sfx/" + entry.file;
        slot.audio = a;
        try { a.load(); } catch (_) {}
        setTimeout(finish, LOAD_TIMEOUT_MS);   // a stalled file must not block the queue forever
      } catch (_) {
        slot.failed = true;
        finish();
      }
    }));
    return st.loadChain.then(() => slot);
  }

  function playSlot(slot) {
    if (!slot || !slot.audio || slot.failed) return;
    try {
      slot.audio.currentTime = 0;
      const p = slot.audio.play();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) { /* a refused play is silence, never an error */ }
  }

  /* ————— the public acts ————— */

  /* enable(ev): the one door. Only a trusted pointer/keyboard event opens it. */
  function enable(ev) {
    if (!isGesture(ev)) return false;
    if (st.enabled) return true;
    st.enabled = true;
    st.armed = false;
    st.suspended = false;
    unhook();
    ensureManifest().then(() => {
      if (prefs.sfx) play("console-wake");
      if (prefs.room) startRoom();
    });
    notify();
    return true;
  }

  function resume(ev) {
    if (!isGesture(ev) || !st.enabled) return false;
    st.suspended = false;
    unhook();
    if (prefs.room) startRoom();
    notify();
    return true;
  }

  /* play(key): rate-limited, refused before enable() and while sounds are off.
   * Returns whether the request was ACCEPTED (it may still be silent if the
   * file does not exist — that is not the caller's concern). */
  function play(key) {
    st.playsRequested++;
    if (typeof key !== "string" || !KNOWN.has(key) || key === "room-tone") return false;
    if (!st.enabled || !prefs.sfx) return false;
    const now = Date.now();
    const last = st.lastPlay.get(key) || 0;
    const gap = RATE_MS[key] || RATE_DEFAULT_MS;
    if (now - last < gap) return false;
    st.lastPlay.set(key, now);
    st.playsAccepted++;
    ensureManifest().then(() => loadFile(key)).then(playSlot).catch(() => {});
    return true;
  }

  function startRoom() {
    if (!st.enabled || !prefs.room || st.suspended) return;
    ensureManifest().then(() => loadFile("room-tone")).then((slot) => {
      if (!slot || !slot.audio || slot.failed || !prefs.room || st.suspended) return;
      st.room = slot.audio;
      st.room.loop = true;
      playSlot(slot);
    }).catch(() => {});
  }

  function stopRoom() {
    if (st.room) { try { st.room.pause(); } catch (_) {} }
  }

  /* suspend(): hidden tab or Stop. The loop stops NOW and stays stopped until
   * the visitor's next gesture — a page never resumes a sound on its own. */
  function suspend() {
    if (!st.enabled) return;
    stopRoom();
    if (prefs.room) { st.suspended = true; hook(); }
    notify();
  }

  function setPref(key, on) {
    if (key !== "sfx" && key !== "voice" && key !== "room") return false;
    prefs[key] = on === true;
    writePrefs(prefs);
    if (key === "room") {
      if (!prefs.room) { stopRoom(); st.suspended = false; if (!prefs.sfx) unhook(); }
      else if (st.enabled) startRoom();
      else arm();
    }
    if (key === "sfx") {
      if (!prefs.sfx && !prefs.room) { st.armed = false; unhook(); }
      else if (!st.enabled) arm();
    }
    notify();
    return prefs[key];
  }

  try {
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        try { if (document.visibilityState === "hidden") suspend(); } catch (_) {}
      });
    }
  } catch (_) {}

  /* A remembered ON is armed at construction: listeners are hooked, nothing
   * is fetched, nothing is made. */
  arm();

  shared = {
    base,
    enable,
    play,
    suspend,
    stopRoom,
    arm,
    setPref,
    prefs: () => ({ sfx: prefs.sfx, voice: prefs.voice, room: prefs.room }),
    label,
    isEnabled: () => st.enabled,
    isArmed: () => st.armed && !st.enabled,
    ensureManifest,
    manifest: () => st.manifest,
    /* the voice file for a page, if the manifest lists one — the guide's only
     * question; the guide constructs its own element inside its own press */
    voiceFile: (page) => {
      const e = st.manifest && typeof page === "string" ? st.manifest.voice[page] : null;
      return e ? base + "voice/" + e.file : null;
    },
    onChange(fn) { if (typeof fn === "function") st.listeners.add(fn); return () => st.listeners.delete(fn); },
    /* QA counters */
    counters: () => ({ requested: st.playsRequested, accepted: st.playsAccepted, cached: st.cache.size, enabled: st.enabled, armed: st.armed, suspended: st.suspended, manifest: st.manifest === null ? "unasked" : st.manifest === false ? "missing" : "ok" })
  };
  try { if (typeof window !== "undefined") window.__losSound = shared; } catch (_) {}
  return shared;
}
