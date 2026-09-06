/* phone — "everyone can mine": the Lab on a phone, proven in a real browser.
 *
 * A Pixel 5 (Playwright's device descriptor: viewport, touch, mobile UA,
 * scale factor) opens the app against a MOCK swarm server that speaks the 3.0
 * contract — join/work/submit plus teams, the personal record, the public
 * contributor record and leave. The phone-only browser APIs the Lab reaches
 * for (Screen Wake Lock, the Battery Status API) do not exist in headless
 * Chromium, so they are stubbed at context level with their state exposed on
 * window.__stubs, which is how the suite can assert WHEN a wake lock was
 * requested and released and what an unplugged battery does to the loop.
 *
 * What is proven, in order: nothing starts on load; the wake lock is a
 * gesture-only thing and is released on stop; the charging gate pauses and
 * resumes correctly (and never resumes something that was not running); the
 * pace dial spaces requests; teams are created, shared, joined, listed and
 * left; ?team= and ?c= deep links open the Lab on the right thing; badges
 * count units; leaving takes two presses and forgets the token; the PWA
 * manifest and icons are real; zero page errors; and hostile server text
 * never becomes markup.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { chromium, devices } from "playwright";
import { referenceSet } from "../app/js/chem/score.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SHOTS = join(HERE, "shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0, failed = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failed++; console.error("  ✗ " + msg); } };
const suite = (name) => console.log("── " + name + " ──");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}

const refs = referenceSet();
const MOLS = [
  { id: "1", smiles: "CC(=O)OC1=CC=CC=C1C(=O)O" },
  { id: "2", smiles: "CN(C)C(=N)NC(=N)N" },
  { id: "3", smiles: "CN1C=NC2=C1C(=O)N(C)C(=O)N2C" }
];

/* ————— the mock swarm server (the 3.0 contract) ————— */

const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const mock = {
  hits: {},              // action → count
  workAt: [],            // timestamps of every ?a=work
  contributors: new Map(),
  teams: new Map(),
  nextId: 1,
  nextTeam: 1,
  unitCounter: 0,
  hostile: false,        // when true: every string the server sends is hostile
  teamCodesAsked: []     // every code ?a=team was asked for
};
const hit = (a) => { mock.hits[a] = (mock.hits[a] || 0) + 1; };
function mintCode(n) {
  let seed = (n * 1000003 + 12345) >>> 0;
  let out = "";
  for (let i = 0; i < 8; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; out += ALPHABET[(seed >>> 16) & 31]; }
  return out;
}
const HOSTILE = {
  name: '<img src=x onerror="document.body.setAttribute(\'data-pwned\',\'1\')">',
  bidi: "‮admin‬ ​ghost",
  long: "A".repeat(5000),
  teamName: "<script>document.body.setAttribute('data-pwned','2')</script>",
  code: "../../etc/passwd"
};
const byToken = (t) => [...mock.contributors.values()].find((c) => c.token === t) || null;
const teamMembers = (code) => [...mock.contributors.values()].filter((c) => c.team === code);
function teamView(code) {
  const t = mock.teams.get(code);
  if (!t) return null;
  const m = teamMembers(code);
  return {
    code: mock.hostile ? HOSTILE.code : t.code,
    name: mock.hostile ? HOSTILE.teamName : t.name,
    members: m.length,
    units: m.reduce((s, c) => s + c.units, 0),
    credits: m.reduce((s, c) => s + c.credits, 0),
    created_at: t.created_at
  };
}
function nameOf(c, i) {
  if (!mock.hostile) return c.name;
  return [HOSTILE.name, HOSTILE.bidi, HOSTILE.long][i % 3];
}
function rankOf(c) {
  const visible = [...mock.contributors.values()].filter((x) => !x.hidden).sort((a, b) => b.credits - a.credits || a.id - b.id);
  return visible.findIndex((x) => x.id === c.id) + 1;
}
function contributorView(c, withRank) {
  const v = {
    id: c.id, name: nameOf(c, c.id), units: c.units, credits: c.credits, created_at: c.created_at,
    team: c.team ? { code: mock.hostile ? HOSTILE.code : c.team, name: mock.hostile ? HOSTILE.teamName : mock.teams.get(c.team).name } : null
  };
  if (withRank) v.rank = rankOf(c);
  return v;
}
function board() {
  const rows = [...mock.contributors.values()].filter((c) => !c.hidden && c.units > 0)
    .sort((a, b) => b.credits - a.credits || a.id - b.id).slice(0, 20)
    .map((c, i) => ({ name: nameOf(c, i), units: c.units, credits: c.credits }));
  if (mock.hostile) {
    /* far more rows than the contract allows, every one of them hostile */
    for (let i = 0; i < 60; i++) rows.push({ name: [HOSTILE.name, HOSTILE.bidi, HOSTILE.long][i % 3], units: 1e17, credits: "NaN" });
  }
  return rows;
}

