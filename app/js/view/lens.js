/* lens.js — UNDER THE LENS (LongevityOS 4.0 §4): one real molecule at a time,
 * drawn from the same parsed graph the engine scored, with its real readouts.
 *
 * WHAT IT SHOWS AND WHY IT IS HONEST. The worker picks one molecule every
 * fortieth chunk of work BY POSITION (a chunk counter, never a score
 * comparison — the first molecule of that chunk) and posts its result as a
 * `spotlight`. The lens draws that molecule with viewLayoutMolecule and
 * prints the engine's own numbers: the composite score, the similarity to
 * every reference target in engine order, the descriptors, and the triage
 * flags — nothing here is computed a second time or tweened toward a nicer
 * value. A score of 700 or more turns the readout amber with the words
 * "worth a look"; that is the whole of the reaction — no sound, no bloom,
 * nothing keyed to a score.
 *
 * SAMPLING, STATED ON THE PANEL. At most one specimen is shown per 2,200 ms;
 * a spotlight that arrives while one is on stage replaces the pending one,
 * so intermediates are dropped. The caption prints live numbers — shown this
 * session, screened by this browser this session, and the ratio computed from
 * those two — never a fixed "one in N".
 *
 * WHAT IT COSTS. The SVG is a POOL allocated once (96 bond paths — the
 * layout's own bond ceiling — 24 offset lines, 48 labels, 8 aromatic circles,
 * 8 wave groups) and recycled by attribute writes and `hidden`; the node
 * count never changes after mount. The build animates the eight wave groups,
 * never elements; ≤ 2 ring-closure strokes, spaced so they never overlap;
 * one settle scale; one flip on the score LED; ten bar transitions. No rAF
 * loop exists — every phase is a setTimeout, and nothing moves while nothing
 * is running (HOLD: the last specimen at 55% opacity).
 *
 * CONSENT. This module starts nothing: it only ever reacts to events the
 * client already emitted, and the pre-run idle specimen (one molecule from
 * the public shortlist, stepped by a "Next" press) is a drawing, not a
 * screening. createElement/createElementNS and textContent only.
 */

import { viewLayoutMolecule } from "./layout.js";
import { molFromSmiles } from "../chem/aromatic.js";
import { descriptors } from "../chem/descriptors.js";
import { TARGETS } from "../chem/targets.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/* the pool — sized to the layout's own ceilings (80 atoms, 96 bonds) */
const POOL_BONDS = 96;
const POOL_OFFSETS = 24;
const POOL_LABELS = 48;
const POOL_CIRCLES = 8;
const POOL_WAVES = 8;
const POOL_BARS = 10;
const POOL_CHIPS = 12;

/* the timeline (ms) */
const BUILD_MS = 2200;      // one specimen per this; also the rate limit
const SETTLE_AT = 970;
const READOUT_AT = 1150;
const DONE_AT = 1600;
const QUIET_AT = 2000;      // the readout bars (400 ms + 9 × 30 ms stagger from 1,150) landed by 1,820 even on a throttled
                            // phone whose style recalc runs late: nothing moves after this, and the lens says so
const FLIP_MS = 180;
const WAVE_STEP_MS = 90;
const CLOSURE_MS = 180;
/* ring closures drawn as a stroke per build. document.getAnimations() lists an
 * animation from the instant it is scheduled — delay included — so at a
 * build's first instant every wave and every stroked closure counts. The
 * page-wide budget is ≤ 12 and allocates this lens "8 waves + 2 closures",
 * leaving the rest to the Lab's own progress bar, a digit flip and the
 * confirmation bloom. Closures past the second draw plainly, with their wave. */
const MAX_CLOSURES = 2;

const WORTH_A_LOOK = 700;
const LED_DIGITS = 4;
const SMILES_MAX = 4000;

/* copy — verbatim from the specification */
const TRIAGE_SENTENCE = "Triage flags. They mark a molecule for a person to look at; " +
  "the screen has measured nothing about what any of them mean in a living thing.";
const NO_FLAGS = "no drug-likeness flags raised";
const FLAGS_NOT_REPORTED = "flags not reported by the server for this record — not the same as none";
const REFUSED = "This molecule parsed and scored normally; the drawing was refused — it is larger than the lens draws, " +
  "or its coordinates did not resolve. The score beside it is the real one.";
const UNPARSEABLE = "DID NOT PARSE — scored as unparseable, score 0.";
const CAPTION_HEAD = "Showing one molecule at a time, chosen by its position in the work unit and never by its score.";
const HOLD_LINE = "Nothing is running — this is the last molecule this browser drew.";
const SHORTLIST_LINE = "From the public shortlist — two independent volunteers scored this identically. Nothing is running.";
const EMPTY_LINE = "Nothing is running and this browser has not drawn a molecule yet. " +
  "The first molecule it screens appears here, drawn as it is scored.";
