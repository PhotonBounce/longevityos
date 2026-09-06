/* content — the HONESTY lint. Dependency-free so it can gate before npm install.
 * Scans every shipped byte for the claims this app must never make. */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
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
ok(fetches === 1 && /fetch\(FEED_URL/.test(app), "the atlas view fetches exactly one thing: its own feed");

/* ————— 5. the feed stays honest ————— */
suite("content 5 — the feed's honesty");
const feed = text[join(APP, "js", "feed.js")];
ok(/never\s*\n?\s*\* dressed up as a live sweep|not a live feed/.test(feed + app), "bundled fallback labels itself as not-live");
ok(/STALE/.test(feed), "a stale sweep says so");

/* ————— 6. the screening engine may not claim more than it computes ————— */
suite("content 6 — what the swarm may never claim");
const SCREEN_BANNED = [
  [/\bdiscover(s|ed)? (a )?(new )?drugs?\b/i, "claiming the screen discovers drugs"],
  [/\bfound a (cure|drug|treatment)\b/i, "claiming a find"],
  [/\bwill extend (your |human )?li(fe|ves|fespan)\b/i, "promising life extension"],
  [/\bproves? (that )?(it|this) works\b/i, "claiming proof of efficacy"],
  [/\bpredicts? (binding|efficacy|potency)\b/i, "claiming a binding or efficacy prediction the engine does not make"],
  [/\bvalidated (drug|candidate|hit)\b/i, "calling a screening hit validated"],
  [/\bsafe (to take|for humans)\b/i, "safety claims about screened molecules"]
];
for (const [re, why] of SCREEN_BANNED) {
  ok(!re.test(all), "no shipped string is " + why + " (" + re + ")");
}

/* The toxicity rule is about the SCREENING surface only. A structural alert is
 * a triage flag — the swarm has measured nothing about toxicity and may never
 * imply it. The evidence atlas is the opposite case: when a published study
 * reports that a dose was toxic, saying so is the honest thing to do (and
 * data.js does, for metformin and dasatinib). So this scans the engine, the
 * Lab and the client — never the corpus. */
const SCREEN_SURFACE = files
  .filter((p) => p.includes("/chem/") || p.includes("/swarm/") || p.endsWith("lab.js"))
  .map((p) => text[p]).join("\n");
ok(!/\btoxic(ity)?\b(?!.*(alert|flag|triage|not a verdict|never|not measured))/i.test(SCREEN_SURFACE),
   "the screening surface never calls a molecule toxic — an alert is a triage flag, and the swarm measures no toxicity at all");
const chemFiles = files.filter((p) => p.includes("/chem/"));
const chemText = chemFiles.map((p) => text[p]).join("\n");
const lab = text[join(APP, "js", "lab.js")] || "";
const score = text[join(APP, "js", "chem", "score.js")] || "";
ok(chemFiles.length >= 6, `the chemistry engine ships (${chemFiles.length} modules)`);
ok(/hypothes/i.test(score + lab), "the engine and the Lab describe their output as hypotheses");
ok(/not (a )?(drug|discover|medical)/i.test(lab) || /shortlist/i.test(lab),
   "the Lab tells the visitor plainly what a hit is and is not");
ok(/triage|shortlist/i.test(score), "score.js states that it produces a triage shortlist, not a finding");
ok(/not docking|no docking|not.*binding prediction/i.test(score),
   "score.js is explicit about what it does NOT compute");

/* ————— 7. determinism is the trust model, so the screening path stays pure ————— */
suite("content 7 — screening-path purity");
for (const p of chemFiles) {
  const src = text[p];
  const name = p.split("/").pop();
  /* strip block comments so documentation about these hazards is not mistaken for using them */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/Math\.random/.test(code), `${name}: no Math.random on the screening path`);
  ok(!/Date\.now|new Date\(/.test(code), `${name}: no clock on the screening path`);
  ok(!/Math\.(log|exp|pow|sqrt|sin|cos|atan)/.test(code),
     `${name}: no transcendental math (engines round these differently — a digest would drift)`);
  ok(!/toLocaleString|Intl\./.test(code), `${name}: no locale-dependent formatting`);
  ok(!/\bfetch\s*\(|XMLHttpRequest/.test(code), `${name}: the chemistry engine never touches the network`);
}
ok(/sort\(/.test(score), "score.js sorts explicitly before digesting (iteration order can never leak in)");
ok(/Math\.floor/.test(score) && !/parseFloat\(/.test(score.replace(/\/\*[\s\S]*?\*\//g, "")),
   "the composite score is integer arithmetic");

/* ————— 8. donated CPU requires an explicit gesture ————— */
suite("content 8 — consent");
const client = text[join(APP, "js", "swarm", "client.js")] || "";
ok(client.length > 0, "the swarm client ships");
ok(!/^\s*start\(\)/m.test(client.replace(/\/\*[\s\S]*?\*\//g, "")) || /user gesture|explicit/i.test(client),
   "the client documents that it only runs on an explicit user action");
ok(!/addEventListener\(\s*["']load["'][^)]*start/.test(client) && !/window\.onload\s*=\s*[^;]*start\(/.test(client),
   "nothing auto-starts CPU donation on page load");
ok(/localStorage/.test(client) && /try\s*{/.test(client),
   "token storage is wrapped for browsers that refuse storage");

/* ————— 9. the Lab renders other people's text as text ————— */
suite("content 9 — the Lab treats server data as untrusted");
ok(lab.length > 0, "the Lab ships");
ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(lab),
   "no HTML sinks in lab.js — leaderboard names are written by strangers");
ok(/textContent/.test(lab), "the Lab renders via textContent");
ok(/\[0-9\]|\\d|Number\.isInteger|test\(/.test(lab),
   "the Lab validates ids before building external links (no open redirect from server text)");

/* ————— 10. the server: prepared statements, no leaked paths, fail-closed key ————— */
suite("content 10 — the swarm server's rules");
const apiDir = join(HERE, "..", "saas", "api");
if (existsSync(join(apiDir, "index.php"))) {
  const php = readFileSync(join(apiDir, "index.php"), "utf8") +
              (existsSync(join(apiDir, "db.php")) ? readFileSync(join(apiDir, "db.php"), "utf8") : "");
  const phpCode = php.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|#).*$/gm, "");
  ok(/prepare\s*\(/.test(phpCode), "the API uses prepared statements");
  ok(!/\$_(GET|POST|REQUEST)\[[^\]]+\]\s*\./.test(phpCode) &&
     !/(SELECT|INSERT|UPDATE|DELETE)[^;'"]*\$_(GET|POST|REQUEST)/i.test(phpCode),
     "no request value is concatenated into SQL");
  ok(/hash_equals/.test(phpCode), "the ingest key is compared with hash_equals (timing-safe)");
  ok(/403/.test(phpCode), "a missing or wrong key gets a 403 — the door fails closed");
  ok(!/display_errors\s*=\s*1|ini_set\(\s*['"]display_errors['"]\s*,\s*['"]?1/.test(phpCode),
     "errors are never displayed to the internet");
  ok(/sha256|hash\s*\(/.test(phpCode), "tokens are stored hashed, never in the clear");
  ok(!/\$_SERVER\['REMOTE_ADDR'\]\s*\)?\s*(,|\))/.test(phpCode) || /hash\s*\(\s*['"]sha256['"]\s*,\s*\$ip|hash\(.*REMOTE_ADDR/.test(phpCode),
     "a raw IP is never stored — only a hash, for rate limiting");
  const htaccess = existsSync(join(apiDir, ".htaccess")) ? readFileSync(join(apiDir, ".htaccess"), "utf8") : "";
  ok(/sqlite|data/i.test(htaccess), "the .htaccess blocks the database from the web");
} else {
  ok(false, "saas/api/index.php is missing — the swarm has no server");
}

console.log(failed ? "content: " + failed + " FAILED of " + checks : "content: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