function api(req, res, url, body) {
  const a = url.searchParams.get("a") || (body && body.a) || "";
  hit(a);
  const out = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  const fail = (code, status) => out(status, { error: code });
  const auth = () => {
    const c = byToken(String((body && body.token) || url.searchParams.get("token") || ""));
    if (!c) fail("unknown_token", 401);
    return c;
  };
  if (a === "join") {
    const id = mock.nextId++;
    const c = { id, name: String((body && body.name) || "anonymous").slice(0, 24) || "anonymous", token: ("tok" + id).padEnd(32, "0"),
      units: 0, credits: 0, created_at: 1700000000 + id * 86400, team: null, hidden: false };
    mock.contributors.set(id, c);
    return out(200, { token: c.token, contributor: id, name: c.name });
  }
  if (a === "work") {
    mock.workAt.push(Date.now());
    const c = auth(); if (!c) return;
    mock.unitCounter++;
    return out(200, { unit: { unit_id: "u-" + mock.unitCounter, engine: refs.engine, targets_digest: refs.targetsDigest, molecules: MOLS } });
  }
  if (a === "submit") {
    const c = auth(); if (!c) return;
    c.units++; c.credits += 5;
    return out(200, { accepted: true, credited: 5, status: "pending" });
  }
  if (a === "stats") {
    const teams = [...mock.teams.keys()].map(teamView).sort((x, y) => y.credits - x.credits).slice(0, 10);
    return out(200, { totals: { harvested: 1044, screened: 900, verified: 3, contributors: mock.contributors.size, units_open: 12 }, leaderboard: board(), teams });
  }
  if (a === "hits") return out(200, { hits: [] });
  if (a === "me") {
    const c = auth(); if (!c) return;
    return out(200, { contributor: contributorView(c, false) });
  }
  if (a === "contributor") {
    const raw = url.searchParams.get("id") || "";
    if (!/^[1-9][0-9]{0,11}$/.test(raw)) return fail("bad_id", 400);
    const c = mock.contributors.get(Number(raw));
    if (!c || c.hidden) return fail("unknown_contributor", 404);
    return out(200, { contributor: contributorView(c, true) });
  }
  if (a === "team") {
    const code = String(url.searchParams.get("code") || "").toUpperCase();
    mock.teamCodesAsked.push(code);
    if (!CODE_RE.test(code)) return fail("bad_code", 400);
    const t = teamView(code);
    if (!t) return fail("unknown_team", 404);
    return out(200, { team: t, board: teamMembers(code).map((c, i) => ({ name: nameOf(c, i), units: c.units, credits: c.credits })).slice(0, 20) });
  }
  if (a === "team_create") {
    const c = auth(); if (!c) return;
    const name = String((body && body.name) || "").trim();
    if (!name || name.length > 24) return fail("bad_name", 400);
    if (c.team) return fail("already_in_team", 409);
    const code = mintCode(mock.nextTeam++);
    mock.teams.set(code, { code, name, created_at: 1700500000 });
    c.team = code;
    return out(200, { team: teamView(code) });
  }
  if (a === "team_join") {
    const c = auth(); if (!c) return;
    const code = String((body && body.code) || "").toUpperCase();
    if (!CODE_RE.test(code)) return fail("bad_code", 400);
    if (!mock.teams.has(code)) return fail("unknown_team", 404);
    if (c.team) return fail("already_in_team", 409);
    if (teamMembers(code).length >= 20) return fail("team_full", 409);
    c.team = code;
    return out(200, { team: teamView(code) });
  }
  if (a === "team_leave") {
    const c = auth(); if (!c) return;
    c.team = null;
    return out(200, { ok: true });
  }
  if (a === "leave") {
    const c = auth(); if (!c) return;
    c.hidden = true;
    return out(200, { ok: true });
  }
  return fail("unknown_action", 400);
}