const FIRST_LINE = "Screening — the first molecule of this run appears as it is scored.";
const SCREENING_LINE = "Screening.";
const WORTH_WORDS = "worth a look";
const SHORTLIST_BARS_NOTE = "Per-target similarities are not part of the public shortlist record; " +
  "the score and closest reference above are the ones two volunteers agreed on.";

/* seven-segment table, bits a..g from the top bar clockwise, g in the middle */
const SEG = Object.freeze([
  0b1111110, 0b0110000, 0b1101101, 0b1111001, 0b0110011,
  0b1011011, 0b1011111, 0b1110000, 0b1111111, 0b1111011
]);
const SEG_NAMES = ["a", "b", "c", "d", "e", "f", "g"];
/* polygon points for the seven bars of a 24×44 digit */
const SEG_POINTS = Object.freeze({
  a: "5,2 19,2 16,5 8,5",
  b: "20,3 23,6 23,20 20,23 17,20 17,6",
  c: "20,24 23,27 23,41 20,44 17,41 17,27",
  d: "5,42 19,42 16,39 8,39",
  e: "4,24 7,27 7,41 4,44 1,41 1,27",
  f: "4,3 7,6 7,20 4,23 1,20 1,6",
  g: "5,22 8,19.5 16,19.5 19,22 16,24.5 8,24.5"
});

const TARGET_NAME = new Map();
try { for (const t of TARGETS) if (t && typeof t.id === "string") TARGET_NAME.set(t.id, typeof t.name === "string" ? t.name : t.id); } catch (_) {}

/* ————— tiny DOM helpers (createElement + textContent only) ————— */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function svgEl(tag, cls) {
  const n = document.createElementNS(SVG_NS, tag);
  if (cls) n.setAttribute("class", cls);
  return n;
}
function groupInt(n) {
  const s = String(Math.max(0, Math.floor(n)));
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += ",";
    out += s[i];
  }
  return out;
}
function safeStr(v, max) {
  if (typeof v !== "string") return "";
  let s = "";
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) continue;
    s += ch;
    if (s.length >= max) break;
  }
  return s;
}
const isInt = (v) => Number.isInteger(v);

/* ————— the local seven-segment LED (an adapter: options.led may replace it) ————— */

let ledSerial = 0;
function localLed(host, digits) {
  const id = "lens-seg7-" + (++ledSerial);
  const svg = svgEl("svg", "led lens-led");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 " + (digits * 26) + " 44");
  const defs = svgEl("defs");
  const sym = svgEl("symbol");
  sym.setAttribute("id", id);
  sym.setAttribute("viewBox", "0 0 24 44");
  for (const name of SEG_NAMES) {
    const poly = svgEl("polygon", "s" + name);
    poly.setAttribute("points", SEG_POINTS[name]);
    sym.appendChild(poly);
  }
  defs.appendChild(sym);
  svg.appendChild(defs);
  const uses = [];
  for (let i = 0; i < digits; i++) {
    const u = svgEl("use");
    u.setAttribute("href", "#" + id);
    u.setAttribute("x", String(i * 26));
    u.setAttribute("width", "24");
    u.setAttribute("height", "44");
    svg.appendChild(u);
    uses.push(u);
  }
  const text = el("span", "led-text", "");
  host.appendChild(svg);
  host.appendChild(text);
  let shown = "";
  let flipTimer = null;
  const paintDigit = (u, ch) => {
    const bits = ch >= "0" && ch <= "9" ? SEG[ch.charCodeAt(0) - 48] : 0;
    for (let s = 0; s < 7; s++) u.style.setProperty("--" + SEG_NAMES[s], (bits >> (6 - s)) & 1 ? "1" : "0");
  };
  return {
    /* one step, old → new; no count-up ever */
    set(value) {
      const str = String(value).slice(-digits).padStart(digits, " ");
      if (str === shown) return;
      shown = str;
      for (let i = 0; i < digits; i++) paintDigit(uses[i], str[i]);
      text.textContent = str.trim();
      svg.classList.remove("flip");
      void svg.getBoundingClientRect();
      svg.classList.add("flip");
      if (flipTimer !== null) clearTimeout(flipTimer);
      flipTimer = setTimeout(() => { flipTimer = null; svg.classList.remove("flip"); }, FLIP_MS + 20);
    },
    text: () => text.textContent
  };
}

/* ————— the view ————— */

