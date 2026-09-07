/* wizard — setting up this browser as one node of the swarm (4.0, spec §7).
 *
 * Eight short steps in a focus-managed region. Every string a visitor reads
 * here is the specification's copy verbatim, and every one of them passes the
 * honesty lint: it says "screening" and "set up this browser", it never says
 * the m-word for the activity, it promises nothing, and it names what a result is NOT.
 *
 * NOTHING STARTS UNTIL THE LAST STEP. Step 3's calibration runs two hundred
 * molecules through the real engine ON PRESS and prints what it measured;
 * step 6 registers a token (bookkeeping, no CPU); step 7's sample press is the
 * gesture that arms sound; step 8's single button is the only line in this
 * file — and, with the Lab's classic Donate button, one of only two in the
 * app — that calls start() on the client. Escape leaves from any step and starts
 * nothing; Skip goes to the console and starts nothing. Remembered choices are
 * read when the wizard opens and are applied when a run starts, never before.
 *
 * The client is the Lab's: the wizard borrows it, and hands the Lab three
 * moments through onStart(phase, choices) — "arm" (synchronously inside the
 * press: wake lock, battery hook, status line), "gate" (after the join, before
 * start: the Lab may veto with a message, e.g. the charging gate is holding),
 * "started" (the loop is running). A string returned from "arm" or "gate" is
 * a veto, shown as text, and nothing starts.
 */

import { screenMolecule, referenceSet } from "../chem/score.js";
import { TARGETS } from "../chem/targets.js";
import { viewSoundBoard } from "./sound.js";

/* The Traffic bar's proportion: a work unit is forty molecules of SMILES and
 * ids — a few kilobytes — drawn against one megabyte. The number is the one
 * the caption states, not a picture of one; nothing here is measured. */
const TRAFFIC_KB = 4;

/* ————— copy, verbatim (spec §7) ————— */

const STEPS = Object.freeze([
  {
    key: "what",
    heading: "What this console does",
    body:
      "Your browser is about to become one node of a screening swarm. It compares newly harvested molecules " +
      "against drugs that did something in a longevity experiment and sends back a score and a fingerprint of " +
      "its work. What comes out is a ranked shortlist of hypotheses for people who do this for a living. It is " +
      "not a discovery, not a drug, and not medical advice. Nothing runs until the last step."
  },
  {
    key: "cost",
    heading: "What it costs you",
    body:
      "One CPU core, only while this tab is open and in front — close it or press Stop and it ends " +
      "immediately. A few kilobytes per work unit. No account, no email, no tracking cookies — just a random " +
      "token so your units can be credited."
  },
  {
    key: "pace",
    heading: "How hard this device works",
    body:
      "Full runs one unit after another. Gentle waits one second between units. Trickle waits four — the " +
      "coolest setting, and the slowest. Every setting screens the same molecules the same way, and it can be " +
      "changed at any time."
  },
  {
    key: "power",
    heading: "Screen and power",
    body:
      "A phone screens only while this page is open — there is no background service and no service worker. " +
      "Keep the screen awake stops the display sleeping. Only while charging pauses the moment the device " +
      "comes off power."
  },
  {
    key: "name",
    heading: "Your name on the boards",
    body:
      "A display name is optional and appears only on the boards and your record page. Without one, your work " +
      "is counted as anonymous and everything else works identically. Badges count verified units — work, " +
      "never luck."
  },
  {
    key: "team",
    heading: "A team, if you want one",
    body:
      "A team is a shared tally — a household, a lab group, a classroom. Your units and credits stay yours; " +
      "the team adds them up."
  },
  {
    key: "sound",
    heading: "Sound and voice",
    body:
      "The console has instrument sounds and a short spoken guide on each page. Both are off until switched on " +
      "here, and nothing plays until your next tap. Every spoken line is printed on the page as text."
  },
  {
    key: "consent",
    heading: "Consent, and start",
    body:
      "Here is what this browser is about to do: screen work units at the pace you chose, only while this tab " +
      "is open, and stop the instant you press Stop. Two independent volunteers must produce the same " +
      "fingerprint before any result counts. Nothing on this page has been tested in a living thing. Pressing " +
      "the button below is the first moment any CPU is donated."
  }
]);