/* ————— serve app/ + the mock ————— */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml"
};
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname.startsWith("/mock-api/")) {
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 65536) req.destroy(); });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch (_) { body = null; }
      api(req, res, url, body);
    });
    return;
  }
  let p = url.pathname;
  if (p === "/" || p === "/app/") p = "/app/index.html";
  if (p === "/data/feed.json") { res.writeHead(404); res.end(); return; }
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;
const APP = BASE + "/app/index.html";

/* ————— the phone ————— */

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const pageErrors = [];

/* Stubs for the two phone APIs headless Chromium does not have. Their state is
 * on window.__stubs so the suite can read it and drive it. */
function stubs() {
  const st = { wakeRequests: 0, wakeReleases: 0, sentinels: [], charging: true, chargingListeners: [], batteryCalls: 0 };
  window.__stubs = st;
  window.__LOS_API = "/mock-api/";
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async (type) => {
        st.wakeRequests++;
        const listeners = [];
        const s = {
          type,
          released: false,
          release: async () => {
            if (s.released) return;
            s.released = true;
            st.wakeReleases++;
            for (const l of listeners) { try { l(); } catch (_) {} }
          },
          addEventListener: (name, fn) => { if (name === "release") listeners.push(fn); }
        };
        st.sentinels.push(s);
        return s;
      }
    }
  });
  const battery = {
    get charging() { return st.charging; },
    level: 0.5,
    addEventListener: (name, fn) => { if (name === "chargingchange") st.chargingListeners.push(fn); },
    removeEventListener: () => {}
  };
  Object.defineProperty(navigator, "getBattery", { configurable: true, value: async () => { st.batteryCalls++; return battery; } });
  st.setCharging = (v) => {
    st.charging = !!v;
    for (const l of st.chargingListeners) { try { l({ type: "chargingchange" }); } catch (_) {} }
  };
}

async function phoneContext(extra) {
  const ctx = await browser.newContext(Object.assign({}, devices["Pixel 5"], extra || {}));
  await ctx.addInitScript(stubs);
  return ctx;
}

function watch(page, tag) {
  page.on("pageerror", (e) => pageErrors.push(tag + ": " + String(e)));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const src = (m.location() && m.location().url) || "";
    /* the mock's deliberate 4xx answers, the missing feed and the favicon are
     * the paths under test or browser noise, not page errors */
    if (/\/mock-api\/|\/data\/feed\.json$|\/favicon\.ico$/.test(src)) return;
    if (/Failed to load resource/.test(m.text()) && /\/mock-api\//.test(src)) return;
    pageErrors.push(tag + ": " + m.text() + " @ " + src);
  });
}

async function openLab(ctx, tag, query) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(APP + (query || ""));
  await page.waitForSelector("#nav .tab");
  if (!query) await page.locator('[data-tab="lab"]').click();
  await page.waitForSelector('[data-lab="phone"]', { timeout: 15000 });
  return page;
}
const snap = (page) => page.evaluate(() => window.__losLab.snapshot());
const stub = (page) => page.evaluate(() => ({
  wakeRequests: window.__stubs.wakeRequests, wakeReleases: window.__stubs.wakeReleases,
  held: window.__stubs.sentinels.filter((s) => !s.released).length, batteryCalls: window.__stubs.batteryCalls
}));

/* ————— 1. nothing starts on load ————— */
suite("phone 1 — nothing starts on load");
const ctxA = await phoneContext();
const A = await ctxA.newPage();
watch(A, "A");
await A.goto(APP);
await A.waitForSelector(".card");
await sleep(1500);
ok(!mock.hits.work && !mock.hits.join, `loading the app touches neither ?a=work nor ?a=join (${JSON.stringify(mock.hits)})`);
await A.locator('[data-tab="lab"]').click();
await A.waitForSelector('[data-lab="phone"]');
await sleep(1500);
ok(!mock.hits.work && !mock.hits.join, `opening the Lab still touches neither (${JSON.stringify(mock.hits)})`);
ok(mock.hits.stats >= 1, "the Lab asked for the public totals only");
const s1 = await stub(A);
ok(s1.wakeRequests === 0 && s1.batteryCalls === 0, "no wake lock and no battery query before any press");
const phoneText = await A.locator('[data-lab="phone"]').textContent();
ok(/only works while this page is open/i.test(phoneText) && /nightstand/.test(phoneText) && /stops the moment you close/.test(phoneText),
   "the phone panel says what a phone does and does not do");
