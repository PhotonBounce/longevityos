/* charts — pure SVG figure builders for the Observatory (4.0).
 *
 * Every builder is viewChart<Kind>(host, data, opts) and renders, inside
 * `host`, ONE <figure data-chart=kind> made of: a <figcaption> carrying the
 * figure number, its instrument title and a one-line headline; a well holding
 * the SVG (or the empty-state sentence when there is nothing to draw); an
 * optional note; and a "Read the numbers" <details open> table that carries
 * every number the drawing was made from. Every SVG mark carries a <title>;
 * every LED-bar track carries a title attribute.
 *
 * REDRAW ONLY WHEN THE DATA CHANGES. Each builder digests the sanitised data
 * and the copy it will print; when the figure already on the page carries the
 * same digest the builder returns it untouched — not one DOM mutation. When
 * it differs the figure is rebuilt in place (same element, new children), so
 * nothing on the page ever tweens between two server numbers.
 *
 * NOTHING HERE TRUSTS ITS INPUT. Numbers are accepted only as finite JS
 * numbers and floored to non-negative integers; strings are cut to length
 * with control and bidi characters removed; arrays are capped. Server text is
 * written with textContent only — createElement / createElementNS, never a
 * markup sink. A builder given garbage draws its empty state; it never throws.
 *
 * Colour never carries a meaning alone: every tone has its word in the legend
 * and in the table. phosphor = this browser, trace = the server, amber =
 * attention, rose = conflict or null, violet = the reference set.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const TEXT_MAX = 96;
const ROWS_MAX = 96;
const TONES = { phosphor: 1, trace: 1, amber: 1, rose: 1, violet: 1, dim: 1 };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** An SVG element with attributes; a `title` key becomes a <title> child. */
function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      if (k === "title") {
        const t = document.createElementNS(SVG_NS, "title");
        t.textContent = viewChartText(attrs[k], 160);
        n.appendChild(t);
      } else if (attrs[k] !== undefined && attrs[k] !== null) {
        n.setAttribute(k, String(attrs[k]));
      }
    }
  }
  return n;
}

/* ————— sanitisers (exported: observatory.js uses the same ones) ————— */

/** A finite, non-negative integer, or 0. Numbers only — a string is not a count. */
export function viewChartInt(v, cap) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const i = Math.floor(v);
  if (i < 0) return 0;
  return cap !== undefined && i > cap ? cap : i;
}

/** Printable text, cut to `max`, with control and bidi characters removed. */
export function viewChartText(v, max) {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return "";
  const lim = typeof max === "number" && max > 0 ? max : TEXT_MAX;
  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0);
    if (c < 32 || (c >= 0x7f && c <= 0x9f)) continue;
    if (c >= 0x200b && c <= 0x200f) continue;      // zero-width + bidi marks
    if (c >= 0x202a && c <= 0x202e) continue;      // bidi embeddings
    if (c >= 0x2066 && c <= 0x2069) continue;      // bidi isolates
    if (c === 0xfeff) continue;
    out += ch;
    if (out.length >= lim) break;
  }
  return out;
}

/** An array of viewChartInt, capped in length; anything else is []. */
export function viewChartInts(arr, cap, each) {
  if (!Array.isArray(arr)) return [];
  const n = typeof cap === "number" && cap > 0 ? Math.min(cap, arr.length) : arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = viewChartInt(arr[i], each);
  return out;
}

/** 1234567 → "1,234,567" without touching the locale. */
export function viewChartNum(n) {
  const i = viewChartInt(n);
  return String(i).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A stable digest of the data a figure is about to draw. */
export function viewChartDigest(parts) {
  let s = "";
  try { s = JSON.stringify(parts); } catch (_) { s = String(Date.now()); }
  /* FNV-1a over the string: short, deterministic, cheap */
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return s.length + ":" + h.toString(16);
}

const tone = (t) => (typeof t === "string" && TONES[t] ? t : "trace");

/* ————— the frame every figure shares ————— */

function findFigure(host, kind) {
  const kids = host.children;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.tagName === "FIGURE" && c.getAttribute("data-chart") === kind) return c;
  }
  return null;
}

