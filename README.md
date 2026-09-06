# LongevityOS — a citizen-science engine for longevity drug candidates

**No drug has ever been shown to extend human lifespan.** LongevityOS is three
things pointed at that fact: an evidence atlas of every compound people call an
immortality drug, a ledger of what *does* have human evidence for fewer deaths
(and every rigorous null and harm, on the same footing), and a live screening
engine that harvests new molecules and puts them in front of a swarm of
volunteer computers — phones and tablets included.

Nothing here is medical advice, and nothing the swarm produces is a discovery.
The output is a **ranked shortlist of hypotheses** for people who do this for a
living.

## How it works

**1. Harvest.** A daily job mines PubChem for molecules structurally near the
reference actives of eight-plus longevity-relevant targets (mTOR, senolytic
BCL-2, AMPK/metabolic, NAD+ metabolism, autophagy, mitophagy…), filters them
through the app's own parser and drug-likeness rules, and files the survivors as
candidates. `tools/harvest.mjs`, `.github/workflows/harvest.yml`.

**2. Screen — in your browser.** Volunteers open the Lab and press one button.
The server hands out **work units** (batches of ~40 candidates); a Web Worker
computes, for each molecule, a Morgan fingerprint, its Tanimoto similarity to
every reference active, Lipinski/Veber drug-likeness, structural alerts, and a
composite integer score. This is the SETI@home shape: many small machines, one
big question.

**3. Verify by agreement.** A result is worthless if one stranger can invent it,
so **two independent contributors must produce the identical digest** before
anything is promoted to a verified hit. Disagreement quarantines the unit for a
tie-break. **Canary units** — whose correct digest the server already knows —
are mixed into the stream to catch fabricated submissions.

That verification only means something if the computation is reproducible, so
determinism is enforced as a hard rule: the screening path uses integer and
bitwise arithmetic only, sorts everything before it reaches a digest, and
touches no clock, no RNG, no locale, and no transcendental math. `qa/swarm.mjs`
proves it by computing the same unit in bare Node, in a browser page, and inside
a real Web Worker, and requiring all three digests to be byte-identical.

## 3.0 — "Everyone can mine"

- **What has evidence** (`app/js/evidence.js`): 24 interventions with human
  all-cause-mortality data — randomised trials, meta-analyses, large cohorts —
  and 18 null/harm rows, each a verified PubMed record, framed as *"in people
  like those in the trial"*. Rungs E3 (randomised: fewer deaths) → E0 (rigorous
  null or harm) are computed from the rows, never typed. Nothing on the page is
  advice; that is the point of it.
- **Phone mode** in the Lab: keep the screen awake (Wake Lock, requested only
  from a tap), only-while-charging (Battery API where the browser has it,
  honestly disabled where it does not), three paces, and add-to-home-screen
  (`manifest.webmanifest` + icons; deliberately **no service worker**). A phone
  works only while the page is open, and the copy says so.
- **Teams**: create by name, join by an 8-character code or a share link,
  public team pages, a top-10 board. **Your record**: a public, shareable
  contributor page with effort-only badges (1 / 10 / 100 / 1,000 / 10,000
  verified units — never a badge for finding a hit). **Leave** hides you from
  every board while your verified work stays counted; emptied teams are swept.
- Rewards are points, teams, badges and named credit — never cash or a token.

## What it is not

It is ligand-based similarity screening: *"this molecule looks like drugs that
did something in a longevity experiment, and isn't obviously undruggable."* It
is not docking, not a binding or efficacy prediction, and not evidence that any
molecule does anything in any living thing. A structural alert is a triage flag,
not a verdict of toxicity. `qa/content.mjs` fails the build if any shipped
string drifts past those limits.

## Layout

- `app/` — the web app: Atlas (drug evidence), **What has evidence** (the
  human ledger), **Lab** (the swarm, phone mode, teams, your record), Ladder,
  Fresh findings, Sources. Zero dependencies, ES modules.
  - `app/js/chem/` — the engine: `smiles.js` (parser + ring perception),
    `fingerprint.js` (Morgan/ECFP4 + Tanimoto), `descriptors.js` (MW, TPSA,
    cLogP, Lipinski counts), `alerts.js`, `targets.js` (the science inputs),
    `digest.js` (pure-JS SHA-256), `score.js` (**the screening core**).
  - `app/js/swarm/` — `client.js` (donation loop, consent-gated) and
    `worker.js`.
- `saas/api/` — the swarm server: PHP 8 + SQLite, no framework. Work issue,
  consensus, canaries, leaderboard, teams, public contributor records, leave,
  harvester ingest. Every response stays under 9 KB. `data/` is the live
  database and is never mirrored over by a deploy.
- `qa/` — the gate. `npm run qa` = `unit` (both corpora) + `chem` (engine
  pinned to published values) + `content` (honesty + purity + server lint) +
  crawler/harvester selftests + `api` (a real `php -S` driven through the
  whole protocol, teams included) + `swarm` (Node↔browser↔worker digest
  parity, pacing) + `phone` (Pixel 5 emulation: wake lock, charging gate,
  teams, records, hostile data) + `e2e` + `evidence` (the ledger in a real
  browser). `npm run probes` = the standing adversarial probes;
  `bash cycle.sh` = the 5-clean-cycles bar. CI adds `verify-sources.mjs`
  (every citation checked against PubMed's API) and `verify-molecules.mjs`
  (every reference SMILES checked against PubChem). `live-qa.yml` proves the
  deployed site daily from a runner (`qa/live.mjs`), with screenshots on the
  orphan `qa-proof-longevityos` branch.
- `tools/` — `harvest.mjs` (the molecule sweep), `crawl.mjs` (the literature
  sweep), `dist.mjs` (single-file build).

## Run it

```
cd qa && npm install && npm run qa          # the whole gate
php -S 127.0.0.1:8080 -t saas/api           # the swarm server
python3 -m http.server 8081 &               # or any static server for app/
```

## Rules that are not negotiable

1. **Determinism is the trust model.** If two browsers can disagree, "verified"
   means nothing. No RNG, no clock, no locale, no float accumulation on the
   screening path.
2. **Consent.** No CPU is ever used without an explicit press. The client cannot
   auto-start, and `qa/content.mjs` enforces it.
3. **Honesty.** Hypotheses, never discoveries. Failures shown beside hopes. No
   dosing, no advice, no "clinically proven".
4. **Fail closed.** No ingest key configured means ingest is refused, never
   opened. A citation or molecule that cannot be verified is reported as
   unverified — never assumed correct.
5. **The database is sacred.** `saas/api/data/` holds every contributor's work.
   No deploy may ever mirror over it.
6. **The ledger reports, it never advises.** Every row is a result in people
   like those in the trial, with the number as reported and a PubMed record CI
   re-verifies; doses appear only as what a trial used; "you should" and
   "we recommend" fail the build anywhere in the app.
7. **Credit is for effort.** Badges and points count verified units, never
   whether a unit held a hit; rewards are never money.

Licences: code MIT (`LICENSE`), data CC BY 4.0 (`LICENSE-DATA`); cite via
`CITATION.cff`. The roadmap is `ROADMAP.md`.
