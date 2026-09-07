/* voice — the narration contract (4.0, spec §9).
 *
 * NARRATION (app/js/view/guide.js) and qa/voice/lines.json — the file the
 * runner-side generator renders from — must be identical both ways: every
 * page in NARRATION is in lines.json with the same words, every line in
 * lines.json is in NARRATION, and regenerating lines.json from the app
 * produces the committed bytes. Then the scripts themselves: one line per
 * page, every page present, ≤ 55 words each (intro ≤ 110), and none of the
 * phrases the copy lint bans. Then the SFX table: eleven events, one loop, no
 * event keyed to a score, and every entry the generator needs. */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATION } from "../app/js/view/guide.js";
import { SFX } from "../app/js/view/sound.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");
const words = (s) => s.trim().split(/\s+/).length;

const PAGES = ["atlas", "evidence", "lab", "observatory", "ladder", "feed", "sources", "wizard"];
const LINES = join(HERE, "voice", "lines.json");

/* ————— 1. the contract file, both ways ————— */
suite("voice 1 — NARRATION ↔ lines.json, both ways");
ok(existsSync(LINES), "qa/voice/lines.json is committed");
const committed = existsSync(LINES) ? readFileSync(LINES, "utf8") : "";
let lines = null;
try { lines = JSON.parse(committed).lines; } catch (_) { lines = null; }
ok(lines && typeof lines === "object", "lines.json parses and carries `lines`");
if (lines) {
  ok(lines.intro === NARRATION.intro, "the intro is identical");
  for (const k of PAGES) ok(lines[k] === NARRATION.pages[k], "line for " + k + " is identical");
  for (const k of Object.keys(lines)) ok(k === "intro" || Object.prototype.hasOwnProperty.call(NARRATION.pages, k), "lines.json carries nothing NARRATION does not (" + k + ")");
  ok(Object.keys(lines).length === PAGES.length + 1, "the same number of lines both ways (" + Object.keys(lines).length + ")");
}
const tmp = mkdtempSync(join(tmpdir(), "los-voice-"));
try {
  const out = join(tmp, "lines.json");
  execFileSync(process.execPath, [join(ROOT, "tools", "gen-audio.mjs"), "--lines", "--out", out], { stdio: "pipe" });
  const regenerated = readFileSync(out, "utf8");
  ok(regenerated === committed, "regenerating lines.json from the app reproduces the committed bytes (run `npm run lines` in qa/ if a script changed)");
} finally { rmSync(tmp, { recursive: true, force: true }); }

