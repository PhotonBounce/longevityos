#!/usr/bin/env node
/* gen-audio — renders the console's instrument sounds and the spoken guide
 * on a RUNNER, never in the sandbox and never into git.
 *
 *   node tools/gen-audio.mjs              render whatever is missing or changed
 *   node tools/gen-audio.mjs --dry-run    print the plan, touch nothing, need no key
 *   node tools/gen-audio.mjs --lines      write qa/voice/lines.json from NARRATION (the voice contract)
 *   node tools/gen-audio.mjs --selftest   prove the offline half without a network
 *
 * INPUTS ARE THE APP'S OWN EXPORTS. The words come from NARRATION in
 * app/js/view/guide.js and the prompts from SFX in app/js/view/sound.js, so
 * the recording and the caption can never drift: change a word in the app and
 * that item's hash changes, and only that item is re-rendered.
 *
 * IDEMPOTENT ON HASH. app/audio/manifest.json records, per item, the sha256 of
 * the bytes, their size, and the hash of the inputs that produced them
 * (voice id | model | settings | text, or prompt | seconds | loop). An item
 * whose hash matches and whose file exists is skipped.
 *
 * FAIL CLOSED ON SIZE. An SFX over 200 KB or a voice line over 1 MB is
 * refused and reported — never written, never listed — because the page
 * loads these lazily on a phone and a fat file is a broken promise.
 *
 * THE KEY. `XI_KEY` in the environment, sent only as the xi-api-key header to
 * api.elevenlabs.io, never written anywhere, never logged. This sandbox has no
 * route to that host; the workflow that holds the key runs this on a runner
 * and FTP-uploads app/audio/. The .mp3 files and the manifest are gitignored.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATION } from "../app/js/view/guide.js";
import { SFX } from "../app/js/view/sound.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const AUDIO_DIR_DEFAULT = join(ROOT, "app", "audio");
const LINES_DEFAULT = join(ROOT, "qa", "voice", "lines.json");

const VOICE_ID_DEFAULT = "onwK4e9ZLuTAKqWW03F9";   // "Daniel" — calm documentary
const MODEL = "eleven_multilingual_v2";
const VOICE_SETTINGS = Object.freeze({ stability: 0.55, similarity_boost: 0.8, style: 0.0, use_speaker_boost: false });
const OUTPUT_FORMAT = "mp3_44100_64";
const PROMPT_INFLUENCE = 0.4;
const TTS_URL = (voiceId) => "https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(voiceId) + "?output_format=" + OUTPUT_FORMAT;
const SFX_URL = "https://api.elevenlabs.io/v1/sound-generation";
const CAP = Object.freeze({ sfx: 200 * 1024, voice: 1024 * 1024 });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* ————— the plan: what should exist, from the app's own exports ————— */

export function voiceLines() {
  const lines = { intro: NARRATION.intro };
  for (const k of Object.keys(NARRATION.pages).sort()) lines[k] = NARRATION.pages[k];
  return lines;
}

export function plan(voiceId = VOICE_ID_DEFAULT) {
  const items = [];
  const lines = voiceLines();
  for (const name of Object.keys(lines)) {
    const text = lines[name];
    items.push({
      kind: "voice", name, text, file: name + ".mp3",
      hash: sha256([voiceId, MODEL, JSON.stringify(VOICE_SETTINGS), text].join("|"))
    });
  }
  for (const s of SFX) {
    items.push({
      kind: "sfx", name: s.file, prompt: s.prompt, seconds: s.seconds, loop: s.loop === true, file: s.file + ".mp3",
      hash: sha256([s.prompt, String(s.seconds), String(s.loop === true)].join("|"))
    });
  }
  return items;
}

/* ————— request shapes (pure: build, never send) ————— */

export function ttsRequest(item, voiceId, key) {
  return {
    url: TTS_URL(voiceId),
    init: {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: item.text, model_id: MODEL, voice_settings: VOICE_SETTINGS })
    }
  };
}

export function sfxRequest(item, key) {
  return {
    url: SFX_URL,
    init: {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: item.prompt, duration_seconds: item.seconds, prompt_influence: PROMPT_INFLUENCE, loop: item.loop })
    }
  };
}

/* ————— the manifest ————— */

