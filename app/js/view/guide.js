/* guide — the spoken guide and its transcript (4.0, spec §9).
 *
 * ONE voice, mission control at 3 a.m., one line per page. The scripts below
 * are THE contract: tools/gen-audio.mjs renders exactly these words on a
 * runner, qa/voice/lines.json is generated from them, and qa/voice.mjs proves
 * script and recording list are identical both ways. Change a word here and
 * the recording is regenerated; change it anywhere else and the gate fails.
 *
 * THE CAPTION IS THE TRUTH. The transcript panel renders from NARRATION
 * whether or not a single byte of audio exists; the recording is decoration.
 * Press-to-play only: no line ever plays on its own, not on load, not on a tab
 * change, not because a preference was remembered. The only `new Audio(` in
 * this module is inside the press handler. Nothing is fetched — not the
 * manifest, not a file — until a person presses.
 *
 * The header's speaker control also lives here (it is the one place every
 * tab shares), delegating the sound state to viewSoundBoard so the header,
 * the Lab and the wizard all report the same truth.
 */

import { viewSoundBoard } from "./sound.js";

export const NARRATION = Object.freeze({
  intro:
    "This is LongevityOS. No drug has ever been shown to extend human lifespan; that sentence is why this " +
    "instrument exists. An atlas of every compound people call an immortality drug, failures beside hopes. " +
    "A ledger of what has lowered death rates in people, and what has not. And the Lab, where your browser " +
    "compares newly harvested molecules against drugs that did something in a longevity experiment. Two " +
    "strangers' machines must agree before anything is recorded. What comes out is a shortlist of hypotheses " +
    "for researchers. Not a drug. Not advice. Nothing runs until you press the button.",
  pages: Object.freeze({
    atlas:
      "Every compound people call an immortality drug, with the published evidence beside it — including the " +
      "failures. Each badge is computed from the rows underneath it, never typed in. Notice what sits on the " +
      "top rung: nothing.",
    evidence:
      "Interventions with human all-cause-mortality data, and every rigorous null and harm on the same " +
      "footing. Each result belongs to the people that trial enrolled. Nothing here is advice; the numbers are " +
      "reported exactly as published.",
    lab:
      "The screening console. Under the lens, a real molecule is drawn as your browser scores it — chosen by " +
      "position, never by score. The readouts are its similarity to known actives, its drug-likeness, its " +
      "triage flags. Nothing is donated until you press the button.",
    observatory:
      "Every instrument the swarm has, in one room. Molecules screened each hour, how much of the pool is " +
      "left, how scores are distributed, how often two volunteers agreed — and how often they did not. Every " +
      "chart has its numbers printed underneath.",
    ladder:
      "Organism and outcome decide the rung; nothing else does. Read it downward and notice the top rung: " +
      "nothing at all. That empty rung is the most honest thing in the app.",
    feed:
      "A literature sweep of recent papers on the compounds in this atlas. When it is stale, the page says " +
      "stale. When there is no live sweep, it shows the atlas's own citation library and labels it as " +
      "exactly that.",
    sources:
      "Every citation, linked to its primary source. Continuous integration re-fetches each link and checks " +
      "the article title. A dead or wrong link fails the build.",
    wizard:
      "Eight short steps: pace, screen and power, a name, a team, sound. Nothing starts until the last step, " +
      "and every choice can be changed afterwards."
  })
});

/* The page titles the transcript prints — words, never keys. */
const PAGE_TITLE = Object.freeze({
  intro: "Introduction",
  atlas: "Atlas",
  evidence: "What has evidence",
  lab: "The Lab",
  observatory: "Observatory",
  ladder: "The Ladder",
  feed: "Fresh findings",
  sources: "Sources",
  wizard: "Setup wizard"
});
/* tabs that share a page's line */
const ALIAS = Object.freeze({ dossier: "atlas" });

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

function isPlainObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

