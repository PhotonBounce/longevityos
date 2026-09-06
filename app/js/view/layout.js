/* layout.js — THE MOLECULE BUILDER (LongevityOS 4.0 §4).
 *
 * viewLayoutMolecule(smiles) turns a SMILES string into 2-D drawing
 * coordinates for the lens: atoms, bonds (with double/triple offsets and
 * label shortening already applied), aromatic-ring circles, build waves, and
 * a 320×240 viewBox. It draws THE SAME GRAPH THE ENGINE SCORED: the only way
 * in is molFromSmiles (parse + aromaticity perception, the screening path's
 * own front door) and the ring set is perceivedRings from descriptors.js —
 * never a second parser, never a second ring perception.
 *
 * This module lives OUTSIDE chem/ on purpose. It feeds nothing back: no
 * score, digest or flag ever depends on a coordinate, so Math.sin/cos/atan2
 * are legal here (they are banned on the screening path, where a rounding
 * difference between engines would fork a digest). It is still DETERMINISTIC:
 * every list is walked in ascending index order, nothing reads a clock or a
 * random source, and the same SMILES produces byte-identical JSON in every run
 * and every process — qa/layout.mjs proves it.
 *
 * It never throws. Anything it cannot draw (no parse, no atoms, more than 80
 * atoms or 96 bonds, a coordinate that did not resolve) is null; a ring
 * system that had to be interpolated rather than constructed is returned
 * with `approximate: true`, and the lens refuses to draw those too — a wrong
 * drawing beside a real score is worse than an honest card.
 *
 * Steps, in the order the spec lists them:
 *   1 parse and refuse    2 adjacency (ascending)    3 ring systems (union-find)
 *   4 seed (n-gon / zig-zag diameter)   5 fusion (shared bond / spiro / arc)
 *   6 chains by BFS       7 relief rounds            8 validate + fit
 *   9 bond geometry       10 waves
 */

import { molFromSmiles } from "../chem/aromatic.js";
import { perceivedRings } from "../chem/descriptors.js";

/* ————— constants (bond length L = 1 until the fit step) ————— */

const L = 1;
const MAX_ATOMS = 80;
const MAX_BONDS = 96;
const MAX_LABELS = 48;          // the lens's label pool
const MAX_WAVES = 8;            // the lens's composited wave groups
const MAX_AROM_CIRCLES = 8;     // the lens's aromatic-circle pool
const MAX_CLOSURES = 6;         // ring-closure draw paths
const BOX_W = 320, BOX_H = 240; // the viewBox
const FIT_W = 288, FIT_H = 208; // the drawing area inside it
const NOMINAL_PX = 30;          // px per bond at scale 1
const SCALE_CAP = 1.35;         // a tiny molecule is never blown up past this
const RELIEF_ROUNDS = 60;
const RELIEF_MAX_ATOMS = 60;
const RELIEF_NEAR = 0.62 * L;
const RELIEF_PUSH = 0.04 * L;
const COLLIDE = 0.5 * L;
const ARC_BULGE = 0.45 * L;
const DOUBLE_OFFSET = 0.13 * L;
const TRIPLE_OFFSET = 0.15 * L;
const LABEL_SHORTEN = 0.2 * L;
const INNER_SHORTEN = 0.18 * L; // the second line of a ring double bond
const AROM_CIRCLE = 0.62;       // fraction of the ring radius
const GUTTER = 0.9 * L;         // between disconnected components

const DEG60 = Math.PI / 3;
const DEG30 = Math.PI / 6;
const TAU = Math.PI * 2;

/* ————— the export ————— */

export function viewLayoutMolecule(smiles) {
  try {
    return layout(smiles);
  } catch (_) {
    return null;
  }
}

/* ————— small geometry helpers ————— */

const round2 = (v) => Math.round(v * 100) / 100;
const angleOf = (dx, dy) => Math.atan2(dy, dx);
const norm = (a) => { let t = a % TAU; if (t < 0) t += TAU; return t; };
const dist = (x1, y1, x2, y2) => Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));

/* the widest angular gap between a sorted set of directions; returns its
 * bisector. With one direction the gap is the whole circle opposite it. */
