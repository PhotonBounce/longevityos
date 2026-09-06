/* The evidence ladder. Grades are COMPUTED from (organism, outcome) — never
 * hand-assigned. qa/content.mjs fails the build if a compound object carries
 * its own grade field, because a grade someone can type is a grade someone
 * can inflate. */

export const RUNGS = [
  {
    key: "H2", label: "Human RCT — aging outcome met",
    blurb: "A randomized human trial moving a real aging endpoint (mortality, disability-free survival). No compound has ever earned this rung. That empty top rung IS the headline."
  },
  {
    key: "H1", label: "Human RCT — function or biomarker",
    blurb: "Randomized human data moving something measurable (insulin sensitivity, muscle endurance, NAD+ levels). Real, but a biomarker is not a birthday."
  },
  {
    key: "M2", label: "Mouse lifespan — replicated multi-site (ITP)",
    blurb: "Lifespan extension in genetically heterogeneous mice, replicated across the NIA Interventions Testing Program's three sites. The gold standard below human data."
  },
  {
    key: "M1", label: "Mammal lifespan/healthspan — single program",
    blurb: "Lifespan or healthspan effects in mammals from one lab or program. Promising — and exactly the tier where famous results go to die on replication."
  },
  {
    key: "T0", label: "Human trials in progress",
    blurb: "Registered randomized human trials exist but haven't settled anything."
  }
];

const ROW_RUNG = (ev) => {
  if (ev.outcome === "null") return null;
  const o = ev.organism, out = ev.outcome;
  if (o === "human-rct" && (out === "biomarker" || out === "healthspan")) return "H1";
  if (o === "human-rct" && (out === "safety" || out === "trial")) return "T0";
  if ((o === "mouse" || o === "rat") && out === "lifespan" && /\(ITP\)/.test(ev.cite)) return "M2";
  if (["mouse", "rat", "dog", "monkey"].includes(o) && (out === "lifespan" || out === "healthspan")) return "M1";
  return null;
};

const ORDER = ["H2", "H1", "M2", "M1", "T0"];

export function strongest(compound) {
  let best = null;
  for (const ev of compound.evidence) {
    const r = ROW_RUNG(ev);
    if (r && (best === null || ORDER.indexOf(r) < ORDER.indexOf(best))) best = r;
  }
  return best || "T0";
}

export function hasRigorousNull(compound) {
  return compound.evidence.some((ev) => ev.outcome === "null");
}

export function rungLabel(key) {
  const r = RUNGS.find((r) => r.key === key);
  return r ? r.label : key;
}

export const ORGANISM_LABEL = {
  cell: "cells", worm: "worms", fly: "flies", mouse: "mice", rat: "rats",
  dog: "dogs", monkey: "monkeys", "human-obs": "humans (observational)",
  "human-rct": "humans (randomized trial)"
};