export function viewLens(host, options) {
  if (!host || typeof host.appendChild !== "function") return null;
  const opts = options && typeof options === "object" ? options : {};
  const onCaption = typeof opts.onCaption === "function" ? opts.onCaption : null;
  /* "specimen drawn": the sound and the drawing must be ONE event, so the
   * board is called from here, never from a second gate that could drift */
  const onDraw = typeof opts.onDraw === "function" ? opts.onDraw : null;
  /* session counters live wherever the caller keeps them, so a re-render
   * of the Lab (every tab click) does not reset "this session" */
  const session = opts.session && typeof opts.session === "object" ? opts.session : {};
  if (!isInt(session.shown)) session.shown = 0;
  if (!isInt(session.base)) session.base = 0;      // molecules of completed units
  if (!isInt(session.cur)) session.cur = 0;        // molecules of the unit in progress
  if (!isInt(session.dropped)) session.dropped = 0;
  if (!isInt(session.offered)) session.offered = 0;
  if (typeof session.drewLive !== "boolean") session.drewLive = false;   // has a live specimen ever been drawn
  if (session.last === undefined) session.last = null;                    // the last live specimen, for HOLD after a re-mount
  const makeLed = typeof opts.led === "function" ? opts.led : localLed;

  /* ————— build the DOM once ————— */
  host.classList.add("lens");

  const stage = el("div", "lens-stage");
  const head = el("div", "lens-head");
  const tag = el("span", "lens-tag", "—");
  const unitEl = el("span", "lens-unit", "");
  const mode = el("span", "lens-mode", "IDLE");
  head.appendChild(tag); head.appendChild(unitEl); head.appendChild(mode);
  stage.appendChild(head);

  const svg = svgEl("svg", "lens-svg is-blank");
  svg.setAttribute("role", "img");
  svg.setAttribute("viewBox", "0 0 320 240");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  const title = svgEl("title");
  title.textContent = "No molecule is on the lens yet.";
  const desc = svgEl("desc");
  desc.textContent = "The lens draws one molecule at a time as this browser screens it.";
  svg.appendChild(title);
  svg.appendChild(desc);
  const mol = svgEl("g", "lens-mol");
  svg.appendChild(mol);

  /* the pool */
  const waves = [];
  for (let i = 0; i < POOL_WAVES; i++) {
    const g = svgEl("g", "mol-wave");
    g.style.setProperty("--d", String(i));
    g.addEventListener("animationend", (e) => {
      /* animationend BUBBLES: a ring-closure stroke inside this group ends
       * here too, and must not end the build early (or cancel the group's own
       * grow, or its sibling closures) */
      if (e.target !== g) return;
      g.style.willChange = "";
      if (i === POOL_WAVES - 1) endBuild();
    });
    mol.appendChild(g);
    waves.push(g);
  }
  const bondPool = [], offsetPool = [], labelPool = [], circlePool = [];
  const stock = (list, count, make) => {
    for (let i = 0; i < count; i++) {
      const n = make();
      n.setAttribute("hidden", "");
      waves[i % POOL_WAVES].appendChild(n);
      list.push(n);
    }
  };
  stock(bondPool, POOL_BONDS, () => { const p = svgEl("path", "mol-bond"); p.setAttribute("d", "M0 0"); return p; });
  stock(offsetPool, POOL_OFFSETS, () => svgEl("line", "mol-offset"));
  stock(circlePool, POOL_CIRCLES, () => svgEl("circle", "mol-arom"));
  stock(labelPool, POOL_LABELS, () => svgEl("text", "mol-label"));
  stage.appendChild(svg);

  const fail = el("p", "lens-fail", "");
  fail.hidden = true;
  stage.appendChild(fail);
  const stamp = el("span", "lens-stamp", "SECOND WITNESS");
  stamp.hidden = true;
  stage.appendChild(stamp);
  host.appendChild(stage);

  /* readout column */
  const readout = el("div", "lens-readout");
  const scoreRow = el("div", "lens-score-row");
  scoreRow.appendChild(el("p", "lens-label", "Score"));
  const led = makeLed(scoreRow, LED_DIGITS);
  scoreRow.appendChild(el("span", "lens-of", "of 1000"));
  /* the words beside an amber score — not a verdict (the spec dropped that):
   * a molecule worth a person's look, nothing more */
  const worthEl = el("span", "lens-worth", WORTH_WORDS);
  worthEl.hidden = true;
  scoreRow.appendChild(worthEl);
  readout.appendChild(scoreRow);

  const bestRow = el("p", "lens-value lens-best", "");
  readout.appendChild(bestRow);

  const barsWrap = el("div", "lens-bars");
  barsWrap.appendChild(el("p", "lens-label", "Similarity to known actives · per mille"));
  const bars = [];
  for (let i = 0; i < POOL_BARS; i++) {
    const row = el("div", "lens-bar");
    row.hidden = true;
    const label = el("span", "lens-bar-label", "");
    const track = el("div", "lens-bar-track");
    const fill = el("i");
    fill.style.transitionDelay = (i * 30) + "ms";
    track.appendChild(fill);
    const val = el("span", "lens-bar-val", "");
    row.appendChild(label); row.appendChild(track); row.appendChild(val);
    barsWrap.appendChild(row);
    bars.push({ row, label, fill, val });
  }
  const barsNote = el("p", "lens-bars-note", SHORTLIST_BARS_NOTE);
  barsNote.hidden = true;
  barsWrap.appendChild(barsNote);
  readout.appendChild(barsWrap);

  const table = el("table", "lens-desc");
  const DESC_ROWS = [
    ["formula", "Formula"], ["mw", "Molecular weight"], ["clogp", "cLogP"], ["tpsa", "TPSA (Å²)"],
    ["hbd", "H-bond donors"], ["hba", "H-bond acceptors"], ["rotb", "Rotatable bonds"], ["heavy", "Heavy atoms"]
  ];
  const descCells = {};
  for (const [key, name] of DESC_ROWS) {
    const tr = el("tr");
    tr.appendChild(el("td", "", name));
    const td = el("td", "", "—");
    tr.appendChild(td);
    table.appendChild(tr);
    descCells[key] = td;
  }
  readout.appendChild(table);

  const flags = el("div", "lens-flags");
  flags.appendChild(el("p", "lens-flags-title", TRIAGE_SENTENCE));
  const chipsWrap = el("div", "lens-chips");
  const chips = [];
  for (let i = 0; i < POOL_CHIPS; i++) {
    const c = el("span", "lens-chip", "");
    c.hidden = true;
    chipsWrap.appendChild(c);
    chips.push(c);
  }
  flags.appendChild(chipsWrap);
  const noFlags = el("p", "lens-noflags", NO_FLAGS);
  noFlags.hidden = true;
  flags.appendChild(noFlags);
  readout.appendChild(flags);
  host.appendChild(readout);

  const foot = el("div", "lens-foot");
  const stateLine = el("p", "lens-state", EMPTY_LINE);
  const caption = el("p", "lens-caption", "");
  const nextBtn = el("button", "lens-next", "Next");
  nextBtn.type = "button";
  nextBtn.hidden = true;
  nextBtn.addEventListener("click", () => { stepShortlist(); });
  foot.appendChild(stateLine);
  foot.appendChild(caption);
  foot.appendChild(nextBtn);
  host.appendChild(foot);

  /* ————— state ————— */
  const st = {
    running: false,
    locked: false,        // a specimen is on stage and its 2,200 ms have not elapsed
    quiet: true,          // the timeline is past everything that moves (a perf probe samples on this)
    pending: null,        // the latest spotlight that arrived while locked
    current: null,        // what is on stage
    hits: [],
    hitIndex: -1,
    builds: 0,
    timers: [],
    destroyed: false
  };

  function later(fn, ms) {
    const t = setTimeout(() => { st.timers = st.timers.filter((x) => x !== t); if (!st.destroyed) fn(); }, ms);
    st.timers.push(t);
    return t;
  }
  function clearTimers() {
    for (const t of st.timers) clearTimeout(t);
    st.timers = [];
  }
  /* paint with every transition and flip switched off: the bars land, the
   * LED prints, nothing plays. The class stays on until the LED's own flip
   * window has passed, so removing it can never start the flip late. */
  function instantly(fn) {
    host.classList.add("is-instant");
    fn();
    void host.getBoundingClientRect();
    later(() => { host.classList.remove("is-instant"); }, FLIP_MS + 60);
  }
  /* Stop while a build is in flight: HOLD means nothing moves, so the
   * timeline is cut short — the drawing lands in its final state and the
   * readout prints at once, with no settle, no flip and no bar transition
   * left to play under "Nothing is running". */
  function settleNow() {
    if (!st.locked) return;
    clearTimers();
    endBuild();
    mol.classList.remove("is-settle");
    if (st.current) instantly(() => { paintReadout(st.current); });
    st.locked = false;
    st.quiet = true;
    st.pending = null;
  }
  /* the word for what is on stage; the coloured state always carries it */
  function stageMode() {
    if (!st.current) return "IDLE";
    return st.current.source === "shortlist" ? "SHORTLIST" : "LIVE";
  }

  /* ————— painting the molecule into the pool ————— */

  function clearPool() {
    for (const p of bondPool) p.setAttribute("hidden", "");
    for (const p of offsetPool) p.setAttribute("hidden", "");
    for (const p of circlePool) p.setAttribute("hidden", "");
    for (const p of labelPool) p.setAttribute("hidden", "");
  }
  function place(node, wave) {
    const g = waves[Math.max(0, Math.min(POOL_WAVES - 1, wave | 0))];
    if (node.parentNode !== g) g.appendChild(node);
    node.removeAttribute("hidden");
  }
  function paintLayout(lay) {
    clearPool();
    let offsets = 0;
    let closures = 0, lastClosureDelay = -Infinity;
    for (let k = 0; k < lay.bonds.length && k < POOL_BONDS; k++) {
      const b = lay.bonds[k];
      const p = bondPool[k];
      let d = "M" + b.x1 + " " + b.y1 + " L" + b.x2 + " " + b.y2;
      for (const o of b.offsets) {
        if (offsets < POOL_OFFSETS) {
          const ln = offsetPool[offsets++];
          ln.setAttribute("x1", String(o.x1)); ln.setAttribute("y1", String(o.y1));
          ln.setAttribute("x2", String(o.x2)); ln.setAttribute("y2", String(o.y2));
          place(ln, b.wave);
        } else {
          d += " M" + o.x1 + " " + o.y1 + " L" + o.x2 + " " + o.y2;   // overflow rides the bond path
        }
      }
      p.setAttribute("d", d);
      if (b.closure && closures < MAX_CLOSURES) {
        /* stagger closures so that no more than two ever draw at once */
        let delay = b.wave * WAVE_STEP_MS;
        if (delay < lastClosureDelay + WAVE_STEP_MS) delay = lastClosureDelay + WAVE_STEP_MS;
        lastClosureDelay = delay;
        closures++;
        p.setAttribute("class", "mol-bond mol-close");
        p.setAttribute("pathLength", "1");
        p.style.setProperty("--cd", String(delay));
      } else {
        p.setAttribute("class", "mol-bond");
        p.removeAttribute("pathLength");
        p.style.removeProperty("--cd");
      }
      place(p, b.wave);
    }
    for (let i = 0; i < lay.aromRings.length && i < POOL_CIRCLES; i++) {
      const r = lay.aromRings[i];
      const c = circlePool[i];
      c.setAttribute("cx", String(r.cx)); c.setAttribute("cy", String(r.cy)); c.setAttribute("r", String(r.r));
      place(c, r.wave);
    }
    /* labels last, so they paint above the bonds in every wave group */
    let li = 0;
    for (const a of lay.atoms) {
      if (!a.label || li >= POOL_LABELS) continue;
      const t = labelPool[li++];
      t.setAttribute("x", String(a.x)); t.setAttribute("y", String(a.y));
      t.setAttribute("class", "mol-label mol-" + a.cls);
      t.textContent = a.label;
      const g = waves[Math.max(0, Math.min(POOL_WAVES - 1, a.wave | 0))];
      g.appendChild(t);                       // always to the end of its group
      t.removeAttribute("hidden");
    }
    return { closures, offsetsOverflowed: Math.max(0, offsets - POOL_OFFSETS) };
  }

  function startBuild() {
    mol.classList.remove("is-settle");
    mol.classList.remove("is-building");
    void svg.getBoundingClientRect();        // restart the wave keyframes
    for (const g of waves) g.style.willChange = "transform, opacity";
    mol.classList.add("is-building");
    st.builds++;
  }
  function endBuild() {
    /* the natural state IS the final state, so removing the class leaves the
     * drawing exactly where the animation ended and lets getAnimations()
     * drop the finished animations */
    mol.classList.remove("is-building");
    for (const g of waves) g.style.willChange = "";
  }

  /* ————— the readout ————— */

  function paintBars(perTarget) {
    let shown = 0;
    if (Array.isArray(perTarget)) {
      for (const t of perTarget) {
        if (shown >= POOL_BARS || !t || typeof t !== "object") continue;
        const sim = isInt(t.sim) ? Math.max(0, Math.min(1000, t.sim)) : 0;
        const id = safeStr(String(t.target === undefined ? "" : t.target), 40);
        const b = bars[shown++];
        b.label.textContent = (TARGET_NAME.get(id) || id || "unknown target") + " · " + sim + " per mille";
        b.val.textContent = String(sim);
        b.fill.style.transform = "scaleX(" + (sim / 1000) + ")";
        b.row.hidden = false;
      }
    }
    for (let i = shown; i < POOL_BARS; i++) { bars[i].row.hidden = true; bars[i].fill.style.transform = "scaleX(0)"; }
    return shown;
  }
  function paintDesc(d, formula) {
    const fmt = (v, dp) => (typeof v === "number" && Number.isFinite(v) ? (dp ? v.toFixed(dp) : String(v)) : "—");
    descCells.formula.textContent = safeStr(formula, 60) || "—";
    descCells.mw.textContent = d ? fmt(d.mw, 2) : "—";
    descCells.clogp.textContent = d ? fmt(d.clogp, 2) : "—";
    descCells.tpsa.textContent = d ? fmt(d.tpsa, 2) : "—";
    descCells.hbd.textContent = d ? fmt(d.hbd) : "—";
    descCells.hba.textContent = d ? fmt(d.hba) : "—";
    descCells.rotb.textContent = d ? fmt(d.rotb) : "—";
    descCells.heavy.textContent = d ? fmt(d.heavy) : "—";
  }
  function paintChips(list, reported) {
    let shown = 0;
    if (Array.isArray(list)) {
      for (const f of list) {
        if (shown >= POOL_CHIPS) break;
        const name = safeStr(typeof f === "string" ? f : "", 32);
        if (!name) continue;
        chips[shown].textContent = "⚠ " + name;
        chips[shown].hidden = false;
        shown++;
      }
    }
    for (let i = shown; i < POOL_CHIPS; i++) chips[i].hidden = true;
    if (shown) { noFlags.hidden = true; return; }
    /* zero flags is a claim; it is printed only when the flags were actually
     * reported — and never as a tick */
    noFlags.textContent = reported ? NO_FLAGS : FLAGS_NOT_REPORTED;
    noFlags.hidden = false;
  }
  function paintReadout(spec) {
    const r = spec.result;
    const score = r && isInt(r.score) ? Math.max(0, Math.min(1000, r.score)) : 0;
    led.set(String(score));
    const worth = score >= WORTH_A_LOOK;
    scoreRow.classList.toggle("is-amber", worth);
    worthEl.hidden = !worth;
    const bestId = r && typeof r.best === "string" ? safeStr(r.best, 40) : "";
    bestRow.textContent = bestId
      ? "closest reference set: " + (TARGET_NAME.get(bestId) || bestId) +
        (r && typeof r.bestActive === "string" ? " (" + safeStr(r.bestActive, 40) + ")" : "") +
        (r && isInt(r.bestSim) ? " · " + r.bestSim + " per mille" : "")
      : (r && r.ok === false ? "no reference comparison — the molecule did not parse" : "closest reference set: —");
    const barsShown = paintBars(r && r.ok ? r.perTarget : null);
    barsNote.hidden = !(spec.source === "shortlist" && barsShown === 0);
    paintDesc(spec.desc || (r && r.desc) || null, r && typeof r.formula === "string" ? r.formula : "");
    if (r && r.ok) {
      const all = [];
      if (Array.isArray(r.flags)) all.push(...r.flags);
      if (Array.isArray(r.alerts)) all.push(...r.alerts);
      paintChips(all, r.flagsReported !== false);
    } else {
      paintChips(Array.isArray(r && r.flags) ? r.flags : ["unparseable"], true);
    }
  }

  /* ————— one specimen, start to finish ————— */

  function show(spec, instant) {
    clearTimers();
    st.current = spec;
    st.locked = !instant;
    st.pending = null;
    const r = spec.result;
    const parsed = !!(r && r.ok === true);
    const smiles = typeof spec.smiles === "string" ? spec.smiles.slice(0, SMILES_MAX) : "";

    /* arrive (0–120 ms): the header prints the identity */
    tag.textContent = spec.cid ? "CID " + spec.cid : (parsed && r.formula ? safeStr(r.formula, 40) : "specimen");
    unitEl.textContent = spec.source === "shortlist"
      ? "public shortlist · " + (st.hitIndex + 1) + " of " + st.hits.length
      : (spec.unitId ? "unit " + spec.unitId.slice(0, 12) + (isInt(spec.index) ? " · molecule " + (spec.index + 1) : "") : "");
    setMode(spec.source === "shortlist" ? "SHORTLIST" : "LIVE");
    stage.classList.remove("is-hold");
    stamp.hidden = true;
    if (onDraw && spec.source !== "shortlist" && !instant) { try { onDraw(spec); } catch (_) {} }

    /* build (120–970 ms) */
    let lay = null;
    if (parsed || !r) lay = viewLayoutMolecule(smiles);
    if (!parsed && r) {
      clearPool();
      svg.classList.add("is-blank");
      fail.textContent = UNPARSEABLE;
      fail.className = "lens-fail lens-fail-unparsed";
      fail.hidden = false;
      title.textContent = "This molecule did not parse; it was scored as unparseable, score 0.";
      desc.textContent = "Nothing is drawn.";
    } else if (!lay || lay.approximate) {
      clearPool();
      svg.classList.add("is-blank");
      fail.textContent = REFUSED;
      fail.className = "lens-fail";
      fail.hidden = false;
      title.textContent = "The drawing was refused; the score beside it is real.";
      desc.textContent = "This molecule is larger than the lens draws, or its coordinates did not resolve.";
    } else {
      fail.hidden = true;
      svg.classList.remove("is-blank");
      paintLayout(lay);
      const score = r && isInt(r.score) ? r.score : 0;
      const bestId = r && typeof r.best === "string" ? r.best : "";
      title.textContent = (r && r.formula ? safeStr(r.formula, 40) : "molecule") + " — score " + score + " of 1000";
      desc.textContent = "Best target: " + (bestId ? (TARGET_NAME.get(bestId) || safeStr(bestId, 40)) : "none") +
        ". " + lay.counts.atoms + " atoms, " + lay.counts.bonds + " bonds, " + lay.counts.rings + " rings.";
    }
    if (instant) {
      /* a re-mount restoring what was already on stage: no build, no timers,
       * no transition — it was already there */
      endBuild();
      instantly(() => { paintReadout(spec); });
    } else {
      startBuild();
      /* settle (970–1,150) → readout (1,150–1,600) → release (2,200) */
      later(() => { mol.classList.add("is-settle"); }, SETTLE_AT);
      later(() => { mol.classList.remove("is-settle"); paintReadout(spec); }, READOUT_AT);
      later(() => { endBuild(); }, DONE_AT);
      st.quiet = false;
      later(() => { st.quiet = true; }, QUIET_AT);
      later(() => {
        st.locked = false;
        if (st.pending) { const p = st.pending; st.pending = null; accept(p); }
      }, BUILD_MS);
      if (spec.source !== "shortlist") { session.drewLive = true; session.last = spec; session.shown++; }
    }
    paintCaption();
  }

  function setMode(word) {
    mode.textContent = word;
    mode.classList.toggle("is-live", word === "LIVE");
    mode.classList.toggle("is-hold", word === "HOLD");
  }

  /* a spotlight from the client: shaped, then rate-limited */
  /* a spotlight is data from a worker, so it is read defensively: a value
   * that cannot be stringified is simply absent, never a throw */
  function shapeSpotlight(ev) {
    try {
      if (!ev || typeof ev !== "object") return null;
      const r = ev.result && typeof ev.result === "object" ? ev.result : null;
      if (!r) return null;
      let unitId = "", cid = "";
      try { unitId = typeof ev.unitId === "string" ? ev.unitId : String(ev.unitId === undefined || ev.unitId === null ? "" : ev.unitId); } catch (_) { unitId = ""; }
      try { cid = String(ev.cid === undefined || ev.cid === null ? "" : ev.cid); } catch (_) { cid = ""; }
      return {
        source: "unit",
        unitId: safeStr(unitId, 24),
        index: isInt(ev.index) ? ev.index : null,
        cid: /^[0-9]{1,12}$/.test(cid) ? cid : "",
        smiles: typeof ev.smiles === "string" ? ev.smiles : "",
        result: r
      };
    } catch (_) {
      return null;
    }
  }
  function accept(spec) {
    session.offered++;
    if (st.locked) { if (st.pending) session.dropped++; st.pending = spec; return false; }
    show(spec);
    return true;
  }

  /* ————— the caption: live numbers, never a fixed ratio ————— */

  function screened() { return session.base + session.cur; }
  function paintCaption() {
    const shown = session.shown, scr = screened();
    let text = CAPTION_HEAD + " Shown here this session: " + groupInt(shown) +
      " · screened by this browser this session: " + groupInt(scr);
    /* the ratio is printed only when it is true: at least one shown, and at
     * least as many screened as shown (a forced QA stream can invert that) */
    if (shown > 0 && scr >= shown) text += " — one in " + groupInt(Math.round(scr / shown)) + ".";
    else text += ".";
    caption.textContent = text;
    if (onCaption) { try { onCaption(text); } catch (_) {} }
  }

  /* ————— idle: HOLD, or a specimen from the public shortlist ————— */

  function paintIdle() {
    if (st.running) return;
    if (session.drewLive) {
      if (!st.current && session.last) show(session.last, true);
      stage.classList.add("is-hold");
      setMode("HOLD");
      stateLine.textContent = HOLD_LINE;
      nextBtn.hidden = true;
      return;
    }
    if (st.hits.length) {
      if (st.hitIndex < 0) stepShortlist();
      stateLine.textContent = SHORTLIST_LINE;
      nextBtn.hidden = st.hits.length < 2;
      return;
    }
    setMode("IDLE");
    stateLine.textContent = EMPTY_LINE;
    nextBtn.hidden = true;
  }

  function shortlistSpec(h) {
    const smiles = typeof h.smiles === "string" ? h.smiles : "";
    const parsedMol = smiles ? molFromSmiles(smiles) : null;
    const d = parsedMol ? descriptors(parsedMol) : null;
    const reported = typeof h.flags === "string";
    const flagList = reported && h.flags ? h.flags.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return {
      source: "shortlist",
      unitId: "",
      index: null,
      cid: /^[0-9]{1,12}$/.test(String(h.cid || "")) ? String(h.cid) : "",
      smiles,
      desc: d,
      result: {
        ok: !!parsedMol,
        score: isInt(h.score) ? h.score : 0,
        best: typeof h.target === "string" ? h.target : null,
        formula: typeof h.formula === "string" ? h.formula : "",
        flags: flagList,
        flagsReported: reported,
        perTarget: null
      }
    };
  }
  function stepShortlist() {
    if (st.running || !st.hits.length) return;
    st.hitIndex = (st.hitIndex + 1) % st.hits.length;
    show(shortlistSpec(st.hits[st.hitIndex]));
    stateLine.textContent = SHORTLIST_LINE;
    nextBtn.hidden = st.hits.length < 2;
  }

  /* ————— the public surface ————— */

  const api = {
    host,
    /* every event the swarm client emits can be handed here; only these matter */
    onEvent(ev) {
      try {
        if (!ev || typeof ev.type !== "string") return;
        if (ev.type === "unit") {
          session.base += session.cur;
          session.cur = 0;
          st.running = true;
          stage.classList.remove("is-hold");
          setMode(stageMode());
          nextBtn.hidden = true;
          if (stateLine.textContent !== SCREENING_LINE) stateLine.textContent = FIRST_LINE;
          paintCaption();
        } else if (ev.type === "progress") {
          if (isInt(ev.done) && ev.done >= 0) session.cur = Math.min(ev.done, isInt(ev.total) ? ev.total : ev.done);
          paintCaption();
        } else if (ev.type === "submitted") {
          session.base += session.cur;
          session.cur = 0;
          paintCaption();
        } else if (ev.type === "spotlight") {
          /* a spotlight for a unit that was in flight when Stop was pressed
           * arrives after the stop — HOLD means hold, so it is ignored */
          if (!st.running) return;
          const spec = shapeSpotlight(ev);
          if (spec) { stateLine.textContent = SCREENING_LINE; accept(spec); }
        } else if (ev.type === "stopped" || ev.type === "left") {
          session.base += session.cur;
          session.cur = 0;
          st.running = false;
          st.pending = null;
          settleNow();
          paintCaption();
          paintIdle();
        }
      } catch (_) { /* the UI's problem, never the swarm's */ }
    },
    /* the Lab's own notion of running (it knows about the join and the
     * charging gate before any unit event arrives) */
    setRunning(on) {
      const was = st.running;
      st.running = on === true;
      if (st.running) {
        /* a re-mount mid-run restores the last specimen undimmed, so the
         * mode word must follow the stage — never a HOLD left over from the
         * idle paint at construction */
        stage.classList.remove("is-hold");
        setMode(stageMode());
        nextBtn.hidden = true;
        if (!was) stateLine.textContent = FIRST_LINE;
      } else if (was) {
        settleNow();
        paintIdle();
      }
    },
    /* the already-fetched ?a=hits, for the pre-run specimen; a refresh never
     * steps the specimen — only a Next press does */
    setHits(list) {
      const kept = [];
      if (Array.isArray(list)) {
        for (const h of list) {
          if (!h || typeof h !== "object" || typeof h.smiles !== "string" || !h.smiles) continue;
          kept.push(h);
          if (kept.length >= 50) break;
        }
      }
      st.hits = kept;
      if (st.hitIndex >= kept.length) st.hitIndex = kept.length ? 0 : -1;
      if (!st.running) paintIdle();
    },
    next() { stepShortlist(); },
    /* a spotlight handed in directly (the same shape the client emits) */
    push(ev) {
      try { const spec = shapeSpotlight(ev); return spec ? accept(spec) : false; } catch (_) { return false; }
    },
    /* the SECOND WITNESS stamp: shown only when the specimen on stage is from
     * that unit; returns false so the caller can relocate it to the console */
    stamp(unitId) {
      const id = typeof unitId === "string" ? unitId : "";
      if (!id || !st.current || st.current.source !== "unit" || st.current.unitId !== id) { stamp.hidden = true; return false; }
      stamp.hidden = false;
      return true;
    },
    state() {
      return {
        running: st.running, locked: st.locked, quiet: st.quiet, pendingHeld: !!st.pending, drewLive: session.drewLive,
        mode: mode.textContent, hold: stage.classList.contains("is-hold"), builds: st.builds,
        hits: st.hits.length, hitIndex: st.hitIndex, failShown: !fail.hidden, failText: fail.hidden ? "" : fail.textContent,
        caption: caption.textContent, stateLine: stateLine.textContent, led: led.text(),
        worth: !worthEl.hidden, amber: scoreRow.classList.contains("is-amber"),
        barsShown: bars.filter((b) => !b.row.hidden).length, chipsShown: chips.filter((c) => !c.hidden).length,
        noFlags: noFlags.hidden ? "" : noFlags.textContent, title: title.textContent, desc: desc.textContent,
        nextVisible: !nextBtn.hidden, stampShown: !stamp.hidden,
        session: { shown: session.shown, screened: screened(), dropped: session.dropped, offered: session.offered },
        pool: { bonds: POOL_BONDS, offsets: POOL_OFFSETS, labels: POOL_LABELS, circles: POOL_CIRCLES, waves: POOL_WAVES }
      };
    },
    destroy() {
      st.destroyed = true;
      clearTimers();
    }
  };

  paintCaption();
  paintIdle();

  /* QA hook — a test surface only: it drives the drawing, never the swarm */
  try {
    if (typeof window !== "undefined") {
      window.__losLens = {
        api,
        svg,
        force(ev) { try { const spec = shapeSpotlight(ev); if (!spec) return false; show(spec); return true; } catch (_) { return false; } },
        showShortlist(h) { show(shortlistSpec(h)); return true; },
        constants: { BUILD_MS, SETTLE_AT, READOUT_AT, DONE_AT, QUIET_AT, WORTH_A_LOOK, TRIAGE_SENTENCE, NO_FLAGS, REFUSED, UNPARSEABLE, CAPTION_HEAD, HOLD_LINE, SHORTLIST_LINE }
      };
    }
  } catch (_) {}

  return api;
}