function table(opts) {
  const det = el("details", "obs-numbers");
  det.open = true;
  det.setAttribute("open", "");
  det.appendChild(el("summary", "obs-numbers-sum", "Read the numbers"));
  const t = el("table", "obs-table");
  const head = Array.isArray(opts.tableHead) ? opts.tableHead.slice(0, 8) : null;
  if (head && head.length) {
    const thead = el("thead");
    const tr = el("tr");
    for (const h of head) tr.appendChild(el("th", "", viewChartText(h, 40)));
    thead.appendChild(tr);
    t.appendChild(thead);
  }
  const tbody = el("tbody");
  const rows = Array.isArray(opts.tableRows) ? opts.tableRows.slice(0, ROWS_MAX) : [];
  let printed = 0;
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const tr = el("tr");
    if (r.pinned === true) tr.className = "obs-row-pinned";
    const cells = r.slice(0, 8);
    cells.forEach((c, i) => tr.appendChild(el(i === 0 ? "th" : "td", i === 0 ? "obs-th" : "obs-td", viewChartText(c, 80))));
    tbody.appendChild(tr);
    printed++;
  }
  if (!printed) {
    const tr = el("tr");
    tr.appendChild(el("td", "obs-td obs-td-none", "no readings yet"));
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  det.appendChild(t);
  return det;
}

/**
 * Find-or-create the figure for `kind` inside `host`; return it untouched if
 * its digest matches, otherwise rebuild it in place. `draw(well, data)` fills
 * the well and may throw — the frame catches and prints an honest sentence.
 */
function frame(host, kind, data, opts, draw) {
  if (!host || typeof host.appendChild !== "function") return null;
  const o = opts && typeof opts === "object" ? opts : {};
  const digest = viewChartDigest([kind, data, o.n, o.title, o.caption, o.note, o.empty, o.tableHead, o.tableRows, o.tone]);
  let fig = findFigure(host, kind);
  if (fig && fig.getAttribute("data-digest") === digest) return fig;
  if (!fig) {
    fig = el("figure");
    fig.setAttribute("data-chart", kind);
    host.appendChild(fig);
  }
  fig.textContent = "";
  fig.setAttribute("data-digest", digest);
  fig.className = "obs-fig obs-fig-" + kind + (o.tone ? " obs-tone-" + tone(o.tone) : "");
  if (o.n !== undefined) fig.setAttribute("data-n", String(viewChartInt(o.n, 99)));

  const cap = el("figcaption", "obs-cap");
  /* the figure number is painted by CSS from data-n (a pseudo-element costs no DOM node) */
  if (o.n !== undefined) cap.setAttribute("data-n", String(viewChartInt(o.n, 99)));
  cap.appendChild(el("span", "obs-cap-title instr-label", viewChartText(o.title, 48) || kind.toUpperCase()));
  cap.appendChild(el("span", "obs-cap-headline", viewChartText(o.caption, 240)));
  fig.appendChild(cap);

  const well = el("div", "obs-well");
  fig.appendChild(well);
  try {
    draw(well, data);
  } catch (_) {
    well.textContent = "";
    well.appendChild(el("p", "obs-empty", "This figure could not be drawn from what the server sent; the numbers below are what arrived."));
  }
  if (o.note) fig.appendChild(el("p", "obs-note", viewChartText(o.note, 400)));
  fig.appendChild(table(o));
  return fig;
}

const empty = (well, text) => well.appendChild(el("p", "obs-empty", viewChartText(text, 200) || "Nothing to draw yet."));

/* ————— geometry helpers ————— */

const W = 320, H = 120, PAD_T = 10, PAD_B = 14;
const round2 = (v) => Math.round(v * 100) / 100;

function baseSvg(w, h, label) {
  const s = svg("svg", { viewBox: "0 0 " + w + " " + h, role: "img", class: "obs-svg", "aria-label": viewChartText(label, 120) });
  const t = document.createElementNS(SVG_NS, "title");
  t.textContent = viewChartText(label, 120);
  s.appendChild(t);
  return s;
}

/** The instrument well's graticule: two faint rules. Decoration, not marks:
 *  the group is aria-hidden and carries no titles. */