ok(!/guarantee|will (find|discover)|you should/i.test(phoneText), "and promises nothing about outcomes");
ok(/Add to Home Screen|Install app|installed/i.test(phoneText), "with no install prompt in headless Chromium the panel shows the manual hint");
await A.screenshot({ path: join(SHOTS, "phone-lab.png"), fullPage: true });
await A.locator('[data-lab="phone"]').screenshot({ path: join(SHOTS, "phone-phone.png") });

/* ————— 2. the wake lock is gesture-only, and released on stop ————— */
suite("phone 2 — keep the screen awake");
await A.locator('input[data-pref="wake"]').click();
const wakeOn = await until(async () => (await stub(A)).wakeRequests === 1, 2000);
ok(!!wakeOn, "the toggle press requests the wake lock — exactly once");
ok(/screen stays on/i.test(await A.locator('input[data-pref="wake"] + .lab-toggle-text').textContent()), "the note says the screen stays on");
ok(JSON.parse(await A.evaluate(() => localStorage.getItem("los.phone.v1"))).wake === true, "the preference is remembered in los.phone.v1");
await A.locator('[data-lab="contribute"] input.lab-name').fill("phone-a");
await A.locator('[data-lab="contribute"] .lab-btn', { hasText: "Donate this browser" }).click();
ok(!!(await until(async () => (await snap(A)).running, 5000)), "Donate starts the loop");
ok(!!(await until(() => (mock.hits.submit || 0) >= 1, 15000)), "a phone screens and submits a real unit");
await A.locator('[data-lab="contribute"]').screenshot({ path: join(SHOTS, "phone-donating.png") });
ok((await stub(A)).wakeRequests === 1, "Donate does not request a second lock while one is held");
await A.locator('[data-lab="contribute"] .lab-btn-stop').click();
const released = await until(async () => { const s = await stub(A); return s.wakeReleases >= 1 && s.held === 0; }, 3000);
ok(!!released, "Stop releases the wake lock");
ok((await snap(A)).running === false, "and the loop is stopped");
ok((await snap(A)).phone.held === false, "the Lab no longer believes it holds one");

/* ————— 3. the charging gate ————— */
suite("phone 3 — only while charging");
await A.locator('input[data-pref="charging"]').click();
ok(!!(await until(async () => (await stub(A)).batteryCalls >= 1, 2000)), "the toggle press is what asks for the battery");
await A.locator('[data-lab="contribute"] .lab-btn', { hasText: "Donate this browser" }).click();
ok(!!(await until(async () => (await snap(A)).running, 5000)), "running while charging");
await A.evaluate(() => window.__stubs.setCharging(false));
const paused = await until(async () => { const s = await snap(A); return !s.running && s.donate.phase === "paused" && s.phone.wantRunning; }, 2000);
ok(!!paused, "unplugging pauses the loop within 2 s and remembers that it was running");
const workWhilePaused = mock.workAt.length;
await sleep(1200);
ok(mock.workAt.length === workWhilePaused, "no work is requested while paused");
ok((await stub(A)).held === 0, "the wake lock was released with the pause");
await A.evaluate(() => window.__stubs.setCharging(true));
ok(!!(await until(async () => { const s = await snap(A); return s.running && s.donate.phase === "running"; }, 2000)), "plugging back in resumes it");
ok(!!(await until(async () => (await stub(A)).held === 1, 2000)), "and re-acquires the wake lock, since the visitor still wants one");
await A.locator('[data-lab="contribute"] .lab-btn-stop').click();
ok(!!(await until(async () => !(await snap(A)).running, 2000)), "Stop while charging stops it");
await A.evaluate(() => { window.__stubs.setCharging(false); window.__stubs.setCharging(true); });
await sleep(1200);
const s3 = await snap(A);
ok(!s3.running && !s3.phone.wantRunning, "a charger appearing never starts a loop the visitor had stopped");
await A.locator('input[data-pref="charging"]').click();   // off again for the rest

/* ————— 4. the pace dial ————— */
suite("phone 4 — pace");
await A.locator('input[data-pace="trickle"]').click();
ok((await snap(A)).pace === 4000, "Trickle sets the client's pace to 4000 ms");
ok(JSON.parse(await A.evaluate(() => localStorage.getItem("los.phone.v1"))).pace === 4000, "and remembers it");
mock.workAt = [];
await A.locator('[data-lab="contribute"] .lab-btn', { hasText: "Donate this browser" }).click();
await until(() => mock.workAt.length >= 3, 12000);
await A.locator('[data-lab="contribute"] .lab-btn-stop').click();
const paceGaps = [];
for (let i = 1; i < mock.workAt.length; i++) paceGaps.push(mock.workAt[i] - mock.workAt[i - 1]);
ok(mock.workAt.length >= 2, `Trickle still gets work done (${mock.workAt.length} requests)`);
ok(paceGaps.every((g) => g >= 3800), `Trickle spaces work requests ≥ ~4 s apart (gaps ${JSON.stringify(paceGaps)} ms)`);
await A.locator('input[data-pace="full"]').click();
ok((await snap(A)).pace === 0, "Full sets it back to 0");

