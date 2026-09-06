/* content — the HONESTY lint. Dependency-free so it can gate before npm install.
 * Scans every shipped byte for the claims this app must never make. */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "app");
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|html|css)$/.test(f)) files.push(p);
  }
})(APP);
const text = Object.fromEntries(files.map((p) => [p, readFileSync(p, "utf8")]));
const all = Object.values(text).join("\n");

/* ————— 1. banned assertions ————— */
suite("content 1 — claims this app may never make");
const BANNED = [
  [/proven to extend human (life|lifespan)/i, "asserting proven human life extension"],
  [/\bcures? aging\b/i, "asserting a cure for aging"],
  [/\breverses? aging\b/i, "asserting aging reversal"],
  [/\bis an immortality drug\b/i, "asserting something IS an immortality drug"],
  [/\byou should take\b/i, "telling the reader to take something"],
  [/\btake \d+\s?(mg|mcg|g|grams?)\b/i, "imperative dosing"],
  [/\brecommended dos(e|age|ing)\b/i, "recommending doses"],
  [/\bguaranteed\b/i, "guarantees"],
  [/\bclinically proven\b/i, "'clinically proven' marketing language"],
  [/\bmakes? you (live|younger)\b/i, "asserting personal outcomes"],
  [/\banti[- ]aging breakthrough\b/i, "breakthrough hype"]
];
for (const [re, why] of BANNED) {
  ok(!re.test(all), "no shipped string is " + why + " (" + re + ")");
}

/* ————— 2. required honesty, structurally present ————— */
suite("content 2 — the honesty that must be present");
const data = text[join(APP, "js", "data.js")];
const index = text[join(APP, "index.html")];
const app = text[join(APP, "js", "app.js")];
const grades = text[join(APP, "js", "grades.js")];
ok(/No drug has ever been shown to extend human lifespan/.test(data), "the headline truth ships in data.js");
ok(/not medical advice/i.test(data), "the disclaimer ships in data.js");
ok(/not medical advice/i.test(index), "index.html footer carries the not-medical-advice line");
ok(/DISCLAIMER/.test(app) && /renderDossier/.test(app), "the dossier view renders the disclaimer");
ok(/No compound has ever earned this rung/.test(grades), "the ladder admits its empty top rung");
ok(/including every rigorous failure|rigorous failure/i.test(data), "the atlas advertises its failures, not just its hopes");

/* ————— 3. sourcing is structural ————— */
suite("content 3 — sourcing rules");
const urlCount = (data.match(/url: "https:\/\//g) || []).length;
const rowCount = (data.match(/finding:/g) || []).length;
ok(urlCount === rowCount, "every evidence row has exactly one https url (" + urlCount + "/" + rowCount + ")");
ok(!/url: "http:\/\//.test(data), "no plaintext-http source links");
ok((data.match(/titleCheck:/g) || []).length === rowCount, "every evidence row has a titleCheck for CI verification");
ok(!/grade:\s|rung:\s/.test(data), "no hand-typed grades anywhere in the corpus");

/* ————— 4. rendering is safe ————— */
suite("content 4 — untrusted data never becomes markup");
ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(app), "no HTML injection sinks in app.js");
ok(!/\beval\s*\(|new Function/.test(all), "no eval anywhere");
ok(/rel = "noopener"|rel="noopener"/.test(app), "external links open with noopener");
const fetches = (app.match(/fetch\(/g) || []).length;
ok(fetches === 1 && /fetch\(FEED_URL/.test(app), "the app fetches exactly one thing: its own feed");

/* ————— 5. the feed stays honest ————— */
suite("content 5 — the feed's honesty");
const feed = text[join(APP, "js", "feed.js")];
ok(/never\s*\n?\s*\* dressed up as a live sweep|not a live feed/.test(feed + app), "bundled fallback labels itself as not-live");
ok(/STALE/.test(feed), "a stale sweep says so");

console.log(failed ? "content: " + failed + " FAILED of " + checks : "content: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