function graticule(s, w, h) {
  const g = svg("g", { class: "obs-grid", "aria-hidden": "true" });
  for (let i = 1; i <= 2; i++) {
    const y = round2(PAD_T + (h - PAD_T - PAD_B) * (i / 3));
    g.appendChild(svg("line", { x1: 0, x2: w, y1: y, y2: y }));
  }
  s.appendChild(g);
}

/* ————— 1. step area ————— */

/**
 * data: { values:[int…], partialLast:bool, labels:[text…] }
 * The area is ONE mark (one <title>); the in-progress last step is a second,
 * dashed one. Zero everywhere draws the baseline and the empty sentence.
 */
export function viewChartStepArea(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const values = viewChartInts(d.values, 96);
  const partial = d.partialLast === true;
  const shaped = { values, partial, unit: viewChartText(d.unit, 24) || "readings" };
  return frame(host, "steparea", shaped, opts, (well) => {
    const n = values.length;
    const total = values.reduce((a, b) => a + b, 0);
    const s = baseSvg(W, H, (opts && opts.title) + ": " + viewChartNum(total) + " " + shaped.unit + " over " + n + " steps");
    graticule(s, W, H);
    s.appendChild(svg("line", { class: "obs-baseline", x1: 0, x2: W, y1: H - PAD_B, y2: H - PAD_B, title: "baseline — zero" }));
    if (!n || !total) {
      well.appendChild(s);
      empty(well, opts && opts.empty);
      return;
    }
    const max = Math.max(1, ...values);
    const stepW = W / n;
    const y = (v) => round2(H - PAD_B - (v / max) * (H - PAD_B - PAD_T));
    const lastSolid = partial ? n - 1 : n;
    let path = "M0," + (H - PAD_B);
    for (let i = 0; i < lastSolid; i++) {
      const x0 = round2(i * stepW), x1 = round2((i + 1) * stepW);
      path += " L" + x0 + "," + y(values[i]) + " L" + x1 + "," + y(values[i]);
    }
    path += " L" + round2(lastSolid * stepW) + "," + (H - PAD_B) + " Z";
    s.appendChild(svg("path", {
      class: "obs-area obs-tone-trace", d: path,
      title: viewChartNum(total - (partial ? values[n - 1] : 0)) + " " + shaped.unit + " in " + lastSolid + " complete steps; peak " + viewChartNum(max)
    }));
    if (partial) {
      const x0 = round2((n - 1) * stepW), x1 = W;
      s.appendChild(svg("path", {
        class: "obs-area-partial obs-tone-trace",
        d: "M" + x0 + "," + (H - PAD_B) + " L" + x0 + "," + y(values[n - 1]) + " L" + x1 + "," + y(values[n - 1]) + " L" + x1 + "," + (H - PAD_B),
        title: "IN PROGRESS — " + viewChartNum(values[n - 1]) + " " + shaped.unit + " so far this step"
      }));
      const t = svg("text", { class: "obs-svg-label", x: W - 4, y: PAD_T + 8, "text-anchor": "end" });
      t.textContent = "IN PROGRESS";
      s.appendChild(t);
    }
    well.appendChild(s);
  });
}

/* ————— 2. bars ————— */

/**
 * data: { bars:[{label, value, partial, tone, title}] }
 * A zero bar is a 1-unit tick so an empty day is still a mark with a title;
 * a partial bar is outlined and labelled by `partialWord`.
 */