/* ————— 5. teams ————— */
suite("phone 5 — teams");
await A.locator('input[data-team="name"]').fill("QA phone team");
await A.locator('button[data-team="create"]').click();
await A.waitForSelector('[data-lab="teams"] .lab-team-code', { timeout: 5000 });
const code = (await A.locator('[data-lab="teams"] .lab-team-code').textContent()).trim();
ok(CODE_RE.test(code), "the team code has the contract's shape (" + code + ")");
const share = await A.locator('[data-lab="teams"] .lab-share-field').inputValue();
ok(share.includes("?team=" + code) && share.startsWith(BASE), "the share link is this page's URL with ?team=<code>: " + share);
ok(/QA phone team/.test(await A.locator('[data-lab="teams"] .lab-team-name').textContent()), "the card names the team");
ok((await A.locator('[data-lab="teams"] .lab-team-forms').isVisible()) === false, "the create/join forms are hidden while in a team");
ok((await A.locator('[data-lab="teams"] button[data-team="leave"]').isVisible()) === true, "and Leave team is offered instead");
await A.locator('[data-lab="teams"] .lab-copy').click();
const copyLabel = await until(async () => { const t = await A.locator('[data-lab="teams"] .lab-copy').textContent(); return /Copied|Selected/.test(t) ? t : null; }, 1500);
ok(!!copyLabel, "Copy either copies or selects — never pretends (" + copyLabel + ")");
await A.evaluate(() => window.__losLab.refresh());
await until(async () => (await snap(A)).record.team && (await snap(A)).record.team.code, 5000);
ok((await snap(A)).record.team.code === code, "the record now carries the team");
await A.locator('[data-lab="teams"]').screenshot({ path: join(SHOTS, "phone-teams.png") });

const ctxB = await phoneContext();
const B = await openLab(ctxB, "B");
await B.locator('[data-lab="contribute"] input.lab-name').fill("phone-b");
await B.locator('input[data-team="code"]').fill(code.toLowerCase());
ok((await B.locator('input[data-team="code"]').inputValue()) === code, "the code field uppercases what is typed");
await B.locator('button[data-team="join"]').click();
await B.waitForSelector('[data-lab="teams"] .lab-team-code', { timeout: 5000 });
ok((await B.locator('[data-lab="teams"] .lab-team-code').textContent()).trim() === code, "a second phone joins by code (joining first, then team_join)");
ok(mock.hits.join === 2 && mock.hits.team_join === 1, `the join order was join → team_join (${JSON.stringify({ join: mock.hits.join, team_join: mock.hits.team_join })})`);
const boardB = await B.locator('[data-lab="teams"] .lab-team-board').textContent();
ok(/phone-a/.test(boardB) && /phone-b/.test(boardB), "the team board on B shows both members");
await A.evaluate(() => window.__losLab.refresh());
await until(async () => /phone-b/.test(await A.locator('[data-lab="teams"] .lab-team-board').textContent()), 5000);
const boardA = await A.locator('[data-lab="teams"] .lab-team-board').textContent();
ok(/phone-a/.test(boardA) && /phone-b/.test(boardA), "and on A");
ok(/2/.test(await A.locator('[data-lab="teams"] .lab-team-card').textContent()), "the card counts two members");
await B.locator('button[data-team="leave"]').click();
await B.waitForSelector('[data-lab="teams"] .lab-team-forms:not([hidden])', { timeout: 5000 });
ok(/not in a team/.test(await B.locator('[data-lab="teams"] .lab-team-card').textContent()), "Leave team on B returns it to no team");
ok(teamMembers(code).length === 1, "the mock agrees: one member left");
const topTeams = await A.locator('[data-lab="teams"] .lab-team-top').textContent();
ok(/Top teams/.test(topTeams) && /QA phone team/.test(topTeams), "top teams from ?a=stats render in the Teams section");
const headCells = await A.locator('[data-lab="teams"] .lab-team-top .lab-board-head span').evaluateAll((els) =>
  els.map((e) => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, over: e.scrollWidth > e.clientWidth + 1, text: e.textContent })));