function widestGapBisector(angles) {
  if (!angles.length) return 0;
  const s = angles.map(norm).sort((a, b) => a - b);
  let bestGap = -1, bestStart = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s[i];
    const b = i + 1 < s.length ? s[i + 1] : s[0] + TAU;
    const gap = b - a;
    if (gap > bestGap + 1e-12) { bestGap = gap; bestStart = a; }
  }
  return norm(bestStart + bestGap / 2);
}

/* ————— the pipeline ————— */

function layout(smiles) {
  /* 1. parse; refuse what the lens does not draw */
  if (typeof smiles !== "string" || !smiles.length) return null;
  const mol = molFromSmiles(smiles);
  if (!mol || !Array.isArray(mol.atoms) || !Array.isArray(mol.bonds)) return null;
  const n = mol.atoms.length;
  if (n === 0 || n > MAX_ATOMS) return null;
  if (mol.bonds.length > MAX_BONDS) return null;
  for (const b of mol.bonds) {
    if (!b || !Number.isInteger(b.a) || !Number.isInteger(b.b)) return null;
    if (b.a < 0 || b.b < 0 || b.a >= n || b.b >= n || b.a === b.b) return null;
  }

  /* 2. adjacency, ascending on both axes */
  const adj = [];
  for (let i = 0; i < n; i++) adj.push([]);
  mol.bonds.forEach((b, k) => {
    adj[b.a].push({ j: b.b, k });
    adj[b.b].push({ j: b.a, k });
  });
  for (const list of adj) list.sort((p, q) => p.j - q.j || p.k - q.k);
  const bondIndex = new Map();
  mol.bonds.forEach((b, k) => { bondIndex.set(b.a < b.b ? b.a + ":" + b.b : b.b + ":" + b.a, k); });
  const bondBetween = (a, b) => { const k = bondIndex.get(a < b ? a + ":" + b : b + ":" + a); return k === undefined ? -1 : k; };

  /* 3. ring systems: union-find over the engine's own perceived rings */
  const rawRings = perceivedRings(mol);
  const rings = [];
  for (const r of Array.isArray(rawRings) ? rawRings : []) {
    if (!Array.isArray(r) || r.length < 3) continue;
    if (!r.every((i) => Number.isInteger(i) && i >= 0 && i < n)) continue;
    if (new Set(r).size !== r.length) continue;
    /* the ring must be a genuine cycle in bond order */
    let cyc = true;
    for (let i = 0; i < r.length; i++) if (bondBetween(r[i], r[(i + 1) % r.length]) < 0) { cyc = false; break; }
    if (!cyc) continue;
    rings.push(r.slice());
  }
  rings.sort((a, b) => (a.length - b.length) || (Math.min(...a) - Math.min(...b)));

  const parent = rings.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const ringsOfAtom = [];
  for (let i = 0; i < n; i++) ringsOfAtom.push([]);
  rings.forEach((r, ri) => { for (const a of r) ringsOfAtom[a].push(ri); });
  for (let a = 0; a < n; a++) for (let i = 1; i < ringsOfAtom[a].length; i++) union(ringsOfAtom[a][0], ringsOfAtom[a][i]);

  const sysByRoot = new Map();
  rings.forEach((r, ri) => {
    const root = find(ri);
    let s = sysByRoot.get(root);
    if (!s) { s = { rings: [], atoms: new Set(), minIdx: n, approximate: false, placed: false }; sysByRoot.set(root, s); }
    s.rings.push(ri);
    for (const a of r) { s.atoms.add(a); if (a < s.minIdx) s.minIdx = a; }
  });
  const systems = [...sysByRoot.values()];
  systems.sort((a, b) => (b.atoms.size - a.atoms.size) || (a.minIdx - b.minIdx));
  const systemOfAtom = new Array(n).fill(-1);
  systems.forEach((s, si) => { for (const a of s.atoms) systemOfAtom[a] = si; });
  const inRing = new Array(n).fill(false);
  for (let a = 0; a < n; a++) inRing[a] = ringsOfAtom[a].length > 0;

  /* bond multiplicity helpers for the chain rules */
  const order = (k) => { const o = mol.bonds[k].order; return Number.isInteger(o) ? o : 1; };
  const isTripleOrAllene = (a) => {
    let doubles = 0;
    for (const e of adj[a]) { const o = order(e.k); if (o === 3) return true; if (o === 2) doubles++; }
    return doubles >= 2;
  };

  /* ————— placement state ————— */
  const x = new Float64Array(n), y = new Float64Array(n);
  const placed = new Array(n).fill(false);
  const chainDepth = new Int32Array(n);
  const ringPlaced = rings.map(() => false);
  let approximate = false;

  const placedCentroid = (atoms) => {
    let cx = 0, cy = 0, c = 0;
    for (const a of atoms) if (placed[a]) { cx += x[a]; cy += y[a]; c++; }
    return c ? { x: cx / c, y: cy / c, n: c } : { x: 0, y: 0, n: 0 };
  };
  const placedNeighbourAngles = (a) => {
    const out = [];
    for (const e of adj[a]) if (placed[e.j]) out.push(angleOf(x[e.j] - x[a], y[e.j] - y[a]));
    return out;
  };
  const collides = (px, py, except) => {
    for (let i = 0; i < n; i++) {
      if (!placed[i] || i === except) continue;
      if (dist(px, py, x[i], y[i]) < COLLIDE) return true;
    }
    return false;
  };

  /* 4a. seed a ring as a regular n-gon, lowest-index atom at 90° */
  function seedRing(ri, cx, cy) {
    const r = rings[ri];
    const m = r.length;
    const R = L / (2 * Math.sin(Math.PI / m));
    let start = 0;
    for (let i = 1; i < m; i++) if (r[i] < r[start]) start = i;
    for (let i = 0; i < m; i++) {
      const a = r[(start + i) % m];
      const th = Math.PI / 2 + (i * TAU) / m;
      x[a] = cx + R * Math.cos(th);
      y[a] = cy + R * Math.sin(th);
      placed[a] = true;
      chainDepth[a] = 0;
    }
    ringPlaced[ri] = true;
  }

  /* 5. fuse the remaining rings of a system onto whatever is already placed */
  function fuseSystem(si) {
    const sys = systems[si];
    for (;;) {
      let best = -1, bestCount = -1;
      for (const ri of sys.rings) {
        if (ringPlaced[ri]) continue;
        let c = 0;
        for (const a of rings[ri]) if (placed[a]) c++;
        if (c > bestCount) { bestCount = c; best = ri; }
      }
      if (best < 0) break;
      if (bestCount === 0) {
        /* cannot happen for a connected system, but a system is never left
         * half-drawn: seed it beside what exists */
        const c = placedCentroid(sys.atoms);
        seedRing(best, c.x + 3 * L, c.y);
        continue;
      }
      fuseRing(best, sys);
    }
    sys.placed = true;
    if (sys.approximate) approximate = true;
  }

  function fuseRing(ri, sys) {
    const r = rings[ri];
    const m = r.length;
    const R = L / (2 * Math.sin(Math.PI / m));
    const isPlaced = r.map((a) => placed[a]);
    const count = isPlaced.filter(Boolean).length;
    const centroid = placedCentroid(sys.atoms);

    if (count === 1) {
      /* spiro: the ring hangs off one atom, into its widest free gap */
      const pi = isPlaced.indexOf(true);
      const P = r[pi];
      const u = widestGapBisector(placedNeighbourAngles(P));
      const cx = x[P] + R * Math.cos(u), cy = y[P] + R * Math.sin(u);
      const thP = angleOf(x[P] - cx, y[P] - cy);
      for (let k = 1; k < m; k++) {
        const a = r[(pi + k) % m];
        const th = thP + (k * TAU) / m;
        x[a] = cx + R * Math.cos(th);
        y[a] = cy + R * Math.sin(th);
        placed[a] = true;
        chainDepth[a] = 0;
      }
      ringPlaced[ri] = true;
      return;
    }

    /* runs of unplaced atoms, in cyclic ring order, each bounded by placed atoms */
    const runs = [];
    let startAt = isPlaced.indexOf(true);
    for (let s = 0; s < m; s++) {
      const i = (startAt + s) % m;
      if (isPlaced[i]) continue;
      /* start of a run? */
      const prev = (i + m - 1) % m;
      if (!isPlaced[prev]) continue;
      const run = [];
      let j = i;
      while (!isPlaced[j]) { run.push(j); j = (j + 1) % m; }
      runs.push({ from: prev, to: j, idx: run });
    }

    if (runs.length === 1) {
      /* a contiguous fused edge (a shared bond is the m-2 case): the centre
       * sits on the chord's normal, on the side away from what is placed, at
       * the height a regular polygon puts it — for a shared bond that is the
       * spec's M + N·L/(2·tan(π/n)); the arc is walked the long way round */
      const run = runs[0];
      const P = r[run.from], Q = r[run.to];
      const mx = (x[P] + x[Q]) / 2, my = (y[P] + y[Q]) / 2;
      let nx = -(y[Q] - y[P]), ny = x[Q] - x[P];
      const nl = Math.sqrt(nx * nx + ny * ny) || 1;
      nx /= nl; ny /= nl;
      if ((centroid.x - mx) * nx + (centroid.y - my) * ny > 0) { nx = -nx; ny = -ny; }
      const mRun = run.idx.length;
      const h = -R * Math.cos((Math.PI * (mRun + 1)) / m);
      const cx = mx + nx * h, cy = my + ny * h;
      const thP = angleOf(x[P] - cx, y[P] - cy);
      const thQ = angleOf(x[Q] - cx, y[Q] - cy);
      const sweep = ((mRun + 1) * TAU) / m;
      const dPlus = Math.abs(norm(thP + sweep - thQ + Math.PI) - Math.PI);
      const dMinus = Math.abs(norm(thP - sweep - thQ + Math.PI) - Math.PI);
      const s = dPlus <= dMinus ? 1 : -1;
      const Rr = (dist(x[P], y[P], cx, cy) + dist(x[Q], y[Q], cx, cy)) / 2 || R;
      run.idx.forEach((i, k) => {
        const a = r[i];
        const th = thP + (s * (k + 1) * TAU) / m;
        x[a] = cx + Rr * Math.cos(th);
        y[a] = cy + Rr * Math.sin(th);
        placed[a] = true;
        chainDepth[a] = 0;
      });
    } else {
      /* placed atoms that are not one contiguous stretch (a bridged system):
       * interpolate each gap along an arc bulging 0.45L away from what is
       * placed, and say so — the lens refuses to draw an approximate system */
      sys.approximate = true;
      for (const run of runs) {
        const P = r[run.from], Q = r[run.to];
        let nx = -(y[Q] - y[P]), ny = x[Q] - x[P];
        const nl = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= nl; ny /= nl;
        const mx = (x[P] + x[Q]) / 2, my = (y[P] + y[Q]) / 2;
        if ((centroid.x - mx) * nx + (centroid.y - my) * ny > 0) { nx = -nx; ny = -ny; }
        const mRun = run.idx.length;
        run.idx.forEach((i, k) => {
          const a = r[i];
          const t = (k + 1) / (mRun + 1);
          const bulge = ARC_BULGE * Math.sin(Math.PI * t);
          x[a] = x[P] + (x[Q] - x[P]) * t + nx * bulge;
          y[a] = y[P] + (y[Q] - y[P]) * t + ny * bulge;
          placed[a] = true;
          chainDepth[a] = 0;
        });
      }
    }
    ringPlaced[ri] = true;
  }

  /* 6. one chain atom, from its parent */
  function placeChild(p, c) {
    const angles = placedNeighbourAngles(p);
    let a;
    if (angles.length >= 2) {
      a = widestGapBisector(angles);
    } else if (angles.length === 1) {
      const incoming = angles[0] + Math.PI;            // direction the chain is travelling
      const k = bondBetween(p, c);
      if ((k >= 0 && order(k) === 3) || isTripleOrAllene(p)) a = incoming;
      else a = incoming + ((chainDepth[p] + 1) % 2 === 1 ? DEG60 : -DEG60);
    } else {
      a = 0;
    }
    /* six tries around the ideal slot before accepting a collision */
    const slots = [0, DEG60, -DEG60, 2 * DEG60, -2 * DEG60, Math.PI];
    let px = x[p] + L * Math.cos(a), py = y[p] + L * Math.sin(a);
    for (const d of slots) {
      const tx = x[p] + L * Math.cos(a + d), ty = y[p] + L * Math.sin(a + d);
      if (!collides(tx, ty, p)) { px = tx; py = ty; break; }
    }
    x[c] = px; y[c] = py;
    placed[c] = true;
    chainDepth[c] = chainDepth[p] + 1;
  }

  /* connected components, ascending */
  const compOf = new Int32Array(n).fill(-1);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (compOf[s] !== -1) continue;
    const members = [s];
    compOf[s] = comps.length;
    for (let h = 0; h < members.length; h++) {
      for (const e of adj[members[h]]) if (compOf[e.j] === -1) { compOf[e.j] = comps.length; members.push(e.j); }
    }
    members.sort((p, q) => p - q);
    comps.push(members);
  }

  const seeds = [];           // one seed set per component, for the waves
  for (const members of comps) {
    /* 4. seed: the largest ring system's first ring, or the diameter zig-zag */
    let si = -1;
    for (let i = 0; i < systems.length; i++) if (compOf[[...systems[i].atoms][0]] === compOf[members[0]]) { si = i; break; }
    const queue = [];
    if (si >= 0) {
      seedRing(systems[si].rings[0], 0, 0);
      fuseSystem(si);
      seeds.push(rings[systems[si].rings[0]].slice().sort((p, q) => p - q));
      for (const a of members) if (placed[a]) queue.push(a);
    } else {
      const far = (from) => {
        const d = new Int32Array(n).fill(-1);
        const prev = new Int32Array(n).fill(-1);
        d[from] = 0;
        const q = [from];
        let best = from;
        for (let h = 0; h < q.length; h++) {
          const v = q[h];
          if (d[v] > d[best]) best = v;
          for (const e of adj[v]) if (d[e.j] === -1) { d[e.j] = d[v] + 1; prev[e.j] = v; q.push(e.j); }
        }
        return { best, prev };
      };
      const u = far(members[0]).best;
      const { best: v, prev } = far(u);
      const path = [];
      for (let cur = v; cur !== -1; cur = prev[cur]) path.push(cur);
      path.reverse();                                   // u … v
      let px = 0, py = 0;
      path.forEach((a, k) => {
        if (k > 0) {
          const th = k % 2 === 1 ? -DEG30 : DEG30;
          px += L * Math.cos(th); py += L * Math.sin(th);
        }
        x[a] = px; y[a] = py; placed[a] = true; chainDepth[a] = k;
      });
      seeds.push([u]);
      queue.push(...path);
    }

    /* 6. chains: BFS from every placed atom, parent ascending, neighbour ascending */
    queue.sort((p, q) => p - q);
    for (let h = 0; h < queue.length; h++) {
      const p = queue[h];
      for (const e of adj[p]) {
        const c = e.j;
        if (placed[c]) continue;
        placeChild(p, c);
        const cs = systemOfAtom[c];
        if (cs >= 0 && !systems[cs].placed) {
          /* the chain reached an unplaced ring system: it hangs off this atom
           * (the spiro rule) and the rest of the system fuses onto it */
          chainDepth[c] = 0;
          fuseSystem(cs);
          const fresh = [];
          for (const a of systems[cs].atoms) if (placed[a] && !queue.includes(a)) fresh.push(a);
          fresh.sort((p2, q2) => p2 - q2);
          queue.push(...fresh);
        } else {
          queue.push(c);
        }
      }
    }
  }
  for (let i = 0; i < n; i++) if (!placed[i]) return null;

  /* pack disconnected components left to right with a gutter */
  if (comps.length > 1) {
    let cursor = 0;
    for (const members of comps) {
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const a of members) { minx = Math.min(minx, x[a]); maxx = Math.max(maxx, x[a]); miny = Math.min(miny, y[a]); maxy = Math.max(maxy, y[a]); }
      const dx = cursor - minx, dy = -(miny + maxy) / 2;
      for (const a of members) { x[a] += dx; y[a] += dy; }
      cursor += (maxx - minx) + GUTTER;
    }
  }

  /* 7. relief: pairs far apart in the graph but close on the page are pushed
   * apart; ring atoms are frozen, so a ring is never bent */
  if (n <= RELIEF_MAX_ATOMS && n > 3) {
    const gd = [];
    for (let s = 0; s < n; s++) {
      const d = new Int32Array(n).fill(-1);
      d[s] = 0;
      const q = [s];
      for (let h = 0; h < q.length; h++) for (const e of adj[q[h]]) if (d[e.j] === -1) { d[e.j] = d[q[h]] + 1; q.push(e.j); }
      gd.push(d);
    }
    for (let round = 0; round < RELIEF_ROUNDS; round++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const g = gd[i][j];
          if (g !== -1 && g < 3) continue;
          if (inRing[i] && inRing[j]) continue;
          const dd = dist(x[i], y[i], x[j], y[j]);
          if (dd >= RELIEF_NEAR) continue;
          let ux = 1, uy = 0;
          if (dd > 1e-9) { ux = (x[j] - x[i]) / dd; uy = (y[j] - y[i]) / dd; }
          if (!inRing[i]) { x[i] -= ux * RELIEF_PUSH; y[i] -= uy * RELIEF_PUSH; }
          if (!inRing[j]) { x[j] += ux * RELIEF_PUSH; y[j] += uy * RELIEF_PUSH; }
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  /* 8. validate, then fit into 288×208 centred in the 320×240 box */
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return null;
    minx = Math.min(minx, x[i]); maxx = Math.max(maxx, x[i]); miny = Math.min(miny, y[i]); maxy = Math.max(maxy, y[i]);
  }
  const w = Math.max(maxx - minx, 1e-6), hgt = Math.max(maxy - miny, 1e-6);
  const scale = Math.min(FIT_W / w, FIT_H / hgt, NOMINAL_PX * SCALE_CAP);
  const ox = BOX_W / 2 - (scale * (minx + maxx)) / 2;
  const oy = BOX_H / 2 - (scale * (miny + maxy)) / 2;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = round2(ox + scale * x[i]); Y[i] = round2(oy + scale * y[i]); }

  /* 10 (first half). waves: BFS depth from the seed, per component */
  const depth = new Int32Array(n).fill(-1);
  for (const seed of seeds) {
    const q = [];
    for (const a of seed) { depth[a] = 0; q.push(a); }
    for (let h = 0; h < q.length; h++) for (const e of adj[q[h]]) if (depth[e.j] === -1) { depth[e.j] = depth[q[h]] + 1; q.push(e.j); }
  }
  let maxDepth = 0;
  for (let i = 0; i < n; i++) { if (depth[i] < 0) depth[i] = 0; if (depth[i] > maxDepth) maxDepth = depth[i]; }
  const groups = Math.min(MAX_WAVES, maxDepth + 1);
  const waveOf = (d) => Math.min(groups - 1, Math.floor((d * groups) / (maxDepth + 1)));

  /* 9. atoms and labels */
  const atoms = [];
  let labels = 0;
  for (let i = 0; i < n; i++) {
    const at = mol.atoms[i];
    const el = typeof at.el === "string" ? at.el : "?";
    const h = Number.isInteger(at.hcount) && at.hcount > 0 ? at.hcount : 0;
    const charge = Number.isInteger(at.charge) ? at.charge : 0;
    const bare = el === "C" && charge === 0 && adj[i].length > 0;
    let label = "";
    if (!bare) {
      label = el;
      if (el !== "H" && h > 0) label += "H" + (h > 1 ? String(h) : "");
      if (charge !== 0) label += (Math.abs(charge) > 1 ? String(Math.abs(charge)) : "") + (charge > 0 ? "+" : "−");
      labels++;
    }
    atoms.push({
      i,
      x: X[i],
      y: Y[i],
      el,
      label,
      cls: elementClass(el),
      wave: waveOf(depth[i]),
      ring: inRing[i]
    });
  }
  if (labels > MAX_LABELS) approximate = true;   // more labels than the lens can hang

  /* ring centroids (for double-bond sides) and aromatic rings */
  const ringCentroid = rings.map((r) => {
    let cx = 0, cy = 0;
    for (const a of r) { cx += X[a]; cy += Y[a]; }
    return { x: cx / r.length, y: cy / r.length };
  });
  const isAromaticRing = rings.map((r) => r.every((a, i) => {
    const k = bondBetween(a, r[(i + 1) % r.length]);
    return k >= 0 && mol.bonds[k].arom === true;
  }));

  /* which bonds close a ring (drawn as a stroke, ≤ 6) */
  const closures = new Set();
  for (let ri = 0; ri < rings.length && closures.size < MAX_CLOSURES; ri++) {
    const r = rings[ri];
    let kmax = -1;
    for (let i = 0; i < r.length; i++) { const k = bondBetween(r[i], r[(i + 1) % r.length]); if (k > kmax) kmax = k; }
    if (kmax >= 0 && !closures.has(kmax)) closures.add(kmax);
  }

  const bonds = [];
  mol.bonds.forEach((b, k) => {
    const a1 = b.a, a2 = b.b;
    const arom = b.arom === true;
    const o = arom ? 1 : order(k);
    const wave = Math.max(atoms[a1].wave, atoms[a2].wave);
    /* the line, shortened at labelled ends */
    let x1 = X[a1], y1 = Y[a1], x2 = X[a2], y2 = Y[a2];
    const full = dist(x1, y1, x2, y2) || 1e-6;
    const ux = (x2 - x1) / full, uy = (y2 - y1) / full;
    const s1 = atoms[a1].label ? LABEL_SHORTEN * scale : 0;
    const s2 = atoms[a2].label ? LABEL_SHORTEN * scale : 0;
    x1 += ux * s1; y1 += uy * s1; x2 -= ux * s2; y2 -= uy * s2;
    const offsets = [];
    if (o === 2) {
      /* which side: toward the ring the bond sits in, else toward the other
       * neighbours, else the left normal */
      let nx = -uy, ny = ux;
      let side = null;
      for (const ri of ringsOfAtom[a1]) if (rings[ri].includes(a2)) { side = ringCentroid[ri]; break; }
      let inRingBond = !!side;
      if (!side) {
        let cx = 0, cy = 0, c = 0;
        for (const e of adj[a1]) if (e.j !== a2) { cx += X[e.j]; cy += Y[e.j]; c++; }
        for (const e of adj[a2]) if (e.j !== a1) { cx += X[e.j]; cy += Y[e.j]; c++; }
        if (c) side = { x: cx / c, y: cy / c };
      }
      if (side) {
        const mx = (X[a1] + X[a2]) / 2, my = (Y[a1] + Y[a2]) / 2;
        if ((side.x - mx) * nx + (side.y - my) * ny < 0) { nx = -nx; ny = -ny; }
      }
      const off = DOUBLE_OFFSET * scale;
      const trim = inRingBond ? INNER_SHORTEN * scale : 0;
      offsets.push({
        x1: round2(x1 + nx * off + ux * trim), y1: round2(y1 + ny * off + uy * trim),
        x2: round2(x2 + nx * off - ux * trim), y2: round2(y2 + ny * off - uy * trim)
      });
    } else if (o === 3) {
      const off = TRIPLE_OFFSET * scale;
      const nx = -uy, ny = ux;
      offsets.push({ x1: round2(x1 + nx * off), y1: round2(y1 + ny * off), x2: round2(x2 + nx * off), y2: round2(y2 + ny * off) });
      offsets.push({ x1: round2(x1 - nx * off), y1: round2(y1 - ny * off), x2: round2(x2 - nx * off), y2: round2(y2 - ny * off) });
    }
    bonds.push({
      a: a1, b: a2,
      x1: round2(x1), y1: round2(y1), x2: round2(x2), y2: round2(y2),
      order: o, arom, wave, closure: closures.has(k), offsets
    });
  });

  const aromRings = [];
  for (let ri = 0; ri < rings.length && aromRings.length < MAX_AROM_CIRCLES; ri++) {
    if (!isAromaticRing[ri]) continue;
    const r = rings[ri];
    const c = ringCentroid[ri];
    let rad = 0;
    for (const a of r) rad += dist(X[a], Y[a], c.x, c.y);
    rad /= r.length;
    let wave = 0;
    for (const a of r) wave = Math.max(wave, atoms[a].wave);
    aromRings.push({ cx: round2(c.x), cy: round2(c.y), r: round2(rad * AROM_CIRCLE), wave });
  }

  return {
    atoms,
    bonds,
    aromRings,
    waves: groups,
    box: { w: BOX_W, h: BOX_H },
    approximate,
    scale: round2(scale),
    counts: {
      atoms: n,
      bonds: bonds.length,
      labels,
      rings: rings.length,
      aromatic: isAromaticRing.filter(Boolean).length,
      systems: systems.length,
      components: comps.length
    }
  };
}

function elementClass(el) {
  switch (el) {
    case "C": return "c";
    case "N": return "n";
    case "O": return "o";
    case "S": return "s";
    case "P": return "p";
    case "F": case "Cl": case "Br": case "I": return "hal";
    default: return "x";
  }
}