/* ————— 2. the scripts ————— */
suite("voice 2 — the scripts");
ok(Object.keys(NARRATION.pages).length === PAGES.length && PAGES.every((k) => typeof NARRATION.pages[k] === "string" && NARRATION.pages[k].length > 40), "every page has one line: " + PAGES.join(", "));
ok(Object.isFrozen(NARRATION) && Object.isFrozen(NARRATION.pages), "NARRATION is frozen");
ok(words(NARRATION.intro) <= 110, "intro ≤ 110 words (" + words(NARRATION.intro) + ")");
for (const k of PAGES) ok(words(NARRATION.pages[k]) <= 55, k + " ≤ 55 words (" + words(NARRATION.pages[k]) + ")");
const all = [NARRATION.intro, ...PAGES.map((k) => NARRATION.pages[k])].join("\n");
const BANNED = [
  [/\b(mining|miner|mine)\b/i, "mining"],
  [/\b(streak|combo|jackpot|rare find|level up|loot)\b/i, "casino vocabulary"],
  [/\b(discovery|discovered|breakthrough|found a drug)\b/i, "a discovery or breakthrough"],
  [/\byou should\b|\bwe recommend\b/i, "advice"],
  [/\b(cure|effective|safe|proven)\b/i, "cure / effective / safe / proven"],
  [/\b(thousands of machines|millions of molecules)\b/i, "an unmeasured scale"],
  [/\bexpired\b/i, "'expired'"],
  [/\bone in (two|three|four|five|ten)\b/i, "a fixed sampling ratio"],
  [/\b(sentient|conscious|alive)\b/i, "sentience words"]
];
for (const [re, why] of BANNED) ok(!re.test(all), "no script contains " + why + " (" + re + ")");
ok(/No drug has ever been shown to extend human lifespan/.test(NARRATION.intro), "the intro carries the headline truth");
ok(/Not a drug\. Not advice\./.test(NARRATION.intro), "the intro says: Not a drug. Not advice.");
ok(/Nothing runs until you press the button/.test(NARRATION.intro) && /Nothing is donated until you press the button/.test(NARRATION.pages.lab), "the intro and the Lab line both end on consent");
ok(/never typed in/.test(NARRATION.pages.atlas) && /nothing at all/.test(NARRATION.pages.ladder), "the emphasised phrases are in their lines: 'never typed in', 'nothing at all'");
ok(/chosen by position, never by score/.test(NARRATION.pages.lab), "the Lab line states the sampling rule");
ok(/how often they did not/.test(NARRATION.pages.observatory), "the Observatory line admits disagreements");
ok(/Eight short steps/.test(NARRATION.pages.wizard) && /Nothing starts until the last step/.test(NARRATION.pages.wizard), "the wizard line names its consent rule");
for (const k of ["intro", ...PAGES]) {
  const s = k === "intro" ? NARRATION.intro : NARRATION.pages[k];
  ok(/[.!?]$/.test(s.trim()), k + " ends on a full stop (the voice needs a real pause)");
  ok(!/[<>{}]/.test(s), k + " carries no markup");
}

/* ————— 3. the SFX table ————— */
suite("voice 3 — the SFX table");
ok(Object.isFrozen(SFX) && SFX.length === 11, "eleven instrument sounds, frozen (" + SFX.length + ")");
ok(new Set(SFX.map((s) => s.file)).size === 11, "eleven distinct file keys");
ok(SFX.every((s) => /^[a-z-]+$/.test(s.file) && typeof s.event === "string" && s.event && typeof s.prompt === "string" && s.prompt.length > 20 && typeof s.seconds === "number" && s.seconds > 0 && typeof s.loop === "boolean"), "every entry has event, file, prompt, seconds and loop");
ok(SFX.filter((s) => s.loop).length === 1 && SFX.find((s) => s.loop).file === "room-tone", "room tone is the only loop");
ok(SFX.every((s) => s.loop || s.seconds <= 1.5), "every one-shot is 1.5 s or shorter");
ok(SFX.every((s) => !/score|hit|jackpot|win|triumph/i.test(s.event)), "no event is keyed to a score or a win");
ok(SFX.every((s) => !/music|melody|fanfare|alarm|buzzer/i.test(s.prompt.replace(/no (music|melody|alarm|buzzer)/gi, ""))), "no prompt asks for music, a fanfare, an alarm or a buzzer");
/* Every duration the app asks for must be one the generator will render: the
 * sound-generation endpoint takes 0.5–30 s and refuses the rest. The two ticks
 * were written at 0.25 and 0.18 and a runner refused them after paying for the
 * eighteen items around them; their prompts now put the transient at the start
 * of the shortest renderable clip, so what a visitor hears is unchanged. */
const EXPECTED = { "console-wake": 1.4, "unit-issued": 0.5, "molecule-lock": 0.5, "unit-submitted": 0.6, confirmed: 1.2, conflict: 0.7, idle: 0.5, "link-lost": 0.6, "wizard-step": 0.5, stopped: 0.5, "room-tone": 12 };
for (const [file, seconds] of Object.entries(EXPECTED)) { const s = SFX.find((x) => x.file === file); ok(s && s.seconds === seconds, file + " is " + seconds + " s"); }

console.log(failed ? "voice: " + failed + " FAILED of " + checks : "voice: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
