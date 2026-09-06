/* led — seven-segment readouts and LED bars for the console (4.0).
 *
 * ONE SYMBOL, MANY DIGITS. A single <symbol id="seg7"> holds the seven
 * polygons and the separator point; every digit is a <use> of it whose seven
 * segments are lit through CSS custom properties (--a … --g, --p) set on the
 * <use>. Custom properties inherit into the use-shadow tree; attribute
 * selectors do not reach in there, which is why the wiring is properties and
 * not classes. Unlit segments are always drawn (dim), like a real display.
 *
 * NO COUNT-UP, EVER. A readout rolls from the old number to the new one in
 * one step: paintLed diffs per character, rewrites only the digits that
 * changed, and gives each changed digit a 180ms .flip. Server numbers change
 * only when a poll lands; nothing here tweens a value the server never sent.
 *
 * THE TEXT TWIN. Every <svg class="led" aria-hidden="true"> is immediately
 * followed by a visible <span class="led-text"> carrying the identical text —
 * the accessible reading, the screenshot-greppable reading, and what
 * qa/strip.mjs asserts equals the display. viewLedText(host) reads it.
 *
 * createElement / createElementNS + textContent only. */

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";

/* bit 6..0 = a b c d e f g */
export const SEG = Object.freeze([
  0b1111110, // 0
  0b0110000, // 1
  0b1101101, // 2
  0b1111001, // 3
  0b0110011, // 4
  0b1011011, // 5
  0b1011111, // 6
  0b1110000, // 7
  0b1111111, // 8
  0b1111011  // 9
]);
const SEG_DASH = 0b0000001;   // g only
const SEG_BLANK = 0;
const PROPS = ["--a", "--b", "--c", "--d", "--e", "--f", "--g"];
const CELL_W = 26;            // 24 wide glyph + 2 gap
const CELL_H = 44;
const MAX_DIGITS = 8;
const FLIP_MS = 180;

/* the polygons: top bar as the spec gives it, the rest by symmetry */
const POLYGONS = [
  ["sa", "5,2 19,2 16,5 8,5"],
  ["sb", "22,3 22,19.5 20.5,21 19,19.5 19,6"],
  ["sc", "22,24.5 20.5,23 19,24.5 19,38 22,41"],
  ["sd", "8,39 16,39 19,42 5,42"],
  ["se", "2,24.5 3.5,23 5,24.5 5,38 2,41"],
  ["sf", "2,3 5,6 5,19.5 3.5,21 2,19.5"],
  ["sg", "8,20.5 16,20.5 18,22 16,23.5 8,23.5 6,22"]
];

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG, tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  return n;
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/* The symbol is defined once per document, in a zero-sized svg on the body. */
function ensureDefs() {
  if (typeof document === "undefined") return;
  if (document.getElementById("seg7")) return;
  const defs = svgEl("svg", { class: "led-defs", width: "0", height: "0", "aria-hidden": "true", focusable: "false" });
  const sym = svgEl("symbol", { id: "seg7", viewBox: "0 0 24 44" });
  for (const [cls, points] of POLYGONS) sym.appendChild(svgEl("polygon", { class: cls, points }));
  sym.appendChild(svgEl("rect", { class: "sp", x: "21.5", y: "41.5", width: "2.5", height: "2.5", rx: ".6" }));
  defs.appendChild(sym);
  const body = document.body || document.documentElement;
  body.insertBefore(defs, body.firstChild);
}

/* A display string → cells. Digits, "-" and " " take a cell; a "," or "."
 * lights the separator point of the cell before it. Anything else is a
 * blank cell — an LED shows what it can show, and the text twin shows the
 * rest. The result is right-aligned into `digits` cells. */
function cellsOf(text, digits) {
  const cells = [];
  const s = String(text === undefined || text === null ? "" : text);
  for (let i = 0; i < s.length && cells.length <= MAX_DIGITS * 2; i++) {
    const ch = s[i];
    if (ch >= "0" && ch <= "9") cells.push({ seg: SEG[ch.charCodeAt(0) - 48], point: 0 });
    else if (ch === "-") cells.push({ seg: SEG_DASH, point: 0 });
    else if (ch === "," || ch === ".") { if (cells.length) cells[cells.length - 1].point = 1; }
    else cells.push({ seg: SEG_BLANK, point: 0 });
  }
  const n = digits;
  if (cells.length > n) return cells.slice(cells.length - n);
  while (cells.length < n) cells.unshift({ seg: SEG_BLANK, point: 0 });
  return cells;
}

function applyCell(use, cell) {
  for (let b = 0; b < 7; b++) use.style.setProperty(PROPS[b], (cell.seg >> (6 - b)) & 1 ? "1" : "0");
  use.style.setProperty("--p", cell.point ? "1" : "0");
  use.setAttribute("data-seg", String(cell.seg) + (cell.point ? "." : ""));
}

function flip(use) {
  /* a digit changing twice inside one flip restarts the flip rather than
   * queueing a second one */
  try { if (typeof use.getAnimations === "function") for (const a of use.getAnimations()) a.cancel(); } catch (_) {}
  use.classList.remove("flip");
  use.classList.add("flip");
  const off = () => { use.classList.remove("flip"); };
  try { use.addEventListener("animationend", off, { once: true }); } catch (_) {}
  setTimeout(off, FLIP_MS + 60);
}