const PACES = Object.freeze([
  ["full", 0, "Full", "one unit after another"],
  ["gentle", 1000, "Gentle", "one second between units"],
  ["trickle", 4000, "Trickle", "four seconds between units — the coolest setting, and the slowest"]
]);
const PHONE_KEY = "los.phone.v1";     // the Lab's own key and shape: { wake, charging, pace }
const WIZARD_KEY = "los.wizard.v1";   // { name }
const NAME_MAX = 24;
const TEAM_NAME_MAX = 24;
const TEAM_CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const CALIBRATION_N = 200;
const CALIBRATION_CHUNK = 20;
const UNIT_SIZE = 40;               // molecules per work unit, the server's shape
const BOOKKEEPING = "registers a token; uses no CPU";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
function groupInt(n) {
  const s = String(Math.max(0, Math.floor(n)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function cleanName(v) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
}

/* ————— remembered choices: read on open, applied only when a run starts ————— */

function readStore(key) {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return isPlainObject(v) ? v : null;
  } catch (_) { return null; }
}
function writeStore(key, obj) {
  try {
    if (typeof localStorage === "undefined") return false;
    localStorage.setItem(key, JSON.stringify(obj));
    return true;
  } catch (_) { return false; }
}

function touchDevice() {
  try { return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches; } catch (_) { return false; }
}
function wakeLockAvailable() {
  try { return !!(typeof navigator !== "undefined" && navigator.wakeLock && typeof navigator.wakeLock.request === "function"); } catch (_) { return false; }
}
function batteryAvailable() {
  try { return typeof navigator !== "undefined" && typeof navigator.getBattery === "function"; } catch (_) { return false; }
}
function cores() {
  try { const n = navigator.hardwareConcurrency; return Number.isInteger(n) && n > 0 ? n : 0; } catch (_) { return 0; }
}

/* ————— the calibration: 200 real molecules through the real engine, on press ————— */

let refsCache = null;
function refs() {
  if (!refsCache) refsCache = referenceSet();
  return refsCache;
}
function bundledSmiles() {
  const out = [];
  for (const t of TARGETS) for (const a of t.actives || []) if (typeof a.smiles === "string") out.push(a.smiles);
  return out;
}

/* Runs on the main thread in chunks with a real yield between them, so the
 * page stays answerable. Measures only the time spent inside the engine.
 * Returns { ms, n } — real numbers, from this device, just now. */
function calibrate(smiles, onProgress) {
  return new Promise((resolve) => {
    /* the reference actives (real, and heavy — rapamycin is 51 atoms) plus
     * whatever the public shortlist holds: a representative sample, not a
     * flattering one */
    const list = bundledSmiles().concat(smiles);
    const r = refs();
    let i = 0, ms = 0;
    const now = () => (typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now());
    const step = () => {
      const t0 = now();
      const end = Math.min(CALIBRATION_N, i + CALIBRATION_CHUNK);
      for (; i < end; i++) {
        try { screenMolecule(list[i % list.length], r); } catch (_) { /* a refused molecule still took its time */ }
      }
      ms += now() - t0;
      try { onProgress(i); } catch (_) {}
      if (i < CALIBRATION_N) setTimeout(step, 0);
      else resolve({ ms, n: CALIBRATION_N });
    };
    setTimeout(step, 0);
  });
}

function ratesFrom(measure) {
  const perMol = measure.ms / measure.n;
  const unitMs = perMol * UNIT_SIZE;
  return PACES.map(([key, pause, label]) => ({
    key, label, pause,
    perMinute: unitMs + pause > 0 ? Math.round((UNIT_SIZE / (unitMs + pause)) * 60000) : 0
  }));
}

/* ————— the wizard ————— */

let opened = 0;   // generation: a wizard closed mid-await must not act afterwards

export function viewWizard(host, options) {
  if (!host || typeof host.appendChild !== "function") return null;
  const opts = isPlainObject(options) ? options : {};
  const getClient = typeof opts.client === "function" ? opts.client : () => opts.client || null;
  const onStart = typeof opts.onStart === "function" ? opts.onStart : () => true;
  const onClose = typeof opts.onClose === "function" ? opts.onClose : () => {};
  const molecules = Array.isArray(opts.molecules) ? opts.molecules.filter((s) => typeof s === "string" && s.length > 0 && s.length < 4000) : [];
  const sound = viewSoundBoard({ base: typeof opts.base === "string" ? opts.base : "audio/" });
  const gen = ++opened;

  /* remembered choices — read now, applied at start */
  const phone = readStore(PHONE_KEY) || {};
  const own = readStore(WIZARD_KEY) || {};
  const rememberedPace = PACES.some((p) => p[1] === phone.pace) ? phone.pace : null;
  const choices = {
    pace: rememberedPace !== null ? rememberedPace : (touchDevice() ? 1000 : 0),
    wake: phone.wake === true,
    charging: phone.charging === true,
    name: cleanName(own.name),
    teamMode: "none",         // none | create | join
    teamName: "",
    teamCode: "",
    teamResult: "",           // what the server said, as text
    teamTone: "dim"
  };
  const st = {
    step: 0,
    closed: false,
    busy: false,
    measure: null,            // { ms, n }
    measuring: 0,             // molecules done so far while measuring, else 0
    startNote: "",
    startTone: "dim"
  };

  function persist() {
    writeStore(PHONE_KEY, { wake: choices.wake, charging: choices.charging, pace: choices.pace });
    writeStore(WIZARD_KEY, { name: choices.name });
  }
  function announce(key) {
    try { document.dispatchEvent(new CustomEvent("los-page", { detail: { key } })); } catch (_) {}
  }

  /* ————— the frame ————— */

  const region = el("section", "wz");
  region.setAttribute("role", "region");
  region.setAttribute("data-wizard", "region");
  /* Escape leaves from anywhere on the page while the wizard is open — the
   * focused control may have just been disabled by a press (Starting…), and
   * a visitor whose focus fell to the body must still be able to leave. */
  const onKey = (ev) => {
    if (ev.key !== "Escape" || st.closed) return;
    /* A wizard whose region has left the document (the visitor changed tab
     * while it was open) is not the thing being escaped: it closes itself
     * quietly — no preventDefault, no persist, no announce — and the key
     * goes on to whatever page the visitor is actually looking at. */
    if (!region.isConnected) { close("detached"); return; }
    ev.preventDefault();
    close("escape");
  };
  try { document.addEventListener("keydown", onKey); } catch (_) {}
  const headId = "wz-heading-" + gen;
  region.setAttribute("aria-labelledby", headId);

  const top = el("div", "wz-top");
  const progress = el("div", "wz-progress");
  progress.setAttribute("data-wizard", "progress");
  top.appendChild(progress);
  const dots = el("div", "wz-dots");
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < STEPS.length; i++) dots.appendChild(el("i", "wz-dot"));
  top.appendChild(dots);
  const leave = el("button", "wz-btn wz-btn-quiet wz-leave", "Leave setup (Esc)");
  leave.type = "button";
  leave.setAttribute("data-wizard", "leave");
  leave.addEventListener("click", () => close("leave"));
  top.appendChild(leave);
  region.appendChild(top);

  const heading = el("h3", "wz-heading");
  heading.id = headId;
  heading.tabIndex = -1;
  heading.setAttribute("data-wizard", "heading");
  region.appendChild(heading);
  const body = el("p", "wz-body");
  body.setAttribute("data-wizard", "body");
  region.appendChild(body);
  const panel = el("div", "wz-panel");
  panel.setAttribute("data-wizard", "panel");
  region.appendChild(panel);
  const nav = el("div", "wz-nav");
  region.appendChild(nav);

  host.textContent = "";
  host.appendChild(region);

  function button(label, cls, onPress, attr) {
    const b = el("button", "wz-btn" + (cls ? " " + cls : ""), label);
    b.type = "button";
    if (attr) b.setAttribute("data-wizard", attr);
    b.addEventListener("click", onPress);
    return b;
  }

  function goTo(n, focusHeading) {
    if (st.closed) return;
    const next = Math.max(0, Math.min(STEPS.length - 1, n));
    if (next !== st.step) sound.play("wizard-step");
    st.step = next;
    render();
    if (focusHeading !== false) { try { heading.focus({ preventScroll: false }); } catch (_) { try { heading.focus(); } catch (__) {} } }
  }

  function close(reason) {
    if (st.closed) return;
    st.closed = true;
    /* Every choice was persisted the moment it changed, so this write is only
     * a belt to those braces — and it is skipped for a wizard that is no
     * longer on screen: its choices may be older than what the visitor has
     * since set elsewhere, and a stale close must never overwrite them, nor
     * relabel the guide's transcript for a page the visitor is not on. */
    const onScreen = region.isConnected;
    if (onScreen) persist();
    try { document.removeEventListener("keydown", onKey); } catch (_) {}
    try { region.remove(); } catch (_) {}
    if (onScreen) announce("lab");
    try { onClose({ reason, choices: Object.assign({}, choices) }); } catch (_) {}
  }

  /* ————— the steps' controls ————— */

  function ledBar(label, value, fraction) {
    const row = el("div", "wz-cost");
    row.appendChild(el("span", "wz-cost-k", label));
    const track = el("span", "wz-bar");
    track.setAttribute("aria-hidden", "true");
    const fill = el("i", "wz-bar-fill");
    fill.style.transform = "scaleX(" + Math.max(0, Math.min(1, fraction)).toFixed(3) + ")";
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "wz-cost-v", value));
    return row;
  }

  function radio(name, value, label, note, checked, onChange, attr) {
    const opt = el("label", "wz-opt");
    const r = el("input");
    r.type = "radio";
    r.name = name;
    r.value = String(value);
    r.checked = checked;
    if (attr) r.setAttribute("data-wizard", attr);
    r.addEventListener("change", () => { if (r.checked) onChange(value); });
    opt.appendChild(r);
    const t = el("span", "wz-opt-text");
    t.appendChild(el("span", "wz-opt-label", label));
    if (note) t.appendChild(el("span", "wz-opt-note", note));
    opt.appendChild(t);
    return opt;
  }

  function toggle(label, checked, onChange, attr, disabledNote) {
    const row = el("label", "wz-opt wz-toggle");
    const box = el("input");
    box.type = "checkbox";
    box.checked = checked && !disabledNote;
    if (attr) box.setAttribute("data-wizard", attr);
    if (disabledNote) { box.disabled = true; row.classList.add("wz-opt-off"); }
    box.addEventListener("change", () => onChange(box.checked));
    row.appendChild(box);
    const t = el("span", "wz-opt-text");
    t.appendChild(el("span", "wz-opt-label", label));
    const note = el("span", "wz-opt-note", disabledNote || "");
    t.appendChild(note);
    row.appendChild(t);
    return { row, box, note };
  }

  function buildWhat() { /* copy only */ }

  function buildCost() {
    const n = cores();
    panel.appendChild(ledBar("CPU", n ? "1 core of " + n + ", only while this tab is in front" : "1 core, only while this tab is in front", n ? 1 / n : 0.25));
    panel.appendChild(ledBar("Traffic", "a few kilobytes per work unit", TRAFFIC_KB / 1024));
    panel.appendChild(ledBar("Personal data", "NONE", 0));
    panel.appendChild(el("p", "wz-fine", "The bars are proportions, not measurements: one core of what this device reports, a unit's few kilobytes against a megabyte (so little that the bar barely lights), and nothing at all."));
  }

  function buildPace() {
    const opts = el("div", "wz-opts");
    for (const [key, ms, label, note] of PACES) {
      opts.appendChild(radio("wz-pace", ms, label, note, choices.pace === ms, (v) => {
        choices.pace = v;
        persist();
        const c = getClient();
        if (c && typeof c.setPace === "function") { try { c.setPace(v); } catch (_) {} }
        paintMeasure();
      }, "pace-" + key));
    }
    panel.appendChild(opts);
    const measureBtn = button("Measure this device", "", async () => {
      if (st.measuring || st.busy) return;
      st.measuring = 1;
      measureBtn.disabled = true;
      paintMeasure();
      let m = null;
      try {
        m = await calibrate(molecules, (done) => { st.measuring = Math.max(1, done); paintMeasure(); });
      } catch (_) { m = null; }
      if (st.closed || gen !== opened) return;
      st.measuring = 0;
      st.measure = m;
      measureBtn.disabled = false;
      paintMeasure();
    }, "measure");
    panel.appendChild(measureBtn);
    const out = el("div", "wz-measure");
    out.setAttribute("data-wizard", "measure-out");
    out.setAttribute("aria-live", "polite");
    panel.appendChild(out);
    st.measureOut = out;
    paintMeasure();
  }

  function paintMeasure() {
    const out = st.measureOut;
    if (!out || !out.isConnected) return;
    out.textContent = "";
    if (st.measuring) {
      out.appendChild(el("p", "wz-measure-line", "Measuring — " + st.measuring + " of " + CALIBRATION_N + " molecules through the engine on this device…"));
      return;
    }
    if (!st.measure) {
      out.appendChild(el("p", "wz-measure-line wz-dim", "Not measured yet. The button runs " + CALIBRATION_N + " real molecules through the screening engine on this device and prints what it took."));
      return;
    }
    const rates = ratesFrom(st.measure);
    const list = el("ul", "wz-rates");
    for (const r of rates) {
      const li = el("li", "wz-rate" + (r.pause === choices.pace ? " wz-rate-on" : ""));
      li.setAttribute("data-wizard", "rate-" + r.key);
      li.appendChild(el("span", "wz-rate-k", r.label));
      const v = el("span", "wz-rate-v", groupInt(r.perMinute));
      v.setAttribute("data-per-minute", String(r.perMinute));
      li.appendChild(v);
      li.appendChild(el("span", "wz-rate-u", "molecules per minute"));
      list.appendChild(li);
    }
    out.appendChild(list);
    out.appendChild(el("p", "wz-fine", "Measured on this device just now: " + st.measure.n + " molecules in " + (st.measure.ms / 1000).toFixed(2) + " s inside the engine, " +
      "so a forty-molecule unit takes about " + ((st.measure.ms / st.measure.n) * UNIT_SIZE / 1000).toFixed(2) + " s before the pause. Other devices will differ."));
  }

  function buildPower() {
    const wake = toggle("Keep the screen awake", choices.wake, (on) => { choices.wake = on; persist(); paintPowerNotes(); }, "wake",
      wakeLockAvailable() ? "" : "this browser cannot keep the screen awake");
    const charge = toggle("Only while charging", choices.charging, (on) => { choices.charging = on; persist(); paintPowerNotes(); }, "charging",
      batteryAvailable() ? "" : "this browser does not report charging state");
    st.wakeNote = wake; st.chargeNote = charge;
    panel.appendChild(wake.row);
    panel.appendChild(charge.row);
    paintPowerNotes();
  }
  function paintPowerNotes() {
    if (st.wakeNote && !st.wakeNote.box.disabled) st.wakeNote.note.textContent = choices.wake ? "on — requested when the run starts, never before" : "off — the screen sleeps as usual";
    if (st.chargeNote && !st.chargeNote.box.disabled) st.chargeNote.note.textContent = choices.charging ? "on — unplugging pauses; plugging in resumes only a run that was going" : "off — screening continues on battery";
  }

  function buildName() {
    const input = el("input", "wz-input");
    input.type = "text";
    input.maxLength = NAME_MAX;
    input.placeholder = "Display name (optional)";
    input.value = choices.name;
    input.setAttribute("aria-label", "Display name, optional, up to 24 characters");
    input.setAttribute("data-wizard", "name");
    input.addEventListener("input", () => { choices.name = cleanName(input.value); persist(); paintPreview(); });
    panel.appendChild(input);
    const prev = el("div", "wz-preview");
    prev.setAttribute("data-wizard", "name-preview");
    panel.appendChild(prev);
    st.preview = prev;
    paintPreview();
  }
  function paintPreview() {
    const p = st.preview;
    if (!p || !p.isConnected) return;
    p.textContent = "";
    p.appendChild(el("span", "wz-prev-k", "On the boards:"));
    const row = el("span", "wz-prev-row");
    row.appendChild(el("span", "wz-prev-rank", "—"));
    row.appendChild(el("span", "wz-prev-name", choices.name || "anonymous"));
    row.appendChild(el("span", "wz-prev-num", "0 units"));
    row.appendChild(el("span", "wz-prev-num", "0 credits"));
    p.appendChild(row);
  }

  async function ensureJoined() {
    const c = getClient();
    if (!c) return null;
    try {
      if (c.status().joined) { if (choices.name) c.setName(choices.name); return c; }
      const who = await c.join(choices.name);
      return who ? c : null;
    } catch (_) { return null; }
  }

  function buildTeam() {
    const seg = el("div", "wz-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", "Team choice");
    const modes = [["create", "Start a team"], ["join", "Join a team"], ["none", "Neither"]];
    const segBtns = {};
    for (const [mode, label] of modes) {
      const b = button(label, "wz-seg-btn", () => { choices.teamMode = mode; choices.teamResult = ""; paintTeam(); }, "team-" + mode);
      segBtns[mode] = b;
      seg.appendChild(b);
    }
    panel.appendChild(seg);
    const form = el("div", "wz-team-form");
    panel.appendChild(form);
    const msg = el("p", "wz-team-msg");
    msg.setAttribute("data-wizard", "team-msg");
    msg.setAttribute("aria-live", "polite");
    panel.appendChild(msg);
    st.teamUi = { segBtns, form, msg };
    paintTeam();
  }
  function paintTeam() {
    const t = st.teamUi;
    if (!t || !t.form.isConnected) return;
    for (const m of Object.keys(t.segBtns)) t.segBtns[m].setAttribute("aria-pressed", choices.teamMode === m ? "true" : "false");
    t.form.textContent = "";
    if (choices.teamMode === "create") {
      const input = el("input", "wz-input");
      input.type = "text"; input.maxLength = TEAM_NAME_MAX; input.placeholder = "Team name (up to 24 characters)";
      input.value = choices.teamName;
      input.setAttribute("aria-label", "Team name");
      input.setAttribute("data-wizard", "team-name");
      input.addEventListener("input", () => { choices.teamName = input.value.slice(0, TEAM_NAME_MAX); });
      t.form.appendChild(input);
      t.form.appendChild(button("Create the team", "", () => teamAct("create"), "team-create"));
      t.form.appendChild(el("span", "wz-fine", BOOKKEEPING));
    } else if (choices.teamMode === "join") {
      const input = el("input", "wz-input wz-code");
      input.type = "text"; input.maxLength = 8; input.placeholder = "8-character code";
      input.value = choices.teamCode;
      input.setAttribute("aria-label", "Team code, eight characters");
      input.setAttribute("data-wizard", "team-code");
      input.setAttribute("autocapitalize", "characters");
      input.addEventListener("input", () => { choices.teamCode = input.value.toUpperCase().slice(0, 8); });
      t.form.appendChild(input);
      t.form.appendChild(button("Join the team", "", () => teamAct("join"), "team-join"));
      t.form.appendChild(el("span", "wz-fine", BOOKKEEPING));
    } else {
      t.form.appendChild(el("p", "wz-fine", "No team. Your record is your own; a team can be joined later from the console."));
    }
    t.msg.className = "wz-team-msg wz-tone-" + choices.teamTone;
    t.msg.textContent = choices.teamResult;
  }
  async function teamAct(kind) {
    if (st.busy) return;
    const name = choices.teamName.trim();
    const code = choices.teamCode.trim().toUpperCase();
    if (kind === "create" && !name) { choices.teamResult = "Give the team a name — up to 24 characters."; choices.teamTone = "warn"; paintTeam(); return; }
    if (kind === "join" && !TEAM_CODE_RE.test(code)) { choices.teamResult = "A team code is 8 letters and digits, with no 0, O, 1 or I."; choices.teamTone = "warn"; paintTeam(); return; }
    st.busy = true;
    choices.teamResult = (kind === "create" ? "Creating the team" : "Joining") + " — " + BOOKKEEPING + "…";
    choices.teamTone = "dim";
    paintTeam();
    try {
      const c = await ensureJoined();
      if (st.closed || gen !== opened) return;
      if (!c) { choices.teamResult = "Could not sign in with the server, so nothing was " + (kind === "create" ? "created" : "joined") + "."; choices.teamTone = "warn"; return; }
      const res = kind === "create" ? await c.teamCreate(name) : await c.teamJoin(code);
      if (st.closed || gen !== opened) return;
      if (!res || !res.ok) { choices.teamResult = teamError(res && res.error); choices.teamTone = "warn"; return; }
      const team = res.data && isPlainObject(res.data.team) ? res.data.team : null;
      const teamName = team && typeof team.name === "string" ? team.name.slice(0, TEAM_NAME_MAX) : name;
      const teamCode = team && typeof team.code === "string" && TEAM_CODE_RE.test(team.code) ? team.code : code;
      choices.teamResult = (kind === "create" ? "Team created" : "Joined") + ": " + teamName + (teamCode ? " · code " + teamCode : "") + " — " + BOOKKEEPING + ".";
      choices.teamTone = "ok";
      choices.teamDone = { mode: kind, name: teamName, code: teamCode };
    } finally {
      st.busy = false;
      paintTeam();
    }
  }
  function teamError(code) {
    if (code === "bad_name") return "That team name is not allowed — up to 24 plain characters.";
    if (code === "already_in_team") return "This token is already in a team. Leave it from the console to join another.";
    if (code === "bad_code") return "A team code is 8 letters and digits, with no 0, O, 1 or I.";
    if (code === "unknown_team") return "No team has that code.";
    if (code === "team_full") return "That team is full.";
    if (code === "rate_limited") return "The server asked us to slow down — try again in a minute.";
    return "The server answered: " + (typeof code === "string" ? code.slice(0, 60) : "unknown error") + ".";
  }

  function buildSound() {
    const p = sound.prefs();
    const sfx = toggle("Instrument sounds", p.sfx, (on) => { sound.setPref("sfx", on); paintSound(); }, "sfx");
    const voice = toggle("Spoken guide", p.voice, (on) => { sound.setPref("voice", on); paintSound(); }, "voice");
    const room = toggle("Room tone", p.room, (on) => { sound.setPref("room", on); paintSound(); }, "room");
    panel.appendChild(sfx.row);
    panel.appendChild(voice.row);
    panel.appendChild(room.row);
    const sample = button("Play a sample", "", (ev) => {
      /* THE ARMING GESTURE: a trusted press turns instrument sounds on if they
       * were off, and spends itself on the console waking up. */
      if (!sound.prefs().sfx) sound.setPref("sfx", true);
      sound.enable(ev);
      if (sound.isEnabled()) sound.play("console-wake");
      paintSound();
    }, "sample");
    panel.appendChild(sample);
    const state = el("p", "wz-fine wz-sound-state");
    state.setAttribute("data-wizard", "sound-state");
    panel.appendChild(state);
    st.soundUi = { sfx, voice, room, state };
    paintSound();
  }
  function paintSound() {
    const u = st.soundUi;
    if (!u || !u.state.isConnected) return;
    const p = sound.prefs();
    u.sfx.box.checked = p.sfx; u.voice.box.checked = p.voice; u.room.box.checked = p.room;
    u.sfx.note.textContent = p.sfx ? "on — " + sound.label() : "off";
    u.voice.note.textContent = p.voice ? "on — every page offers its one line as text and, where a recording exists, as a press-to-play voice" : "off — the transcript is still there on every page";
    u.room.note.textContent = (p.room ? "on" : "off") + " — a continuous sound costs battery on a phone";
    u.state.textContent = "Speaker: " + sound.label() + ".";
  }

  function buildConsent() {
    const rows = el("dl", "wz-summary");
    const add = (k, v, stepIndex, attr) => {
      const dt = el("dt", "", k);
      const dd = el("dd");
      dd.appendChild(el("span", "wz-sum-v", v));
      const change = button("Change", "wz-btn-link", () => goTo(stepIndex), "change-" + attr);
      change.setAttribute("aria-label", "Change: " + k);
      dd.appendChild(change);
      rows.appendChild(dt);
      rows.appendChild(dd);
    };
    const pace = PACES.find((p) => p[1] === choices.pace) || PACES[0];
    add("Pace", pace[2] + " — " + pace[3], 2, "pace");
    add("Screen and power", (choices.wake && wakeLockAvailable() ? "keep the screen awake" : "screen sleeps as usual") + "; " +
      (choices.charging && batteryAvailable() ? "only while charging" : "on battery too"), 3, "power");
    add("Name", choices.name || "anonymous", 4, "name");
    add("Team", choices.teamDone ? choices.teamDone.name + " (" + choices.teamDone.code + ")" : "none", 5, "team");
    const p = sound.prefs();
    add("Sound", [p.sfx ? "instrument sounds on" : "instrument sounds off", p.voice ? "spoken guide on" : "spoken guide off", p.room ? "room tone on" : ""].filter(Boolean).join(", "), 6, "sound");
    panel.appendChild(rows);
    const go = button("Join the swarm and start screening", "wz-btn-go", startRun, "start");
    panel.appendChild(go);
    st.goBtn = go;
    const note = el("p", "wz-start-note");
    note.setAttribute("data-wizard", "start-note");
    note.setAttribute("aria-live", "polite");
    panel.appendChild(note);
    st.startNoteEl = note;
    paintStart();
  }
  function paintStart() {
    if (st.goBtn && st.goBtn.isConnected) { st.goBtn.disabled = st.busy; st.goBtn.textContent = st.busy ? "Starting…" : "Join the swarm and start screening"; }
    if (st.startNoteEl && st.startNoteEl.isConnected) { st.startNoteEl.className = "wz-start-note wz-tone-" + st.startTone; st.startNoteEl.textContent = st.startNote; }
  }

  /* THE PRESS. This is the wizard's one call to start() on the client. */
  async function startRun() {
    if (st.busy || st.closed) return;
    const c = getClient();
    if (!c) { st.startNote = "This browser could not start the screener."; st.startTone = "warn"; paintStart(); return; }
    persist();
    const snapshot = Object.assign({}, choices);
    let veto = null;
    try { veto = onStart("arm", snapshot); } catch (_) { veto = null; }   // inside the gesture: wake lock, battery hook, status line
    if (typeof veto === "string" && veto) { st.startNote = veto; st.startTone = "warn"; paintStart(); close("gated"); return; }
    st.busy = true;
    st.startNote = "Signing up as a contributor — " + BOOKKEEPING + "…";
    st.startTone = "dim";
    paintStart();
    const joinedClient = await ensureJoined();
    /* CONSENT, RE-CHECKED AFTER THE AWAIT: Escape or Leave during the join
     * closed this wizard, and a closed wizard starts nothing. */
    if (st.closed || gen !== opened) return;
    try { veto = onStart("gate", snapshot); } catch (_) { veto = null; }
    if (typeof veto === "string" && veto) { st.busy = false; st.startNote = veto; st.startTone = "warn"; paintStart(); close("gated"); return; }
    try { c.setPace(choices.pace); } catch (_) {}
    let started = false;
    try { started = c.start() !== false; } catch (_) { started = false; }
    st.busy = false;
    if (!started) { st.startNote = "The screener did not start."; st.startTone = "warn"; paintStart(); return; }
    try { onStart("started", Object.assign({ joined: !!joinedClient }, snapshot)); } catch (_) {}
    close("started");
  }

  /* ————— render ————— */

  const BUILDERS = [buildWhat, buildCost, buildPace, buildPower, buildName, buildTeam, buildSound, buildConsent];

  function render() {
    const s = STEPS[st.step];
    region.setAttribute("data-wizard-step", String(st.step + 1));
    region.setAttribute("data-wizard-key", s.key);
    progress.textContent = "Step " + (st.step + 1) + " of " + STEPS.length;
    [...dots.children].forEach((d, i) => { d.className = "wz-dot" + (i < st.step ? " wz-dot-done" : i === st.step ? " wz-dot-on" : ""); });
    heading.textContent = s.heading;
    body.textContent = s.body;
    panel.textContent = "";
    st.measureOut = null; st.preview = null; st.teamUi = null; st.soundUi = null; st.goBtn = null; st.startNoteEl = null; st.wakeNote = null; st.chargeNote = null;
    BUILDERS[st.step]();
    nav.textContent = "";
    if (st.step > 0) nav.appendChild(button("Back", "wz-btn-quiet", () => goTo(st.step - 1), "back"));
    if (st.step < STEPS.length - 1) nav.appendChild(button("Next", "", () => goTo(st.step + 1), "next"));
    if (st.step === 0) nav.appendChild(button("Skip setup — take me to the console", "wz-btn-quiet", () => close("skip"), "skip"));
  }

  render();
  announce("wizard");
  try { heading.focus(); } catch (_) {}

  const api = {
    region,
    step: () => st.step + 1,
    goTo: (n) => goTo(n - 1),
    close: () => close("api"),
    choices: () => Object.assign({}, choices),
    isClosed: () => st.closed
  };
  try { if (typeof window !== "undefined") window.__losWizard = api; } catch (_) {}
  return api;
}
