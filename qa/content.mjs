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
  .filter((p) => p.includes("/chem/") || p.includes("/swarm/") || p.includes("/view/") || p.endsWith("lab.js"))
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

/* ————— 11. the human-evidence ledger (3.0) ————— */
suite("content 11 — the ledger of what has evidence in people");
const evidencePath = join(APP, "js", "evidence.js");
if (existsSync(evidencePath)) {
  const ev = text[evidencePath];
  ok(/not medical advice/i.test(ev), "the ledger says, in its own headline, that it is not medical advice");
  ok(/people like those in the trial/.test(ev), "the ledger frames every result as 'in people like those in the trial'");
  ok((ev.match(/url: "https:\/\//g) || []).length === (ev.match(/finding:/g) || []).length, "every evidence row has exactly one https source");
  ok((ev.match(/titleCheck:/g) || []).length === (ev.match(/finding:/g) || []).length, "every evidence row has a titleCheck for CI to verify");
  ok(!/url: "http:\/\//.test(ev), "no plaintext-http citation in the ledger");
  ok(!/\brung\s*:|\bgrade\s*:/.test(ev), "rungs are computed, never typed into the ledger");
  ok(/NULL \/ HARM/.test(text[join(APP, "js", "app.js")] || ""), "nulls and harms wear a badge that says so");
  ok((ev.match(/outcome: "(null|harm)"/g) || []).length >= 7, "the ledger carries at least seven rigorous nulls or harms");
} else {
  ok(false, "app/js/evidence.js is missing — the app claims to show what has evidence in people");
}
/* advice verbs are banned app-wide, not only in the ledger */
ok(!/\byou should\b/i.test(all), "the app never tells anyone what they should do");
ok(!/\bwe recommend\b/i.test(all), "the app never recommends anything");
ok(!/serviceWorker\.register/.test(all), "no service worker — the app is served fresh and the deploy is upload-only");

{ /* section 12 scope */
/* ————— 12. the Observatory (4.0): the console's rules ————— */
suite("content 12 — the console: motion, markup, copy");
const obsPath = join(APP, "css", "observatory.css");
ok(existsSync(obsPath), "css/observatory.css ships");
const obs = text[obsPath] || "";
const obsCode = obs.replace(/\/\*[\s\S]*?\*\//g, "");
/* the four forbidden effects — the whole page must stay cheap enough to run
 * beside a screening worker on a phone */
for (const prop of ["filter", "backdrop-filter", "mix-blend-mode", "text-shadow"]) {
  ok(!new RegExp("(^|[\\s;{])" + prop.replace("-", "\\-") + "\\s*:", "m").test(obsCode), "observatory.css never sets " + prop);
}
/* nothing animates or transitions width/height/top/left: transform + opacity only */
ok(!/transition\s*:[^;]*\b(width|height|top|left)\b/.test(obsCode), "observatory.css never transitions width/height/top/left");
{
  const frames = obsCode.match(/@keyframes[^{]*\{[\s\S]*?\}\s*\}/g) || [];
  ok(frames.length >= 4, "observatory.css names its keyframes (" + frames.length + ")");
  ok(frames.every((f) => !/\b(width|height|top|left)\s*:/.test(f)), "no keyframe animates width/height/top/left");
  for (const name of ["obs-grow", "obs-flip", "obs-swap", "obs-bloom"]) {
    ok(new RegExp("@keyframes\\s+" + name + "\\b").test(obsCode), "keyframe " + name + " is defined");
  }
  /* reduced motion REDEFINES the keyframes as fades rather than switching them off */
  const rm = obsCode.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)/);
  ok(!!rm, "observatory.css has a prefers-reduced-motion block");
  const rmBody = rm ? rm[1] : "";
  for (const name of ["obs-grow", "obs-flip", "obs-swap", "obs-bloom"]) {
    ok(new RegExp("@keyframes\\s+" + name + "\\s*\\{[^}]*opacity[^}]*\\}").test(rmBody), "reduced motion redefines " + name + " as an opacity fade");
  }
  ok(/html\[data-still\]/.test(obsCode), "the in-page 'Hold the instruments still' switch (html[data-still]) is honoured");
  ok(/\.is-parked/.test(obsCode) && /animation-play-state\s*:\s*paused/.test(obsCode), "off-screen panels can be parked");
  ok(/html\[data-dpr="2"\]/.test(obsCode) && /mask-image/.test(obsCode), "the dot-matrix mask is gated on html[data-dpr=\"2\"]");
}
/* the view modules: createElement + textContent only, exports prefixed */
const viewDir = join(APP, "js", "view");
const viewFiles = files.filter((p) => p.startsWith(viewDir + "/") && p.endsWith(".js"));
ok(viewFiles.length >= 2, "js/view/ ships its modules (" + viewFiles.length + ")");
for (const p of viewFiles) {
  const name = "js/view/" + p.split("/").pop();
  const src = text[p];
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), name + ": no HTML sinks");
  ok(!/parseSmiles\s*\(/.test(src), name + ": never calls parseSmiles( — molFromSmiles is the only door");
  const names = [];
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) for (const sp of m[1].split(",")) { const t = sp.trim().split(/\s+as\s+/).pop(); if (t) names.push(t); }
  ok(names.length > 0 && names.every((n) => /^view[A-Z]/.test(n) || /^[A-Z][A-Z0-9_]*$/.test(n)),
     name + ": every export is view* or UPPER_CASE data (" + names.join(", ") + ")");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  ok(!/\.start\s*\(\s*\)/.test(code), name + ": never starts the client — CPU is the Lab's two handlers' business");
}
/* the strip: mounted once in index.html, the only poller, no polling left in lab.js */
ok(/<div id="strip"><\/div>/.test(index), "index.html carries the #strip mount under #nav");
ok(index.indexOf('id="nav"') < index.indexOf('id="strip"') && index.indexOf('id="strip"') < index.indexOf('id="view"'), "#strip sits between #nav and #view");
ok(/css\/observatory\.css/.test(index), "index.html links observatory.css");
ok(/data-dpr/.test(index), "index.html sets html[data-dpr] for the dot-matrix mask");
ok(/viewTelemetry\(\$\("#strip"\)/.test(app), "app.js mounts the strip once at boot");
ok(!/setInterval/.test(lab.replace(/\/\*[\s\S]*?\*\//g, "")), "lab.js has no polling timer of its own — telemetry.js is the only poller");
ok(!/apiGet\("(stats|hits|history)"/.test(lab), "lab.js never fetches stats/hits/history itself");
ok(/viewTelemetry\.subscribe/.test(lab), "lab.js subscribes to the telemetry store");
const telemetry = text[join(viewDir, "telemetry.js")] || "";
ok(/If-None-Match/.test(telemetry) && /304/.test(telemetry), "telemetry.js revalidates with If-None-Match and understands 304");
ok(/aria-live", "off"/.test(telemetry), "the strip is aria-live=off (the log is the accessible reading)");
ok(/hud-log/.test(telemetry) && /toISOString/.test(telemetry), "the 20-line log carries UTC timestamps");
ok(/visibilitychange/.test(telemetry), "polling is suspended while the document is hidden");
/* the parking is real: the observer lives in js/view and the Lab hands it its panels */
const ledSrc = text[join(viewDir, "led.js")] || "";
ok(/IntersectionObserver/.test(ledSrc) && /is-parked/.test(ledSrc) && (lab.match(/viewPark\(/g) || []).length >= 3, "off-screen parking is implemented, not just styled: IntersectionObserver in js/view/led.js, viewPark() on the Lab's panels");
/* the queue that feeds the strip is bounded and a stop clears it */
ok(/QUEUE_PER_TAG/.test(telemetry) && /trimQueue\(/.test(telemetry) && /viewTelemetry\.drop\("LAB"\)/.test(lab), "the strip's frame queue is bounded per tag and the Lab drops a finished run's frames on stop");
/* no count-up: nothing in the view or the Lab tweens a number toward a target */
ok(!/requestAnimationFrame/.test(text[join(viewDir, "led.js")] || "x") && !/requestAnimationFrame/.test(lab), "no rAF loop drives a readout — numbers roll old → new in one step");
/* the LED text twin is structural: every led svg is followed by its twin */
ok(/led-text/.test(text[join(viewDir, "led.js")] || ""), "led.js emits the visible .led-text twin");

/* THE WORD RULE. The activity is "screening" and the ask is "set up this
 * browser" — never mining: the roadmap's own token-optics argument applied to
 * words. Word boundaries keep "determine", "vitamin", "spermine" legal. This
 * scans COPY: string literals and comments in JS, whole files for HTML/CSS. */
const MINE_RE = /\bmin(e|er|ers|ing|es)\b/i;
function copyOf(p, src) {
  if (!p.endsWith(".js")) return src;
  const out = [];
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] || m[2] || m[3] || "");
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) out.push(m[0]);
  return out.join("\n");
}
for (const p of files) {
  const hit = copyOf(p, text[p]).match(MINE_RE);
  ok(!hit, "app/" + p.slice(APP.length + 1) + " never calls the activity mining (" + (hit ? hit[0] : "") + ")");
}
/* the rest of the §12 checklist, app-wide */
for (const [re, why] of [
  [/\b(streak|combo|jackpot|level[- ]?up|loot)\b/i, "game-loop vocabulary (streak/combo/jackpot/level up/loot)"],
  [/\bbreakthrough\b/i, "'breakthrough'"],
  [/\bthousands of machines\b|\bmillions of molecules\b/i, "an unmeasured scale"],
  [/\bexpired\b/i, "'expired'"]
]) {
  ok(!re.test(files.map((p) => copyOf(p, text[p])).join("\n")), "no shipped copy uses " + why);
}
}
{ /* section 13 scope */
/* ————— 13. the Observatory (4.0): the lens, the spotlight, the view modules ————— */
suite("content 13 — the lens draws what was scored, chosen by position, and moves only as allowed");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const viewFiles = files.filter((p) => p.includes("/js/view/") && p.endsWith(".js"));
ok(viewFiles.length >= 2, "js/view/ ships (" + viewFiles.length + " modules)");
for (const p of viewFiles) {
  const name = p.split("/").pop();
  const src = text[p];
  const code = strip(src);
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), `${name}: no HTML sinks — server text renders as text`);
  ok(!/parseSmiles\s*\(/.test(code), `${name}: never calls parseSmiles( — the only door is molFromSmiles, the engine's own`);
  /* the two sanctioned exceptions: telemetry.js IS the app's only poller (section 12
   * proves lab.js delegates to it), and sound.js fetches the audio manifest only
   * after an arming gesture (section 14 proves the gesture) */
  if (!/telemetry\.js$|sound\.js$/.test(name)) ok(!/\bfetch\s*\(|XMLHttpRequest/.test(code), `${name}: no network — a view draws, it never polls`);
  ok(!/\.start\s*\(/.test(code), `${name}: no .start( — a view can never donate CPU`);
  ok(!/new\s+(Audio|AudioContext|webkitAudioContext)\b/.test(code), `${name}: constructs no audio`);
  ok(!/requestAnimationFrame/.test(code), `${name}: no rAF loop — every phase is a timer`);
  ok(!/\beval\s*\(|new Function/.test(code), `${name}: no eval`);
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    ok(/^view[A-Z]/.test(m[1]) || /^[A-Z][A-Z0-9_]*$/.test(m[1]), `${name}: export '${m[1]}' is prefixed view* or is UPPER_CASE data`);
  }
  ok(!/\b(mining|miner|mine)\b/i.test(src), `${name}: never calls the activity mining`);
  ok(!/\b(streak|combo|jackpot|level up|loot|rare find)\b/i.test(src), `${name}: no game-economy words`);
  ok(!/\b(discover(y|ed|s)?|breakthrough)\b/i.test(src), `${name}: no discovery language`);
  ok(!/one in (\d|five|ten|twenty|forty|a hundred)/i.test(src), `${name}: no fixed sampling ratio — the caption computes it`);
  ok(!/✓|\bclean\b/.test(src), `${name}: zero flags is never a tick or 'clean'`);
}
/* string literals are wrapped across lines with " + "; join them before matching sentences */
const lensSrc = (text[join(APP, "js", "view", "lens.js")] || "").replace(/"\s*\+\s*\n\s*"/g, "");
const layoutSrc = text[join(APP, "js", "view", "layout.js")] || "";
ok(/Triage flags\. They mark a molecule for a person to look at; the screen has measured nothing about what any of them mean in a living thing\./.test(lensSrc),
   "the lens carries the triage sentence verbatim");
ok(/no drug-likeness flags raised/.test(lensSrc), "zero flags prints 'no drug-likeness flags raised'");
ok(/chosen by its position in the work unit and never by its score/.test(lensSrc), "the sampling caption states the selection rule");
ok(/DID NOT PARSE — scored as unparseable, score 0\./.test(lensSrc), "the unparseable card is verbatim");
ok(/the drawing was refused — it is larger than the lens draws, or its coordinates did not resolve\. The score beside it is the real one\./.test(lensSrc),
   "the refused card is verbatim");
ok(/worth a look/.test(lensSrc) && />= WORTH_A_LOOK|>= 700/.test(lensSrc), "700 and above says 'worth a look' — words, no sound, no bloom");
ok(/import \{ molFromSmiles \} from "\.\.\/chem\/aromatic\.js"/.test(layoutSrc) && /import \{ perceivedRings \} from "\.\.\/chem\/descriptors\.js"/.test(layoutSrc),
   "layout.js imports only the engine's own front door and ring perception");
ok((layoutSrc.match(/^import /gm) || []).length === 2, "layout.js has exactly those two imports");
ok(/createElementNS/.test(lensSrc) && /textContent/.test(lensSrc), "the lens builds SVG with createElementNS and writes text with textContent");

/* the spotlight: position, never a score; a counter, never a clock */
const workerSrc = text[join(APP, "js", "swarm", "worker.js")] || "";
const workerCode = strip(workerSrc);
ok(!/Date\.now|new Date\(|Math\.random/.test(workerCode), "worker.js still touches no clock and no randomness");
ok(/const SPOTLIGHT_EVERY = 40;/.test(workerCode) && /chunkCounter\s*%\s*SPOTLIGHT_EVERY === 0/.test(workerCode), "the spotlight fires on every fortieth chunk — a chunk counter, never a clock (grep-able)");
ok(/spotlight\(id, i, slice\[0\], r\)/.test(workerCode), "…and it is the first molecule of that chunk: position, never a score");
ok(!/unitCounter/.test(workerCode), "no per-unit spotlight remains (the lens shows one per 2.2 s at most; screening more would be waste)");
ok(!/score\s*[<>=!]|[<>=!]=?\s*[\w.]*\bscore\b/.test(workerCode), "worker.js never compares anything against a score");
ok(!/\.sort\s*\(/.test(workerCode), "worker.js never sorts — nothing is ranked on the way to the lens");
ok(/type: "spotlight"/.test(workerCode), "the worker posts the spotlight message");
const clientCode = strip(text[join(APP, "js", "swarm", "client.js")] || "");
ok(/localChunkCounter\s*%\s*SPOTLIGHT_EVERY === 0/.test(clientCode) && /const SPOTLIGHT_EVERY = 40;/.test(clientCode), "the main-thread fallback picks its spotlight by the same chunk-counter rule");
ok(!/\.score\b/.test(clientCode), "client.js never reads a score");
ok(/spotlight/.test(text[join(APP, "js", "swarm", "client.js")].split("export function")[0]), "the client documents the spotlight event");

/* the lens stylesheet: only transform/opacity/dashoffset move; reduced motion is honoured by redefinition */
const lensCss = (text[join(APP, "css", "lens.css")] || "").replace(/\/\*[\s\S]*?\*\//g, "");
ok(lensCss.length > 0, "lens.css ships");
ok(!/(^|[^-])filter\s*:|backdrop-filter|mix-blend-mode|text-shadow/.test(lensCss), "lens.css uses no filter, backdrop-filter, mix-blend-mode or text-shadow");
for (const m of lensCss.matchAll(/transition\s*:\s*([^;]+);/g)) {
  ok(!/\b(width|height|top|left|right|bottom|margin|padding)\b/.test(m[1]), "no transition animates layout: " + m[1].trim());
}
for (const m of lensCss.matchAll(/@keyframes[^{]*\{([\s\S]*?)\}\s*\}/g)) {
  ok(!/\b(width|height|top|left|right|bottom|margin|padding)\s*:/.test(m[1]), "no keyframe animates layout");
}
ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*@keyframes obs-grow[\s\S]*opacity/.test(lensCss), "prefers-reduced-motion REDEFINES the wave keyframe as an opacity fade");
ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.lens-bar-track i \{ transition: none; \}/.test(lensCss), "…and the bars set transition: none");
ok(/html\[data-still\]/.test(lensCss), "the in-page 'hold the instruments still' switch is honoured by the same rules");
ok(!/animation[^;]*(score|amber)/.test(lensCss), "no animation is keyed to a score");
ok(!/serviceWorker/.test(all) && fetches === 1, "app.js still fetches exactly one thing");

}
{ /* section 15 scope */
/* ————— 13. the Observatory (4.0): fifteen figures, their tables open, their copy honest ————— */
suite("content 15 — the Observatory: every figure named, every table open, nothing 'expired'");
{
  const stripSrc = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const obsPath = join(APP, "js", "view", "observatory.js");
  const chartsPath = join(APP, "js", "view", "charts.js");
  const obs = text[obsPath] || "";
  const charts = text[chartsPath] || "";
  ok(obs.length > 0 && charts.length > 0, "js/view/observatory.js and js/view/charts.js ship");
  const FIGURES = ["SWEEP", "CONFIRMED PER DAY", "THE POOL", "SCORE SPECTRUM", "TARGET BOARD", "CONSENSUS METER", "WITNESSES", "INTEGRITY",
                   "PEOPLE", "FRESHNESS CLOCKS", "FLAG LEDGER", "TEAM BOARD / CONTRIBUTOR BOARD", "YOUR SCOPE", "SESSION LEDGER", "BANDWIDTH"];
  for (const f of FIGURES) ok(new RegExp('title: "' + f.replace(/[/]/g, "\\/") + '"').test(obs), `figure "${f}" exists in observatory.js`);
  ok((obs.match(/\bn: (\d+), title: "/g) || []).length === 15, "exactly fifteen numbered figures are painted");
  for (const s of ["No screening recorded in this window.", "The pool is empty — the harvest runs daily.", "No verified hits yet.", "No canary units answered yet."]) {
    ok(obs.includes(s), `the empty state is verbatim: "${s}"`);
  }
  ok(/Two independent volunteers must produce the same fingerprint before a unit counts\./.test(obs), "the consensus sentence is verbatim");
  ok(/MEASURED ON THIS DEVICE — LOCAL ONLY/.test(obs), "YOUR SCOPE says where its numbers come from");
  ok(/IN PROGRESS/.test(charts) && /PARTIAL DAY/.test(obs), "the current hour and today are labelled in words");
  ok(/"YOUR TEAM"/.test(obs) && /"you"/.test(obs), "the visitor's own rows are marked in words, not colour alone");
  ok(/never by a score|count, not a ranking by score/.test(obs), "the target board says it counts, never ranks by score");
  for (const [p, name] of [[obsPath, "observatory.js"], [chartsPath, "charts.js"]]) {
    const src = text[p], code = stripSrc(src);
    ok(!/\bexpired?\b/i.test(src), `${name} never says 'expired' — that is a word for a coupon`);
    ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(code), `${name}: no HTML sinks — every server string is textContent`);
    ok((name === "charts.js" ? /createElementNS/.test(code) : /createElement\(/.test(code)) && /textContent/.test(code), `${name} builds with createElement(NS) and writes with textContent`);
    ok(!/\.start\s*\(/.test(code), `${name} never calls .start( — the Observatory reads, it cannot donate`);
    ok(!/new\s+(Audio|AudioContext|webkitAudioContext)\b/.test(code), `${name} constructs no audio`);
    ok(!/requestAnimationFrame/.test(code), `${name} has no rAF loop`);
    ok(!/toLocaleString|Intl\./.test(code), `${name} formats numbers without the locale`);
    ok(!/\b(mining|miner|mine)\b/i.test(src), `${name} never calls the activity mining`);
    ok(!/\b(streak|combo|jackpot|level up|loot|rare find)\b/i.test(src), `${name}: no game-economy words`);
    ok(!/\b(discover(y|ed|s)?|breakthrough)\b/i.test(src), `${name}: no discovery language`);
    ok(!/✓|\bclean\b/.test(src), `${name}: no tick and no 'clean'`);
    ok(!/one in (\d|five|ten|twenty|forty|a hundred)/i.test(src), `${name}: no fixed sampling ratio`);
    for (const m of src.matchAll(/^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      ok(/^view[A-Z]/.test(m[1]) || /^[A-Z][A-Z0-9_]*$/.test(m[1]), `${name}: export '${m[1]}' is prefixed view* or is UPPER_CASE data`);
    }
  }
  /* no <details> is ever created closed: the one constructor sets open, and nothing unsets it */
  ok(/el\("details"/.test(charts) && /det\.open = true/.test(charts) && /det\.setAttribute\("open", ""\)/.test(charts), "the only <details> constructor opens it");
  ok(!/\.open = false|removeAttribute\("open"\)|\.open=false/.test(stripSrc(charts) + stripSrc(obs)), "nothing closes a <details>");
  ok(!/createElement\("details"/.test(stripSrc(obs)), "observatory.js creates no <details> of its own");
  /* 4.0 integration: the room has NO poller of its own — it subscribes to the
   * telemetry store (the strip), which is the app's only poller; nothing in it
   * may request anything, and nothing in it may reference a token */
  const obsCode = stripSrc(obs);
  ok(/import \{ viewTelemetry \} from "\.\/telemetry\.js"/.test(obs), "observatory.js imports the telemetry store");
  ok(/viewTelemetry\.subscribe\(/.test(obsCode) && /viewTelemetry\.snapshot\(\)/.test(obsCode), "the room subscribes to the store and reads its snapshot");
  ok((obsCode.match(/fetch\(/g) || []).length === 0 && !/XMLHttpRequest/.test(obsCode), "observatory.js never fetches — the strip is the only poller");
  ok(!/(apiBase|API_BASE)\s*\+/.test(obsCode) && !/"\?a="\s*\+/.test(obsCode), "the room builds no request URL of any kind (work, join, me or otherwise)");
  ok(!/\.start\s*\(/.test(obsCode), "nothing in observatory.js starts the client");
  ok(!/fetch\(/.test(stripSrc(charts)), "charts.js draws; it never polls");
  /* the stylesheet: nothing that costs a frame, and reduced motion honoured */
  const css = (text[join(APP, "css", "charts.css")] || "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(css.length > 0, "charts.css ships");
  ok(!/(^|[^-])filter\s*:|backdrop-filter|mix-blend-mode|text-shadow/.test(css), "charts.css uses no filter, backdrop-filter, mix-blend-mode or text-shadow");
  for (const m of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
    ok(!/\b(width|height|top|left|right|bottom|margin|padding)\b/.test(m[1]), "no transition animates layout: " + m[1].trim());
  }
  ok(!/@keyframes/.test(css), "charts.css declares no keyframes — nothing on the Observatory moves unless a number changed");
  ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none/.test(css) && /html\[data-still\][\s\S]*transition: none/.test(css), "reduced motion and 'hold the instruments still' stop the one transition");
  ok(/\.obs-ledbar-fill\s*\{[^}]*transition:\s*transform 320ms/.test(css) && /void list\.offsetWidth/.test(stripSrc(charts)) && /was\[labelText\]/.test(stripSrc(charts)), "the LED-bar fill's 320 ms slide is real: charts.js carries the old scale across a rebuild and flushes once before setting the new one");
  ok(/min-height: 44px/.test(css.slice(css.indexOf(".obs-numbers-sum"), css.indexOf("}", css.indexOf(".obs-numbers-sum")))), "the 'Read the numbers' summary is a 44 px target");
  ok(!/animation[^;]*(score|amber)/.test(css), "no animation is keyed to a score");
  /* the wiring: the tab, the dist order, the Lab's hooks; app.js still fetches exactly one thing */
  ok(/\["observatory", "Observatory"\]/.test(app) && /viewObservatory\(root/.test(app), "app.js has the Observatory tab and renders it through viewObservatory");
  ok(fetches === 1, "app.js still fetches exactly one thing (the Observatory's reads live in js/view/)");
  ok(/viewObservatory\.session\(ev\)/.test(lab) && /type: "record"/.test(lab), "lab.js feeds the client's events and the ?a=me record to the Observatory");
  const dist = readFileSync(join(HERE, "..", "tools", "dist.mjs"), "utf8");
  const order = dist.slice(dist.indexOf("const ORDER"), dist.indexOf("];", dist.indexOf("const ORDER")));
  ok(order.indexOf("js/chem/score.js") < order.indexOf("js/view/charts.js") && order.indexOf("js/view/charts.js") < order.indexOf("js/view/observatory.js") && order.indexOf("js/view/observatory.js") < order.indexOf("js/lab.js"),
     "dist.mjs bundles charts.js then observatory.js after the engine and before lab.js");
  ok(/duplicate export/.test(dist), "dist.mjs fails hard on a duplicate export");
  ok(/css\/charts\.css/.test(dist) && /css\/charts\.css/.test(index), "charts.css is linked and bundled");
  /* the server side of the same feature */
  const php = existsSync(join(apiDir, "index.php")) ? readFileSync(join(apiDir, "index.php"), "utf8") : "";
  ok(/case 'history':\s*action_history/.test(php) && /function action_history/.test(php), "the server dispatches ?a=history");
  ok(/los_bw_count\(strlen\(\$json\)\)/.test(php), "every JSON body is counted by the bandwidth meter");
  ok(/los_meta_incr\(\$db, 'bw:day:'/.test(php) && /function los_meta_incr/.test(readFileSync(join(apiDir, "db.php"), "utf8")), "the meter increments atomically (los_meta_incr) — it runs outside any transaction");
  ok(/\$flags = null;[\s\S]{0,1500}'flags'\s*=>\s*\$flags/.test(php), "?a=hits sends null, not [], for a flags value it cannot read");
  ok(/define\('LOS_BW_BUDGET', 2147483648\)/.test(php), "the daily bandwidth budget defaults to 2 GB");
  ok(/'canary:ok'/.test(php) && /'canary:bad'/.test(php), "canary counters are incremented in submit");
  ok(/CREATE TABLE IF NOT EXISTS history/.test(readFileSync(join(apiDir, "db.php"), "utf8")) && /ix_contrib_seen/.test(readFileSync(join(apiDir, "db.php"), "utf8")), "db.php creates the history table and the last_seen index idempotently");
}

}
console.log(failed ? "content: " + failed + " FAILED of " + checks : "content: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