/* Diff and repaint one display. Returns the number of digits that changed. */
function paintLed(svg, text) {
  const uses = svg.__uses;
  const cells = cellsOf(text, uses.length);
  let changed = 0;
  for (let i = 0; i < uses.length; i++) {
    const use = uses[i];
    const key = String(cells[i].seg) + (cells[i].point ? "." : "");
    if (use.getAttribute("data-seg") === key) continue;
    applyCell(use, cells[i]);
    if (svg.__painted) flip(use);
    changed++;
  }
  svg.__painted = true;
  return changed;
}

function buildSvg(digits) {
  const svg = svgEl("svg", {
    class: "led",
    viewBox: "0 0 " + (digits * CELL_W) + " " + CELL_H,
    "aria-hidden": "true",
    focusable: "false"
  });
  const uses = [];
  for (let i = 0; i < digits; i++) {
    const use = svgEl("use", { x: String(i * CELL_W), y: "0", width: "24", height: String(CELL_H) });
    use.setAttribute("href", "#seg7");
    try { use.setAttributeNS(XLINK, "xlink:href", "#seg7"); } catch (_) {}
    svg.appendChild(use);
    uses.push(use);
  }
  svg.__uses = uses;
  svg.__painted = false;
  return svg;
}

/* viewLed(host, {label, digits, text}) → { el, set(text), text(), setTone(tone) }
 * A labelled seven-segment readout. `text` is what the display AND the twin
 * show; the caller formats it (grouped integers, "—" for unknown). */
export function viewLed(host, options) {
  const opts = options && typeof options === "object" ? options : {};
  const digits = Math.max(1, Math.min(MAX_DIGITS, Math.trunc(Number(opts.digits)) || 6));
  ensureDefs();
  const wrap = el("div", "instr instr-led");
  if (opts.label !== undefined) wrap.appendChild(el("span", "instr-label", String(opts.label)));
  const svg = buildSvg(digits);
  wrap.appendChild(svg);
  const twin = el("span", "led-text");
  wrap.appendChild(twin);
  const handle = {
    el: wrap,
    set(text) {
      const s = String(text === undefined || text === null ? "" : text);
      twin.textContent = s;
      return paintLed(svg, s);
    },
    text() { return twin.textContent; },
    /* "amber" is attention; anything else is the phosphor default */
    setTone(tone) { wrap.classList.toggle("instr-led-amber", tone === "amber"); }
  };
  handle.set(opts.text === undefined ? "" : opts.text);
  if (host && typeof host.appendChild === "function") host.appendChild(wrap);
  return handle;
}

/* viewLedBar(host, {label, value01, text, tone}) → { el, set(value01, text) }
 * A segmented bar: a track, a fill scaled on X (transform only — never
 * width), the label before it and the value text after it. */
export function viewLedBar(host, options) {
  const opts = options && typeof options === "object" ? options : {};
  const wrap = el("div", "instr instr-bar");
  if (opts.label !== undefined) wrap.appendChild(el("span", "instr-label", String(opts.label)));
  const track = el("div", "led-bar");
  const fill = el("i");
  track.appendChild(fill);
  wrap.appendChild(track);
  const value = el("span", "instr-value");
  wrap.appendChild(value);
  const clamp = (v) => { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };
  const handle = {
    el: wrap,
    set(value01, text) {
      const v = clamp(value01);
      fill.style.transform = "scaleX(" + v.toFixed(4) + ")";
      track.setAttribute("data-value", v.toFixed(4));
      if (text !== undefined) value.textContent = String(text);
      return v;
    },
    setTone(tone) {
      wrap.classList.toggle("instr-bar-amber", tone === "amber");
      wrap.classList.toggle("instr-bar-trace", tone === "trace");
    }
  };
  handle.set(opts.value01 === undefined ? 0 : opts.value01, opts.text === undefined ? "" : opts.text);
  if (opts.tone) handle.setTone(opts.tone);
  if (host && typeof host.appendChild === "function") host.appendChild(wrap);
  return handle;
}

/* Off-screen panels do not animate: one shared IntersectionObserver adds
 * .is-parked (animation-play-state: paused, in observatory.css) to a panel
 * that has scrolled out of view and removes it when it comes back. A
 * browser without the observer simply never parks — nothing depends on it. */
let parker = null;
export function viewPark(el) {
  if (!el || typeof el !== "object" || typeof IntersectionObserver !== "function") return false;
  try {
    if (!parker) {
      parker = new IntersectionObserver((entries) => {
        for (const e of entries) e.target.classList.toggle("is-parked", !e.isIntersecting);
      }, { rootMargin: "80px" });
    }
    parker.observe(el);
    return true;
  } catch (_) { return false; }
}

/* The twin's text, for QA: the reading the display must equal. `host` may be
 * the readout wrapper or any ancestor of exactly one readout. */
export function viewLedText(host) {
  if (!host || typeof host.querySelector !== "function") return "";
  const twin = host.classList && host.classList.contains("led-text") ? host : host.querySelector(".led-text");
  return twin ? twin.textContent : "";
}

/* What a readout's segments say, decoded back to text — QA cross-checks this
 * against the twin so a display can never disagree with its caption. */
export function viewLedDecode(host) {
  if (!host || typeof host.querySelectorAll !== "function") return "";
  let out = "";
  for (const use of host.querySelectorAll(".led use")) {
    const key = use.getAttribute("data-seg") || "0";
    const point = key.endsWith(".");
    const seg = Number(point ? key.slice(0, -1) : key);
    let ch = " ";
    if (seg === SEG_DASH) ch = "-";
    else if (seg !== SEG_BLANK) { const i = SEG.indexOf(seg); ch = i >= 0 ? String(i) : " "; }
    out += ch + (point ? "," : "");
  }
  return out.trim();
}