let overlap = false;
for (let i = 1; i < headCells.length; i++) if (headCells[i].left < headCells[i - 1].right - 1) overlap = true;
ok(headCells.length === 5 && !overlap && !headCells.some((c) => c.over),
   "the top-teams header columns neither overlap nor overflow on a phone " + JSON.stringify(headCells.map((c) => c.text + (c.over ? "!" : ""))));

/* ————— 6. the ?team= deep link ————— */
suite("phone 6 — ?team=CODE");
const ctxE = await phoneContext();
const E = await openLab(ctxE, "E", "?team=" + code.toLowerCase());
ok((await E.locator(".tab-on").getAttribute("data-tab")) === "lab", "a ?team= link opens on the Lab tab");
ok((await E.locator('input[data-team="code"]').inputValue()) === code, "the code is prefilled (uppercased)");
ok(!!(await until(async () => /Invited to team QA phone team/.test(await E.locator('[data-lab="teams"]').textContent()), 5000)),
   "the invitation line names the team after ?a=team answered");
ok(!mock.hits.team_join || mock.hits.team_join === 1, "opening an invitation joins nothing by itself");
ok(!(await snap(E)).running, "and starts nothing");
await E.locator('[data-lab="teams"]').screenshot({ path: join(SHOTS, "phone-invite.png") });
const F = await ctxE.newPage(); watch(F, "F");
await F.goto(APP + "?team=0OIL1234");
await F.waitForSelector('[data-lab="teams"]');
ok((await F.locator('input[data-team="code"]').inputValue()) === "", "a code outside the alphabet is not prefilled or fetched");
ok(!mock.teamCodesAsked.includes("0OIL1234"), `an invalid code never reaches ?a=team (asked: ${[...new Set(mock.teamCodesAsked)].join(",")})`);