export function readManifest(dir) {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return { sfx: {}, voice: {} };
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return { sfx: v && typeof v.sfx === "object" && v.sfx ? v.sfx : {}, voice: v && typeof v.voice === "object" && v.voice ? v.voice : {} };
  } catch (_) { return { sfx: {}, voice: {} }; }
}

export function isCurrent(item, manifest, dir) {
  const e = manifest[item.kind] && manifest[item.kind][item.name];
  if (!e || e.hash !== item.hash || e.file !== item.file) return false;
  const p = join(dir, item.kind, item.file);
  if (!existsSync(p)) return false;
  try { return statSync(p).size === e.bytes; } catch (_) { return false; }
}

function writeManifest(dir, manifest, voiceId) {
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const out = { generated_at: new Date().toISOString(), voice_id: voiceId, model: MODEL, output_format: OUTPUT_FORMAT, sfx: sorted(manifest.sfx), voice: sorted(manifest.voice) };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

/* ————— rendering ————— */

/* run(): renders every stale item through `fetchImpl`, writes files + manifest,
 * and returns a report. Never throws for a single item's failure; an oversized
 * or failed item is listed under `refused` and the run's `ok` is false. */
/* A refusal that says only "HTTP 400" cannot be acted on. The service's own
 * error body says which field it disliked, and that body is the service
 * talking about the REQUEST — it never contains the key — but it is redacted
 * and capped anyway, because a tool that prints a remote server's bytes into
 * a public CI log should never be the reason a secret escapes. */
const KEY_SHAPED = /\b(sk_[A-Za-z0-9_-]{8,}|xi-api-key\s*[:=]\s*\S+|[0-9a-f]{32,})\b/gi;
export function detailOf(text) {
  if (typeof text !== "string" || text === "") return "";
  const clean = text.replace(KEY_SHAPED, "[redacted]").replace(/\s+/g, " ").trim();
  return clean ? " — " + clean.slice(0, 300) : "";
}
async function bodyText(res) {
  if (!res || typeof res.text !== "function") return "";
  try { return await res.text(); } catch (_) { return ""; }
}

export async function run({ dir = AUDIO_DIR_DEFAULT, voiceId = VOICE_ID_DEFAULT, key = "", fetchImpl = globalThis.fetch, dryRun = false, log = () => {} } = {}) {
  const items = plan(voiceId);
  const manifest = readManifest(dir);
  const todo = items.filter((it) => !isCurrent(it, manifest, dir));
  const report = { total: items.length, current: items.length - todo.length, planned: todo.map((t) => t.kind + "/" + t.name), rendered: [], refused: [], ok: true, dryRun };
  for (const it of todo) log(`plan  ${it.kind.padEnd(5)} ${it.name.padEnd(14)} ${it.kind === "voice" ? it.text.split(/\s+/).length + " words" : it.seconds + " s" + (it.loop ? " loop" : "")}`);
  if (dryRun) return report;
  if (!todo.length) { log("nothing to render — every item is current"); return report; }
  if (!key) { report.ok = false; report.refused.push({ name: "*", reason: "XI_KEY is not set — refusing before any request" }); return report; }
  if (typeof fetchImpl !== "function") { report.ok = false; report.refused.push({ name: "*", reason: "no fetch available" }); return report; }
  for (const it of todo) {
    const req = it.kind === "voice" ? ttsRequest(it, voiceId, key) : sfxRequest(it, key);
    let bytes = null, reason = "";
    try {
      const res = await fetchImpl(req.url, req.init);
      if (!res || !res.ok) reason = "HTTP " + (res && res.status) + detailOf(await bodyText(res));
      else bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      reason = "request failed: " + (err && err.code ? err.code : "error");   // never the message: it could carry a URL with a key in it
    }
    if (!bytes) { report.ok = false; report.refused.push({ name: it.kind + "/" + it.name, reason }); log(`fail  ${it.kind}/${it.name}: ${reason}`); continue; }
    if (bytes.length > CAP[it.kind]) {
      report.ok = false;
      report.refused.push({ name: it.kind + "/" + it.name, reason: `${bytes.length} bytes exceeds the ${CAP[it.kind]} byte cap — not written` });
      log(`refuse ${it.kind}/${it.name}: ${bytes.length} bytes over the cap`);
      continue;
    }
    if (bytes.length < 64) { report.ok = false; report.refused.push({ name: it.kind + "/" + it.name, reason: "too small to be audio" }); continue; }
    mkdirSync(join(dir, it.kind), { recursive: true });
    writeFileSync(join(dir, it.kind, it.file), bytes);
    manifest[it.kind][it.name] = { file: it.file, sha256: sha256(bytes), bytes: bytes.length, hash: it.hash };
    report.rendered.push(it.kind + "/" + it.name);
    log(`wrote ${it.kind}/${it.file} (${bytes.length} bytes)`);
  }
  writeManifest(dir, manifest, voiceId);
  return report;
}

/* ————— the voice contract file ————— */

export function linesJson() {
  const lines = voiceLines();
  const words = Object.fromEntries(Object.keys(lines).map((k) => [k, lines[k].trim().split(/\s+/).length]));
  return JSON.stringify({ generated_from: "app/js/view/guide.js NARRATION", model: MODEL, voice_settings: VOICE_SETTINGS, lines, words }, null, 2) + "\n";
}

export function writeLines(path = LINES_DEFAULT) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, linesJson());
  return path;
}