export function viewChartBars(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const src = Array.isArray(d.bars) ? d.bars.slice(0, 64) : [];
  const bars = src.map((b) => {
    const x = b && typeof b === "object" ? b : {};
    return { label: viewChartText(x.label, 32), value: viewChartInt(x.value), partial: x.partial === true, tone: tone(x.tone), title: viewChartText(x.title, 120) };
  });
  const shaped = { bars, partialWord: viewChartText(d.partialWord, 24) || "PARTIAL", unit: viewChartText(d.unit, 24) || "" };
  return frame(host, "bars", shaped, opts, (well) => {
    const n = bars.length;
    if (!n) { empty(well, opts && opts.empty); return; }
    const total = bars.reduce((a, b) => a + b.value, 0);
    const s = baseSvg(W, H, (opts && opts.title) + ": " + n + " bars, " + viewChartNum(total) + " " + shaped.unit);
    graticule(s, W, H);
    const max = Math.max(1, ...bars.map((b) => b.value));
    const gap = n > 24 ? 1 : 2;
    const bw = round2((W - gap * (n - 1)) / n);
    let anyPartial = false;
    bars.forEach((b, i) => {
      const h = b.value ? Math.max(1, round2((b.value / max) * (H - PAD_B - PAD_T))) : 1;
      const x = round2(i * (bw + gap));
      const cls = "obs-bar obs-tone-" + b.tone + (b.partial ? " obs-bar-partial" : "") + (b.value ? "" : " obs-bar-zero");
      s.appendChild(svg("rect", {
        class: cls, x, y: round2(H - PAD_B - h), width: bw, height: h,
        title: b.title || (b.label + " — " + viewChartNum(b.value) + (shaped.unit ? " " + shaped.unit : "") + (b.partial ? " (" + shaped.partialWord + ")" : ""))
      }));
      if (b.partial) anyPartial = true;
    });
    if (anyPartial) {
      const t = svg("text", { class: "obs-svg-label", x: W - 4, y: PAD_T + 8, "text-anchor": "end" });
      t.textContent = shaped.partialWord;
      s.appendChild(t);
    }
    if (!total) { well.appendChild(s); empty(well, opts && opts.empty); return; }
    well.appendChild(s);
  });
}

/* ————— 3. donut ————— */

/**
 * data: { slices:[{label, value, tone}], centre:{value, label} }
 * The legend prints each slice's word and count; colour is never alone.
 */
export function viewChartDonut(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const src = Array.isArray(d.slices) ? d.slices.slice(0, 8) : [];
  const slices = src.map((x) => {
    const o = x && typeof x === "object" ? x : {};
    return { label: viewChartText(o.label, 32), value: viewChartInt(o.value), tone: tone(o.tone) };
  });
  const centre = d.centre && typeof d.centre === "object"
    ? { value: viewChartInt(d.centre.value), label: viewChartText(d.centre.label, 24) } : null;
  const shaped = { slices, centre };
  return frame(host, "donut", shaped, opts, (well) => {
    const total = slices.reduce((a, b) => a + b.value, 0);
    if (!total) { empty(well, opts && opts.empty); return; }
    const row = el("div", "obs-donut-row");
    const size = 120, cx = 60, cy = 60, r = 46, rIn = 30;
    const s = baseSvg(size, size, (opts && opts.title) + ": " + viewChartNum(total) + " in " + slices.length + " states");
    let a0 = -Math.PI / 2;
    const pt = (a, rad) => [round2(cx + rad * Math.cos(a)), round2(cy + rad * Math.sin(a))];
    for (const sl of slices) {
      if (!sl.value) continue;
      const frac = sl.value / total;
      const a1 = frac >= 1 ? a0 + Math.PI * 2 - 0.0001 : a0 + frac * Math.PI * 2;
      const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r), [x2, y2] = pt(a1, rIn), [x3, y3] = pt(a0, rIn);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const path = "M" + x0 + "," + y0 + " A" + r + "," + r + " 0 " + large + " 1 " + x1 + "," + y1 +
        " L" + x2 + "," + y2 + " A" + rIn + "," + rIn + " 0 " + large + " 0 " + x3 + "," + y3 + " Z";
      s.appendChild(svg("path", { class: "obs-slice obs-tone-" + sl.tone, d: path,
        title: sl.label + " — " + viewChartNum(sl.value) + " (" + Math.round(frac * 100) + "%)" }));
      a0 = a1;
    }
    if (centre) {
      const tv = svg("text", { class: "obs-svg-big", x: cx, y: cy + 2, "text-anchor": "middle" });
      tv.textContent = viewChartNum(centre.value);
      s.appendChild(tv);
      const tl = svg("text", { class: "obs-svg-label", x: cx, y: cy + 16, "text-anchor": "middle" });
      tl.textContent = centre.label;
      s.appendChild(tl);
    }
    row.appendChild(s);
    const legend = el("ul", "obs-legend");
    for (const sl of slices) {
      const li = el("li", "obs-legend-item obs-tone-" + sl.tone);
      li.appendChild(el("i", "obs-swatch"));
      li.appendChild(el("span", "obs-legend-word", sl.label));
      li.appendChild(el("span", "obs-legend-n instr-value", viewChartNum(sl.value)));
      legend.appendChild(li);
    }
    row.appendChild(legend);
    well.appendChild(row);
  });
}