/* ————— 7. the public record ?c=<id> ————— */
suite("phone 7 — ?c=<id>");
mock.contributors.set(77, { id: 77, name: "gone", token: "gone".padEnd(32, "0"), units: 3, credits: 15, created_at: 1700000000, team: null, hidden: true });
const ctxC = await phoneContext();
const C = await openLab(ctxC, "C", "?c=1");
ok((await C.locator(".tab-on").getAttribute("data-tab")) === "lab", "a ?c= link opens on the Lab tab");
await C.waitForSelector('[data-lab="profile"] .lab-profile-name', { timeout: 5000 });
const prof = await C.locator('[data-lab="profile"]').textContent();
ok(/phone-a/.test(prof), "the card names the contributor");
ok(/rank/.test(prof) && /#1/.test(prof), "the card shows the rank");
ok(/QA phone team/.test(prof), "the card shows the team");
ok(/2023-|2024-|20\d\d-\d\d-\d\d/.test(prof), "the card shows a since date");
ok((await C.locator('[data-lab="profile"] .lab-badge').count()) === 5, "the card shows the badge strip");
ok((await C.locator('[data-lab="profile"] a').count()) === 0, "nothing on the card is a link");
const profileFirst = await C.evaluate(() => document.querySelector(".lab").firstElementChild.getAttribute("data-lab"));
ok(profileFirst === "profile", "the record card is the first thing in the Lab");
await C.locator('[data-lab="profile"]').screenshot({ path: join(SHOTS, "phone-profile.png") });
const G = await ctxC.newPage(); watch(G, "G");
await G.goto(APP + "?c=77");
await G.waitForSelector('[data-lab="profile"] .lab-profile-missing', { timeout: 5000 });
ok(/No such contributor/.test(await G.locator('[data-lab="profile"]').textContent()), "a hidden contributor is 'no such contributor'");
const H = await ctxC.newPage(); watch(H, "H");
const contributorHits = mock.hits.contributor || 0;
await H.goto(APP + "?c=007");
await H.waitForSelector('[data-lab="phone"]');
ok((await H.locator('[data-lab="profile"]').count()) === 0, "a non-canonical id (007) shows no card");
ok((mock.hits.contributor || 0) === contributorHits, "and is never sent to the server");

/* ————— 8. badges ————— */
suite("phone 8 — badges count units");
const a1 = mock.contributors.get(1);
a1.units = 0;
await A.evaluate(() => window.__losLab.refresh());
await until(async () => (await snap(A)).record.units === 0, 5000);
ok((await A.locator('[data-lab="record"] .lab-badge[data-earned="1"]').count()) === 0, "no units, no badges");
a1.units = 1;
await A.evaluate(() => window.__losLab.refresh());
await until(async () => (await snap(A)).record.units === 1, 5000);
ok((await A.locator('[data-lab="record"] .lab-badge[data-badge="1"]').getAttribute("data-earned")) === "1", "one unit earns 'First unit'");
ok((await A.locator('[data-lab="record"] .lab-badge[data-badge="10"]').getAttribute("data-earned")) === "0", "but not 'Ten units'");
a1.units = 10;
await A.evaluate(() => window.__losLab.refresh());
await until(async () => (await snap(A)).record.units === 10, 5000);
ok((await A.locator('[data-lab="record"] .lab-badge[data-badge="10"]').getAttribute("data-earned")) === "1", "ten units earn 'Ten units'");
ok((await A.locator('[data-lab="record"] .lab-badge[data-badge="100"]').getAttribute("data-earned")) === "0", "and not 'A hundred'");
const recText = await A.locator('[data-lab="record"]').textContent();
ok(/count work, never luck/i.test(recText), "the page says badges count work, never luck");
ok(/\?c=1\b/.test(await A.locator('[data-lab="record"] .lab-share-field').inputValue()), "the record has its own share link");
await A.locator('[data-lab="record"]').screenshot({ path: join(SHOTS, "phone-record.png") });

/* ————— 9. leaving the swarm ————— */
suite("phone 9 — leave the swarm");
await A.locator('button[data-record="leave"]').click();
ok(/Tap again/.test(await A.locator('button[data-record="leave"]').textContent()), "the first press arms a confirmation");
ok(/within 10 seconds/.test(await A.locator('[data-lab="record"] .lab-status').textContent()), "and explains it");
ok(!mock.hits.leave, "nothing was sent yet");
ok(!!(await A.evaluate(() => localStorage.getItem("los.swarm.v1"))), "the token is still stored");
await A.locator('button[data-record="leave"]').click();
ok(!!(await until(() => mock.hits.leave === 1, 5000)), "the second press calls ?a=leave");
ok(!!(await until(() => A.evaluate(() => localStorage.getItem("los.swarm.v1") === null), 3000)), "the stored record is cleared");
ok(/You have left the swarm/.test(await A.locator('[data-lab="record"] .lab-status').textContent()), "the page says so");
ok(/stays counted/.test(await A.locator('[data-lab="record"]').textContent()), "and explains that verified work stays counted");
ok(mock.contributors.get(1).hidden === true, "the mock hid the contributor");
await A.evaluate(() => window.__losLab.refresh());
await sleep(800);
ok(!/phone-a/.test(await A.locator(".lab-board-host").textContent()), "phone-a is off the leaderboard");
ok(!(await snap(A)).running, "nothing is running afterwards");

/* ————— 10. the PWA manifest and icons ————— */
suite("phone 10 — manifest + icons");
const man = await A.request.get(BASE + "/app/manifest.webmanifest");
ok(man.status() === 200, "manifest.webmanifest is served");
let manifest = null;
try { manifest = JSON.parse(await man.text()); } catch (_) {}
ok(!!manifest && manifest.name === "LongevityOS" && manifest.display === "standalone", "it is valid JSON naming LongevityOS as a standalone app");
ok(!!manifest && manifest.start_url === "./" && manifest.scope === "./", "start_url and scope are relative");
const pngIcons = manifest ? manifest.icons.filter((i) => i.type === "image/png") : [];
ok(pngIcons.length >= 2, "at least two PNG icons are declared");
for (const icon of pngIcons) {
  const r = await A.request.get(BASE + "/app/" + icon.src);
  const buf = Buffer.from(await r.body());
  const isPng = r.status() === 200 && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47;
  const w = isPng ? buf.readUInt32BE(16) : 0, h = isPng ? buf.readUInt32BE(20) : 0;
  ok(isPng && icon.sizes === w + "x" + h, `${icon.src} is a PNG of its declared size (${w}x${h}, ${buf.length} bytes)`);
}
const svgIcon = manifest ? manifest.icons.find((i) => i.type === "image/svg+xml") : null;
const svgRes = svgIcon ? await A.request.get(BASE + "/app/" + svgIcon.src) : null;
ok(!!svgRes && svgRes.status() === 200 && /<svg/.test(await svgRes.text()), "the SVG icon is served");
const apple = await A.request.get(BASE + "/app/icons/apple-touch-icon.png");
const appleBuf = Buffer.from(await apple.body());
ok(apple.status() === 200 && appleBuf.readUInt32BE(16) === 180 && appleBuf.readUInt32BE(20) === 180, "the apple-touch-icon is a 180x180 PNG");
const head = await A.evaluate(() => ({
  manifest: (document.querySelector('link[rel="manifest"]') || {}).getAttribute && document.querySelector('link[rel="manifest"]').getAttribute("href"),
  theme: (document.querySelector('meta[name="theme-color"]') || {}).content,
  apple: (document.querySelector('link[rel="apple-touch-icon"]') || {}).getAttribute && document.querySelector('link[rel="apple-touch-icon"]').getAttribute("href"),
  capable: (document.querySelector('meta[name="apple-mobile-web-app-capable"]') || {}).content,
  mobile: (document.querySelector('meta[name="mobile-web-app-capable"]') || {}).content
}));
ok(head.manifest === "manifest.webmanifest" && /^#[0-9a-f]{6}$/i.test(head.theme || "") && head.apple === "icons/apple-touch-icon.png" &&
   head.capable === "yes" && head.mobile === "yes", "index.html carries the manifest link, theme colour and the app-capable metas");
ok(!existsSync(join(ROOT, "app", "sw.js")) && !/serviceWorker/.test(readFileSync(join(ROOT, "app", "index.html"), "utf8")),
   "no service worker was added");

/* ————— 12. hostile server text ————— */
suite("phone 12 — hostile names, codes and team names render as text");
mock.hostile = true;
const ctxD = await phoneContext();
const D = await openLab(ctxD, "D", "?c=2&team=" + code);
await D.waitForSelector(".lab-board-host .lab-board-row", { timeout: 10000 });
await D.waitForSelector('[data-lab="profile"] .lab-profile-name', { timeout: 5000 });
const dom = await D.evaluate(() => ({
  imgs: document.querySelectorAll("#view img, #view script").length,
  pwned: document.body.getAttribute("data-pwned"),
  boardRows: document.querySelectorAll(".lab-board-host .lab-board-row").length,
  longest: Math.max(...[...document.querySelectorAll(".lab-b-name, .lab-team-name, .lab-profile-name")].map((n) => n.textContent.length)),
  bidi: [...document.querySelectorAll("#view *")].some((n) => /[‪-‮​]/.test(n.textContent)),
  markup: /<img|<script/.test(document.querySelector("#view").innerHTML.replace(/&lt;/g, "")),
  shareFields: document.querySelectorAll('[data-lab="teams"] .lab-share-field').length,
  teamCode: (document.querySelector('[data-lab="teams"] .lab-team-code') || {}).textContent || "",
  profileLinks: document.querySelectorAll('[data-lab="profile"] a').length,
  pageWidthOk: document.documentElement.scrollWidth <= window.innerWidth + 1
}));
ok(dom.imgs === 0 && dom.pwned === null, "an <img onerror> name never became an element and never ran");
ok(dom.markup === false, "no server string was parsed as HTML anywhere in the view");
ok(dom.boardRows <= 21, `the leaderboard is capped at 20 rows + header despite 60+ hostile rows (${dom.boardRows})`);
ok(dom.longest <= 26, `a 5 KB name is clipped to the visible cap (${dom.longest} chars)`);
ok(dom.bidi === false, "bidi overrides and zero-width characters are stripped");
ok(dom.shareFields === 0 && dom.teamCode === "", "a team whose code is not the server's alphabet gets no share link and no code");
ok(dom.profileLinks === 0, "the hostile contributor card contains no link");
ok(dom.pageWidthOk, "the page does not scroll sideways on a phone");
const invD = await D.locator('[data-lab="teams"] .lab-team-invite').textContent();
ok(/Invited to team <script>/.test(invD) && (await D.locator("#view script").count()) === 0,
   "the invitation line renders the hostile team name as inert text: " + JSON.stringify(invD.slice(0, 60)));
await D.screenshot({ path: join(SHOTS, "phone-hostile.png"), fullPage: true });
mock.hostile = false;

/* ————— 11. zero page errors ————— */
suite("phone 11 — zero page errors");
ok(pageErrors.length === 0, "no console/page errors across every phone and page: " + JSON.stringify(pageErrors.slice(0, 4)));

await browser.close();
server.close();
console.log(failed ? "phone: " + failed + " FAILED of " + checks : "phone: " + checks + " checks passed ✓");
process.exit(failed ? 1 : 0);