/* ————— selftest: the offline half, proven without a network ————— */

async function selftest() {
  let checks = 0, failed = 0;
  const ok = (c, m) => { checks++; if (!c) { failed++; console.error("  ✗ " + m); } };
  const tmp = mkdtempSync(join(tmpdir(), "los-audio-"));
  try {
    /* 1. the fetch landmine: nothing offline may touch the network */
    let fetched = 0;
    const landmine = () => { fetched++; throw new Error("landmine: fetch was called offline"); };
    const items = plan("voice-test");
    ok(items.length === Object.keys(NARRATION.pages).length + 1 + SFX.length, "the plan covers every narration line and every SFX (" + items.length + ")");
    ok(items.every((it) => /^[a-z0-9-]+\.mp3$/.test(it.file)), "every file name is a bare lower-case name — never a path");
    const dry = await run({ dir: tmp, fetchImpl: landmine, dryRun: true });
    ok(dry.planned.length === items.length && fetched === 0, "--dry-run plans everything and never fetches");
    const noKey = await run({ dir: tmp, fetchImpl: landmine, key: "" });
    ok(noKey.ok === false && fetched === 0 && /XI_KEY/.test(noKey.refused[0].reason), "no key ⇒ refused before any request");
    const linesPath = join(tmp, "lines.json");
    writeLines(linesPath);
    const parsed = JSON.parse(readFileSync(linesPath, "utf8"));
    ok(parsed.lines.intro === NARRATION.intro, "--lines carries the intro verbatim");
    ok(Object.keys(NARRATION.pages).every((k) => parsed.lines[k] === NARRATION.pages[k]), "--lines carries every page line verbatim");
    ok(Object.keys(parsed.lines).length === Object.keys(NARRATION.pages).length + 1, "--lines carries nothing that is not in NARRATION");
    ok(linesJson() === linesJson(), "--lines output is deterministic");
    ok(fetched === 0, "the landmine was never stepped on");

    /* 2. hash stability */
    const h1 = plan("v1").find((i) => i.kind === "voice" && i.name === "intro").hash;
    const expected = sha256(["v1", MODEL, JSON.stringify(VOICE_SETTINGS), NARRATION.intro].join("|"));
    ok(h1 === expected, "a voice hash is sha256(voiceId|model|settings|text)");
    ok(plan("v2").find((i) => i.name === "intro").hash !== h1, "a different voice id is a different hash");
    const s = SFX[0];
    const hs = plan().find((i) => i.kind === "sfx" && i.name === s.file).hash;
    ok(hs === sha256([s.prompt, String(s.seconds), String(s.loop)].join("|")), "an SFX hash is sha256(prompt|seconds|loop)");

    /* 3. request shapes, built and never sent */
    const voiceItem = items.find((i) => i.kind === "voice" && i.name === "lab");
    const tts = ttsRequest(voiceItem, "VOICE123", "KEY");
    ok(tts.url === "https://api.elevenlabs.io/v1/text-to-speech/VOICE123?output_format=mp3_44100_64", "TTS URL: text-to-speech/<voiceId>?output_format=mp3_44100_64");
    const ttsBody = JSON.parse(tts.init.body);
    ok(tts.init.method === "POST" && tts.init.headers["xi-api-key"] === "KEY", "TTS is a POST with the xi-api-key header");
    ok(ttsBody.text === NARRATION.pages.lab && ttsBody.model_id === "eleven_multilingual_v2", "TTS body: the exact line + eleven_multilingual_v2");
    ok(JSON.stringify(ttsBody.voice_settings) === JSON.stringify({ stability: 0.55, similarity_boost: 0.8, style: 0, use_speaker_boost: false }), "TTS voice settings: 0.55 / 0.8 / 0.0 / no boost");
    const sfxItem = items.find((i) => i.kind === "sfx" && i.name === "room-tone");
    const sr = sfxRequest(sfxItem, "KEY");
    const sfxBody = JSON.parse(sr.init.body);
    ok(sr.url === "https://api.elevenlabs.io/v1/sound-generation" && sr.init.method === "POST", "SFX URL: sound-generation, POST");
    ok(sfxBody.text === sfxItem.prompt && sfxBody.duration_seconds === 12 && sfxBody.prompt_influence === 0.4 && sfxBody.loop === true, "SFX body: prompt, duration_seconds, prompt_influence 0.4, loop");
    ok(!JSON.stringify(plan()).includes("KEY"), "the plan never carries a key");

    /* 4. fixture bytes: a fake endpoint, a full render, then idempotence */
    let calls = 0;
    const fakeBytes = (n) => { const b = Buffer.alloc(n); b.write("ID3", 0); for (let i = 3; i < n; i++) b[i] = (i * 7) & 255; return b; };
    const fake = async (url) => { calls++; const n = /sound-generation/.test(url) ? 4096 : 12288; return { ok: true, status: 200, arrayBuffer: async () => fakeBytes(n) }; };
    const r1 = await run({ dir: tmp, key: "KEY", fetchImpl: fake, voiceId: "V" });
    ok(r1.ok && r1.rendered.length === items.length && calls === items.length, "a full render writes every item (" + r1.rendered.length + ")");
    const man = JSON.parse(readFileSync(join(tmp, "manifest.json"), "utf8"));
    ok(man.voice_id === "V" && typeof man.generated_at === "string", "the manifest records the voice id and a timestamp");
    ok(Object.keys(man.sfx).length === SFX.length && Object.keys(man.voice).length === Object.keys(NARRATION.pages).length + 1, "the manifest lists every SFX and every voice line");
    const e = man.sfx["console-wake"];
    const fileBytes = readFileSync(join(tmp, "sfx", e.file));
    ok(e.file === "console-wake.mp3" && e.bytes === fileBytes.length && e.sha256 === sha256(fileBytes) && e.hash === hs, "each entry carries file, bytes, sha256 of the bytes and the input hash");
    ok(!readFileSync(join(tmp, "manifest.json"), "utf8").includes("KEY"), "the manifest never contains the key");
    const r2 = await run({ dir: tmp, key: "KEY", fetchImpl: fake, voiceId: "V" });
    ok(r2.ok && r2.rendered.length === 0 && calls === items.length, "a second run is idempotent: nothing re-rendered, nothing fetched");
    /* a changed input re-renders exactly that item */
    const r3 = await run({ dir: tmp, key: "KEY", fetchImpl: fake, voiceId: "V2" });
    ok(r3.rendered.length === Object.keys(NARRATION.pages).length + 1 && r3.rendered.every((n) => n.startsWith("voice/")), "a new voice id re-renders every voice line and no SFX");
    /* a deleted file re-renders exactly that item */
    rmSync(join(tmp, "sfx", "idle.mp3"));
    const r4 = await run({ dir: tmp, key: "KEY", fetchImpl: fake, voiceId: "V2" });
    ok(r4.rendered.length === 1 && r4.rendered[0] === "sfx/idle", "a missing file is re-rendered on its own");

    /* 5. the caps */
    const fat = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => fakeBytes(/sound-generation/.test(url) ? CAP.sfx + 1 : CAP.voice + 1) });
    const tmp2 = mkdtempSync(join(tmpdir(), "los-audio-fat-"));
    const r5 = await run({ dir: tmp2, key: "KEY", fetchImpl: fat });
    ok(r5.ok === false && r5.refused.length === items.length && r5.rendered.length === 0, "every oversized item is refused (" + r5.refused.length + ")");
    ok(!existsSync(join(tmp2, "sfx")) && !existsSync(join(tmp2, "voice")), "an oversized file is never written");
    ok(Object.keys(readManifest(tmp2).sfx).length === 0, "an oversized item never enters the manifest");
    const under = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => fakeBytes(/sound-generation/.test(url) ? CAP.sfx : CAP.voice) });
    const tmp3 = mkdtempSync(join(tmpdir(), "los-audio-cap-"));
    const r6 = await run({ dir: tmp3, key: "KEY", fetchImpl: under });
    ok(r6.ok && r6.rendered.length === items.length, "a file exactly at the cap is accepted");
    rmSync(tmp2, { recursive: true, force: true });
    rmSync(tmp3, { recursive: true, force: true });

    /* 6. failures are reported, never thrown, and never carry a message */
    const boom = async () => { const err = new Error("https://api.elevenlabs.io/?key=KEY"); err.code = "ECONNREFUSED"; throw err; };
    const tmp4 = mkdtempSync(join(tmpdir(), "los-audio-boom-"));
    const r7 = await run({ dir: tmp4, key: "KEY", fetchImpl: boom });
    ok(r7.ok === false && r7.refused.every((x) => /ECONNREFUSED/.test(x.reason) && !/KEY/.test(x.reason)), "a network failure is reported by code, never by message");
    rmSync(tmp4, { recursive: true, force: true });

    /* 7. a refusal carries the service's own reason — redacted and capped */
    ok(detailOf('{"detail":{"status":"invalid_uid","message":"A voice ID is required"}}') === ' — {"detail":{"status":"invalid_uid","message":"A voice ID is required"}}',
       "an error body is appended verbatim so a 400 can be acted on");
    ok(!/sk_live/.test(detailOf('{"message":"bad key sk_live_abcdefgh12345678"}')) && /\[redacted\]/.test(detailOf('{"message":"bad key sk_live_abcdefgh12345678"}')),
       "a key-shaped string in the body is redacted before it reaches a log");
    ok(!/[0-9a-f]{32}/.test(detailOf("token " + "a1".repeat(20))), "a long hex string is redacted too");
    ok(detailOf("x".repeat(900)).length <= 304, "the detail is capped (" + detailOf("x".repeat(900)).length + " chars)");
    ok(detailOf("") === "" && detailOf(null) === "", "no body, no detail");
    const four00 = async () => ({ ok: false, status: 400, text: async () => '{"detail":{"status":"voice_not_found"}}' });
    const tmp5 = mkdtempSync(join(tmpdir(), "los-audio-400-"));
    const r8 = await run({ dir: tmp5, key: "KEY", fetchImpl: four00 });
    ok(r8.ok === false && r8.refused.every((x) => /HTTP 400 — .*voice_not_found/.test(x.reason)), "a 400 is refused WITH what the service said: " + (r8.refused[0] && r8.refused[0].reason));
    rmSync(tmp5, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `gen-audio selftest: ${failed} FAILED of ${checks}` : `gen-audio selftest: ${checks} checks passed ✓`);
  process.exit(failed ? 1 : 0);
}

/* ————— CLI ————— */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  if (flag("--selftest")) {
    await selftest();
  } else if (flag("--lines")) {
    const p = writeLines(value("--out") || LINES_DEFAULT);
    console.log("wrote " + p);
  } else {
    const dir = value("--audio-dir") || AUDIO_DIR_DEFAULT;
    const voiceId = process.env.LOS_VOICE_ID || VOICE_ID_DEFAULT;
    const report = await run({ dir, voiceId, key: process.env.XI_KEY || "", dryRun: flag("--dry-run"), log: (l) => console.log(l) });
    console.log(`gen-audio: ${report.total} items, ${report.current} current, ${report.rendered.length} rendered, ${report.refused.length} refused${report.dryRun ? " (dry run)" : ""}`);
    for (const r of report.refused) console.error("  refused " + r.name + ": " + r.reason);
    process.exit(report.ok ? 0 : 1);
  }
}