/* ————— 4. stacked bar ————— */

/**
 * data: { segments:[{label, value, tone, dim}] }
 * One horizontal bar; each segment is a mark; the legend carries the words.
 */
export function viewChartStacked(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const src = Array.isArray(d.segments) ? d.segments.slice(0, 8) : [];
  const segments = src.map((x) => {
    const o = x && typeof x === "object" ? x : {};
    return { label: viewChartText(o.label, 40), value: viewChartInt(o.value), tone: tone(o.tone), dim: o.dim === true };
  });
  const shaped = { segments };
  return frame(host, "stacked", shaped, opts, (well) => {
    const total = segments.reduce((a, b) => a + b.value, 0);
    if (!total) { empty(well, opts && opts.empty); return; }
    const h = 28;
    const s = baseSvg(W, h, (opts && opts.title) + ": " + viewChartNum(total) + " across " + segments.length + " states");
    let x = 0;
    for (const sg of segments) {
      if (!sg.value) continue;
      const w = round2((sg.value / total) * W);
      s.appendChild(svg("rect", { class: "obs-seg obs-tone-" + sg.tone + (sg.dim ? " obs-seg-dim" : ""), x: round2(x), y: 2, width: Math.max(0.5, w), height: h - 4,
        title: sg.label + " — " + viewChartNum(sg.value) + " (" + Math.round((sg.value / total) * 100) + "%)" }));
      x += w;
    }
    well.appendChild(s);
    const legend = el("ul", "obs-legend obs-legend-row");
    for (const sg of segments) {
      const li = el("li", "obs-legend-item obs-tone-" + sg.tone + (sg.dim ? " obs-legend-dim" : ""));
      li.appendChild(el("i", "obs-swatch"));
      li.appendChild(el("span", "obs-legend-word", sg.label));
      li.appendChild(el("span", "obs-legend-n instr-value", viewChartNum(sg.value)));
      legend.appendChild(li);
    }
    well.appendChild(legend);
  });
}

/* ————— 5. sparkline ————— */

/**
 * data: { values:[int…], big:{value, label}, tone }
 * A single polyline (one mark) under a readout. `values` may carry -1 for a
 * missing reading, which breaks the line rather than drawing a zero.
 */
export function viewChartSparkline(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const raw = Array.isArray(d.values) ? d.values.slice(0, 96) : [];
  const values = raw.map((v) => (typeof v === "number" && Number.isFinite(v) && Math.floor(v) === -1 ? -1 : viewChartInt(v)));
  const big = d.big && typeof d.big === "object" ? { value: viewChartText(d.big.value, 24), label: viewChartText(d.big.label, 48), tone: tone(d.big.tone) } : null;
  const shaped = { values, big, tone: tone(d.tone), unit: viewChartText(d.unit, 24) || "" };
  return frame(host, "sparkline", shaped, opts, (well) => {
    if (big) {
      const ro = el("div", "obs-readout obs-readout-big obs-tone-" + big.tone);
      ro.appendChild(el("span", "obs-readout-value instr-value", big.value));
      ro.appendChild(el("span", "obs-readout-label instr-label", big.label));
      well.appendChild(ro);
    }
    const present = values.filter((v) => v >= 0);
    if (!values.length || !present.length) { empty(well, opts && opts.empty); return; }
    const h = 60;
    const s = baseSvg(W, h, (opts && opts.title) + ": " + present.length + " readings, latest " + viewChartNum(present[present.length - 1]));
    const max = Math.max(1, ...present);
    const n = values.length;
    const stepW = n > 1 ? W / (n - 1) : 0;
    let dstr = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v < 0) { pen = false; return; }
      const x = round2(i * stepW), y = round2(h - 6 - (v / max) * (h - 12));
      dstr += (pen ? " L" : " M") + x + "," + y;
      pen = true;
    });
    s.appendChild(svg("path", { class: "obs-line obs-tone-" + shaped.tone, d: dstr.trim(), fill: "none",
      title: "peak " + viewChartNum(max) + ", latest " + viewChartNum(present[present.length - 1]) + (shaped.unit ? " " + shaped.unit : "") }));
    well.appendChild(s);
  });
}