export function viewGuide(mount, options) {
  if (!mount || typeof mount.appendChild !== "function") return { onTab() {}, destroy() {} };
  const opts = isPlainObject(options) ? options : {};
  const base = typeof opts.base === "string" && opts.base ? opts.base : "audio/";
  const sound = viewSoundBoard({ base });

  const st = {
    page: "atlas",       // the page whose line the transcript shows
    showing: "page",     // "page" | "intro"
    open: sound.prefs().voice,   // the panel is open when the guide is on, or when opened by hand
    voice: null,         // the Audio playing right now, if any
    playing: "",         // which line is playing
    played: new Set(),   // lines pressed this visit (one line per page per visit)
    note: ""             // what the last press did, as text
  };

  /* ————— the bar ————— */

  const bar = el("div", "guide-bar");
  bar.setAttribute("data-guide", "bar");

  const speaker = el("button", "guide-btn guide-speaker");
  speaker.type = "button";
  speaker.setAttribute("data-guide", "speaker");
  speaker.addEventListener("click", (ev) => {
    /* THE speaker: a press turns instrument sounds on (and spends the gesture
     * on the spot) or off. The board refuses a synthesised event. */
    const p = sound.prefs();
    if (!p.sfx) {
      sound.setPref("sfx", true);
      sound.enable(ev);
    } else {
      sound.setPref("sfx", false);
    }
    paint();
  });
  bar.appendChild(speaker);

  const guideBtn = el("button", "guide-btn guide-toggle");
  guideBtn.type = "button";
  guideBtn.setAttribute("data-guide", "toggle");
  guideBtn.addEventListener("click", () => {
    st.open = !st.open;
    st.note = "";
    paint();
  });
  bar.appendChild(guideBtn);

  const voiceBtn = el("button", "guide-btn guide-voicepref");
  voiceBtn.type = "button";
  voiceBtn.setAttribute("data-guide", "voicepref");
  voiceBtn.addEventListener("click", () => {
    const on = !sound.prefs().voice;
    sound.setPref("voice", on);
    if (on) st.open = true;
    paint();
  });
  bar.appendChild(voiceBtn);

  mount.appendChild(bar);

  /* ————— the transcript panel ————— */

  const panel = el("section", "guide-panel");
  panel.setAttribute("data-guide", "panel");
  panel.setAttribute("aria-label", "Spoken guide transcript");
  const head = el("div", "guide-head");
  const title = el("span", "guide-title");
  head.appendChild(title);
  const which = el("span", "guide-which");
  head.appendChild(which);
  panel.appendChild(head);
  const text = el("p", "guide-text");
  text.setAttribute("data-guide", "text");
  panel.appendChild(text);
  const acts = el("div", "guide-acts");
  const playBtn = el("button", "guide-btn guide-play");
  playBtn.type = "button";
  playBtn.setAttribute("data-guide", "play");
  playBtn.addEventListener("click", (ev) => { speak(ev); });
  acts.appendChild(playBtn);
  const introBtn = el("button", "guide-btn guide-intro");
  introBtn.type = "button";
  introBtn.setAttribute("data-guide", "intro");
  introBtn.addEventListener("click", () => {
    st.showing = st.showing === "intro" ? "page" : "intro";
    st.note = "";
    paint();
  });
  acts.appendChild(introBtn);
  const stopBtn = el("button", "guide-btn guide-stop", "Stop");
  stopBtn.type = "button";
  stopBtn.setAttribute("data-guide", "stop");
  stopBtn.addEventListener("click", () => { stopVoice(); st.note = "stopped"; paint(); });
  acts.appendChild(stopBtn);
  const note = el("span", "guide-note");
  note.setAttribute("data-guide", "note");
  acts.appendChild(note);
  panel.appendChild(acts);
  mount.appendChild(panel);

  function currentKey() { return st.showing === "intro" ? "intro" : st.page; }
  function lineFor(key) { return key === "intro" ? NARRATION.intro : (NARRATION.pages[key] || ""); }

  function stopVoice() {
    const a = st.voice;
    st.voice = null;
    st.playing = "";
    if (a) { try { a.pause(); } catch (_) {} }
  }

  /* speak(ev): THE press. The manifest is asked for here, for the first time
   * if need be, and the element is built here — after a trusted gesture and
   * nowhere else. A page with no recording says so in text and plays nothing. */
  async function speak(ev) {
    if (!ev || ev.isTrusted !== true) return;      // a script cannot press this button
    const key = currentKey();
    if (!lineFor(key)) return;
    stopVoice();
    st.note = "looking for the recording…";
    paint();
    let url = null;
    try { await sound.ensureManifest(); url = sound.voiceFile(key); } catch (_) { url = null; }
    if (!url) {
      st.note = "no recording on this build — the text above is the whole line";
      paint();
      return;
    }
    try {
      const a = new Audio(url);   // inside the press, after the manifest said the file exists
      a.preload = "auto";
      st.voice = a;
      st.playing = key;
      st.played.add(key);
      st.note = "playing";
      a.addEventListener("ended", () => { if (st.voice === a) { st.voice = null; st.playing = ""; st.note = "finished"; paint(); } });
      a.addEventListener("error", () => { if (st.voice === a) { st.voice = null; st.playing = ""; st.note = "the recording could not be played — the text above is the whole line"; paint(); } });
      const p = a.play();
      if (p && typeof p.catch === "function") p.catch(() => { if (st.voice === a) { st.voice = null; st.playing = ""; st.note = "the browser refused to play — the text above is the whole line"; paint(); } });
    } catch (_) {
      st.voice = null;
      st.playing = "";
      st.note = "the recording could not be played — the text above is the whole line";
    }
    paint();
  }

  function paint() {
    const p = sound.prefs();
    speaker.textContent = "Sound: " + sound.label();
    speaker.setAttribute("aria-pressed", p.sfx ? "true" : "false");
    guideBtn.textContent = st.open ? "Hide the guide" : "Show the guide";
    guideBtn.setAttribute("aria-expanded", st.open ? "true" : "false");
    voiceBtn.textContent = "Spoken guide: " + (p.voice ? "on — press play on any page" : "off");
    voiceBtn.setAttribute("aria-pressed", p.voice ? "true" : "false");

    panel.hidden = !st.open;
    const key = currentKey();
    title.textContent = key === "intro" ? "The introduction" : "This page";
    which.textContent = PAGE_TITLE[key] || "";
    text.textContent = lineFor(key) || "No spoken line for this page.";
    playBtn.textContent = st.playing === key ? "Playing…" : (st.played.has(key) ? "Play again" : "Play this line");
    playBtn.disabled = !lineFor(key);
    introBtn.textContent = st.showing === "intro" ? "Back to this page's line" : "The introduction";
    stopBtn.hidden = !st.voice;
    note.textContent = st.note;
  }

  function onTab(key) {
    const k = typeof key === "string" ? (ALIAS[key] || key) : "atlas";
    if (k !== st.page) {
      st.page = k;
      st.showing = "page";
      st.note = "";
      stopVoice();   // a line belongs to the page it was pressed on
    }
    paint();
  }

  /* the wizard (or any view) can announce a page it owns */
  const onPageEvent = (ev) => { try { if (ev && ev.detail && typeof ev.detail.key === "string") onTab(ev.detail.key); } catch (_) {} };
  try { document.addEventListener("los-page", onPageEvent); } catch (_) {}
  const unsub = sound.onChange(() => paint());

  paint();
  const api = {
    onTab,
    destroy() {
      stopVoice();
      unsub();
      try { document.removeEventListener("los-page", onPageEvent); } catch (_) {}
      try { bar.remove(); panel.remove(); } catch (_) {}
    },
    /* QA surface */
    state: () => ({ page: st.page, showing: st.showing, open: st.open, playing: st.playing, played: [...st.played], note: st.note })
  };
  try { if (typeof window !== "undefined") window.__losGuide = api; } catch (_) {}
  return api;
}