/* ————— 6. LED-bar rows ————— */

/**
 * data: { rows:[{label, value, max, note, tone, dim, pinned, word}] }
 * HTML rows: label, a track whose fill is scaled by transform, the value in
 * mono, an optional word ("you", "YOUR TEAM"). The track carries a title.
 */
export function viewChartLedRows(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const src = Array.isArray(d.rows) ? d.rows.slice(0, 32) : [];
  const rows = src.map((x) => {
    const o = x && typeof x === "object" ? x : {};
    return {
      label: viewChartText(o.label, 32), value: viewChartInt(o.value), max: viewChartInt(o.max),
      note: viewChartText(o.note, 48), tone: tone(o.tone), dim: o.dim === true, pinned: o.pinned === true, word: viewChartText(o.word, 16)
    };
  });
  const shaped = { rows, unit: viewChartText(d.unit, 24) || "" };
  /* A rebuild makes brand-new fill elements, which would have no previous
   * transform to slide from; so the fills the last drawing left are read by
   * row label first, and a fill whose number changed starts at its old scale
   * and is moved to the new one after one style flush — that is the 320 ms
   * the stylesheet describes, and under reduced motion it is a plain jump.
   * A fill whose number did not change is created at its value and never
   * moves. */
  const was = {};
  const prevFig = findFigure(host, "ledrows");
  if (prevFig) {
    for (const li of prevFig.querySelectorAll(".obs-ledrow")) {
      const lab = li.querySelector(".obs-ledrow-label"), fill = li.querySelector(".obs-ledbar-fill");
      if (lab && fill && fill.style.transform) was[lab.textContent] = fill.style.transform;
    }
  }
  return frame(host, "ledrows", shaped, opts, (well) => {
    if (!rows.length) { empty(well, opts && opts.empty); return; }
    const max = Math.max(1, ...rows.map((r) => Math.max(r.max, r.value)));
    const list = el("ol", "obs-ledrows");
    const sliding = [];
    for (const r of rows) {
      const li = el("li", "obs-ledrow obs-tone-" + r.tone + (r.dim ? " obs-ledrow-dim" : "") + (r.pinned ? " obs-ledrow-pinned" : ""));
      const labelText = r.dim ? "—" : (r.label || "—") + (r.note ? " · " + r.note : "");
      li.appendChild(el("span", "obs-ledrow-label", labelText));
      const track = el("div", "obs-ledbar");
      track.setAttribute("title", (r.label || "unlabelled") + " — " + viewChartNum(r.value) + (shaped.unit ? " " + shaped.unit : "") + " of " + viewChartNum(max));
      track.setAttribute("role", "img");
      track.setAttribute("aria-label", (r.label || "unlabelled") + " " + viewChartNum(r.value));
      const fill = el("i", "obs-ledbar-fill");
      const to = "scaleX(" + round2(Math.min(1, r.value / max)) + ")";
      const from = was[labelText];
      fill.style.transform = from && from !== to ? from : to;
      if (from && from !== to) sliding.push([fill, to]);
      track.appendChild(fill);
      li.appendChild(track);
      li.appendChild(el("span", "obs-ledrow-value instr-value", viewChartNum(r.value)));
      if (r.word) li.appendChild(el("span", "obs-ledrow-word", r.word));
      list.appendChild(li);
    }
    well.appendChild(list);
    if (sliding.length) {
      void list.offsetWidth;   // one style flush, only when a number changed, so the old scale is the transition's start
      for (const [fill, to] of sliding) fill.style.transform = to;
    }
  });
}

/* ————— 7. readouts ————— */

/**
 * data: { items:[{label, value, note, tone, word}] }
 * A grid of labelled mono values — the four LEDs of the session ledger, the
 * three freshness clocks, the integrity percentage.
 */
export function viewChartReadouts(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const src = Array.isArray(d.items) ? d.items.slice(0, 8) : [];
  const items = src.map((x) => {
    const o = x && typeof x === "object" ? x : {};
    return { label: viewChartText(o.label, 40), value: viewChartText(o.value, 24) || "—", note: viewChartText(o.note, 64), tone: tone(o.tone), word: viewChartText(o.word, 16) };
  });
  const shaped = { items, big: d.big === true };
  return frame(host, "readouts", shaped, opts, (well) => {
    if (!items.length) { empty(well, opts && opts.empty); return; }
    const grid = el("div", "obs-readouts" + (shaped.big ? " obs-readouts-big" : ""));
    for (const it of items) {
      const ro = el("div", "obs-readout obs-tone-" + it.tone);
      ro.setAttribute("title", it.label + ": " + it.value + (it.note ? " (" + it.note + ")" : ""));
      ro.appendChild(el("span", "obs-readout-label instr-label", it.label));
      ro.appendChild(el("span", "obs-readout-value instr-value", it.value));
      if (it.word) ro.appendChild(el("span", "obs-readout-word", it.word));
      if (it.note) ro.appendChild(el("span", "obs-readout-note", it.note));
      grid.appendChild(ro);
    }
    well.appendChild(grid);
  });
}

/* ————— 8. bars with a budget line (the bandwidth meter) ————— */

/**
 * data: { bars:[{label, value, title}], line:{value, label}, word }
 * Daily bars against a horizontal budget line; a bar over the line is amber
 * and the figure prints `word` (QUIET) — the host's own request, not a mood.
 */
export function viewChartBudget(host, data, opts) {
  const d = data && typeof data === "object" ? data : {};
  const src = Array.isArray(d.bars) ? d.bars.slice(0, 32) : [];
  const bars = src.map((x) => {
    const o = x && typeof x === "object" ? x : {};
    return { label: viewChartText(o.label, 32), value: viewChartInt(o.value), title: viewChartText(o.title, 120) };
  });
  const line = d.line && typeof d.line === "object" ? { value: viewChartInt(d.line.value), label: viewChartText(d.line.label, 40) } : null;
  const shaped = { bars, line, word: viewChartText(d.word, 16), over: d.over === true };
  return frame(host, "budget", shaped, opts, (well) => {
    if (!bars.length) { empty(well, opts && opts.empty); return; }
    const s = baseSvg(W, H, (opts && opts.title) + ": " + bars.length + " days" + (line ? ", budget " + viewChartNum(line.value) : ""));
    graticule(s, W, H);
    const top = Math.max(1, ...bars.map((b) => b.value), line ? line.value : 0);
    const n = bars.length;
    const gap = 2;
    const bw = round2((W - gap * (n - 1)) / n);
    const scaleH = H - PAD_B - PAD_T;
    bars.forEach((b, i) => {
      const over = line && line.value > 0 && b.value > line.value;
      const h = b.value ? Math.max(1, round2((b.value / top) * scaleH)) : 1;
      s.appendChild(svg("rect", { class: "obs-bar obs-tone-" + (over ? "amber" : "trace") + (b.value ? "" : " obs-bar-zero"),
        x: round2(i * (bw + gap)), y: round2(H - PAD_B - h), width: bw, height: h,
        title: b.title || (b.label + " — " + viewChartNum(b.value) + (over ? " — over the budget" : "")) }));
    });
    if (line && line.value > 0) {
      const y = round2(H - PAD_B - (line.value / top) * scaleH);
      s.appendChild(svg("line", { class: "obs-budget-line obs-tone-amber", x1: 0, x2: W, y1: y, y2: y, title: line.label + " — " + viewChartNum(line.value) }));
      const t = svg("text", { class: "obs-svg-label", x: 4, y: Math.max(PAD_T + 8, y - 3) });
      t.textContent = line.label;
      s.appendChild(t);
    }
    if (shaped.over && shaped.word) {
      const t = svg("text", { class: "obs-svg-big obs-tone-amber", x: W - 4, y: PAD_T + 22, "text-anchor": "end" });
      t.textContent = shaped.word;
      s.appendChild(t);
    }
    well.appendChild(s);
    if (shaped.over && shaped.word) well.appendChild(el("p", "obs-word obs-tone-amber", shaped.word));
  });
}
