# LongevityOS roadmap — from a screening swarm to research pharma can use

*Status: 2.0.x is live at https://photon-bounce.com/longevityos/ (atlas + volunteer
swarm). This document plans everything after it. Last revised 2026-09-06.*

## 0. The thesis, in one sentence

No lab, no problem — as long as the product is the **artifact a lab would act
on**: a sourced, reproducible, ITP-format candidate dossier for an existing
(approved / off-patent) drug, plus the open dataset behind it — because the
NIA Interventions Testing Program takes public nominations, pays for the
~$3M mouse study itself, and makes the proposer a co-author.

## 1. Where we are (measured)

| Fact | Value | How it was measured |
|---|---|---|
| Engine throughput | 4,089 molecules / s / core | `qa/swarm.mjs` timing |
| Time for 10 nodes to screen all of PubChem (≈119M) | ≈ 5 h | arithmetic on the above |
| Storage per molecule, full cycle (row + 2 results + hit) | **606 bytes** | 1,000 synthetic molecules through `php -S` + real consensus, WAL checkpointed |
| Live database today | 1,044 molecules ≈ 0.6 MB | `?a=health` |
| Reference set | 27 actives in 10 targets (`app/js/chem/targets.js`) | `targetsDigest()` |
| Evidence atlas | 15 compounds, 27 evidence rows, 7 rigorous nulls | `qa/unit.mjs` |
| Cost to run | ≈ $0 / month (shared host already paid; public-repo Actions are free; volunteers supply compute) | — |

Consequence: **compute is not the bottleneck and never was.** The bottlenecks
are (a) what we screen against — 27 actives is a toy reference set — and
(b) the wet-lab / clinical step that no software can do. Everything below
attacks (a) directly and routes (b) to institutions that already exist.

## 2. Storage and cost budget (so nothing surprises the host)

| Milestone | Molecules in the swarm DB | SQLite size | Notes |
|---|---|---|---|
| Today | 1,044 | 0.6 MB | |
| Phase 1 repurposing pool | ≈ 5,000 (ChEMBL approved ≈ 3,500 + DrugAge ≈ 1,100 + atlas) | ≈ 3 MB | |
| Phase 1 + wider harvest (Threshold 85 around 1,100 actives) | ≈ 100,000 | ≈ 60 MB | |
| Hard cap for a shared host | 1,000,000 | ≈ 600 MB (≈ 420 MB with result payloads pruned after confirmation) | cap enforced in `?a=ingest`; beyond it the swarm rotates, it does not grow |
| Dataset exports (`data/exports/`) | — | ≈ 1 MB per 10,000 molecules (CSV, gzip) | published upload-only beside the app and attached to GitHub Releases; Zenodo allows 50 GB per record |
| Git repo | — | 1.9 MB now; exports and DB never committed | `.gitignore` already covers `data/harvest-latest.json`, `saas/api/data/` |
| Volunteer machines | — | **0 bytes on disk** (a browser tab; ≈ 50 MB RAM while running) | the only persistent state is a token in localStorage |
| Phase 3 heavier screen | same rows | unchanged server-side | 3D work is generated from SMILES inside the unit and only scores return; poses are kept only for the top 1% |

Nothing in this plan needs paid storage, paid compute, or a paid API. The
only paid thing that can ever appear is a wet-lab assay somebody *chooses* to
sponsor (Phase 2, optional).

## 3. Phases

### Phase 0 — Open-science hygiene (one session)

The public repo currently has **no LICENSE file**, which legally means
"all rights reserved" — the opposite of what an open-science project
claims.

- `LICENSE` (MIT, code) + `LICENSE-DATA` (CC-BY-4.0, every export) + `CITATION.cff`.
- Wire `qa/verify-molecules.mjs` into `.github/workflows/qa.yml` (it exists,
  works, and the README already claims CI runs it — it does not).
- `README.md`: correct that claim; add the data licence and the citation block.
- Exit criterion: `npm run qa` green, both verifiers green in CI, a licence
  badge visible on the repo.

### Phase 1 — The repurposing pool and the dossier pipeline (2–3 sessions)

The artifact pharma and the ITP can act on. Everything runs on a GitHub
runner (the sandbox has no route to ChEMBL, PubChem, PubMed or CT.gov) and
lands on the host upload-only.

**1a. The pool** — `tools/pool.mjs` (new, runner-side)
- **ChEMBL** (`CC BY-SA 3.0`): `molecule.json?max_phase=4` → every approved
  small molecule with `pref_name`, `first_approval`, `withdrawn_flag`, `oral`,
  canonical SMILES and InChIKey. PubChem CID resolved from the InChIKey
  (`/compound/inchikey/<key>/cids/JSON`) so the swarm keeps CID as its key.
- **DrugAge** (HAGR, CC-BY — the tool records the licence statement it
  fetched): every compound with a recorded lifespan effect in a model
  organism, with species, % change, dose as reported and PMID. This becomes
  the **second reference set**: 27 actives → ≈ 1,100, which is the single
  biggest quality jump available to the screen.
- **Off-patent** is a *proxy*, labelled as one: `first_approval` ≥ 20 years
  ago ⇒ "likely off-patent — verify in the FDA Orange Book" with the link.
  We never assert patent status as fact.
- Ingested through the existing `?a=ingest` door with `source:"chembl"` /
  `source:"drugage"`; the harvester's structural dedupe and `molFromSmiles`
  filters are reused unchanged.

**1b. Annotations** — server side (`saas/api/`)
- New table `annotations(cid PK, name, chembl_id, max_phase, first_approval,
  withdrawn, oral, drugage_species, drugage_effect, drugage_dose, pmids,
  source, updated_at)` written by a new key-protected `?a=annotate`
  (same key lifecycle as ingest: minted per deploy run — the owner chose
  not to store a standing key).
- `?a=hits` gains `name`, `status` ("approved YYYY", "approved, withdrawn",
  "investigational", "research compound") when an annotation exists. The Lab
  shows the name instead of a bare formula. `lab.js` sanitisers
  (`safeText`, `safeInt`, `CID_RE`) are reused as-is.
- New paged, read-only `?a=export&kind=hits|screened|pool&after=<cid>`
  (200 rows/page, under the 9 KB budget) — the *only* way bulk data leaves
  the server, so the 10 KB rule stands.

**1c. Reference set v2** — `ENGINE_VERSION` → `los-chem-2`
- `targets.js` grows a DrugAge-derived target per mechanism family; the
  `TARGET_KEYS`/`ACTIVE_KEYS` digest arrays gain `evidence` (organism, %
  change, PMID) so a reference active carries its own proof.
- Every deployed client refuses the old digest (already built in), the
  server re-pins on the first ingest, existing hits are re-queued.

**1d. The dossier generator** — `tools/dossier.mjs` (runner-side; **not**
under `app/js/chem/`, whose purity lint forbids dates and formatting)
- Input: every pool compound that is approved AND (has a DrugAge lifespan
  record OR a verified swarm score ≥ threshold).
- Pulls, per compound: PubMed hits for `"<name>" AND (lifespan OR ageing OR
  senescence)` via E-utilities (the `crawl.mjs` pattern), ClinicalTrials.gov
  v2 (`query.intr=<name>`, status + phase + condition), DrugAge rows, the
  atlas row if one exists (`itp`, nulls), the swarm's `perTarget` view.
- Output, one JSON + one Markdown per compound in `data/dossiers/`, sections
  mirroring what the ITP asks a nominator for: *Rationale · Prior lifespan
  data (organism, dose as reported, % change, citation) · Human status and
  pharmacology (approval year, oral, withdrawn) · Doses used in published
  studies (never "recommended", never "take N mg") · Safety as reported ·
  Suggested assays · Negative and contrary results · Open questions ·
  Provenance (every number → its source field)*.
- **The verbatim contract, dossier edition**: every PMID in a dossier is
  re-resolved on the runner and its title must contain the claimed
  `titleCheck`; a number with no source field fails the build. This is the
  Fortune Teller / Fash-O-Meter rule applied to generated science text.

**1e. The negative-results ledger**
- Swarm side: every screened molecule whose verified score is below the
  hit threshold is exported as a *"screened — no structural signal"* record
  (the server already keeps one `hits` row per verified molecule regardless
  of score; the export just stops hiding them).
- DrugAge rows with zero/negative lifespan effect and the atlas's
  `outcome:"null"` rows are exported in the same `negatives.csv`.
- A ledger you can only read one way is propaganda — the sibling rule.

**1f. The dataset** — `tools/export.mjs` (runner-side)
- `longevityos-dataset-<version>.zip` = `pool.csv`, `hits.csv`,
  `screened.csv`, `negatives.csv`, `dossiers/`, `targets.json`,
  `datapackage.json`, `README`, `LICENSE-DATA`. Published upload-only to
  `/public_html/longevityos/data/exports/` and attached to a GitHub Release.
- Owner action (one click, once): connect the repo to Zenodo → every Release
  mints a DOI automatically. Until then the GitHub Release URL is the
  citation.

**Gate additions**: `qa/pool.mjs` (fixture-driven, offline: ChEMBL/DrugAge
parsers, CID resolution, licence capture, off-patent proxy wording),
`qa/dossier.mjs` (banned-phrase lint on *generated* text, verbatim contract,
provenance completeness, a dossier for a compound with only nulls must say
so), `qa/export.mjs` (paged export exactness, CSV escaping, byte budget), and
`api.mjs` grows suites for `annotate` + `export`. Live QA
(`live-qa-longevityos.yml`, new) proves freshness, `?a=export` paging on the
live host and one dossier round-trip.

Exit criterion: **≥ 10 dossiers for approved drugs, each with ≥ 1 PubMed
lifespan citation and a CT.gov status line, a downloadable dataset with a
licence, and the Lab showing drug names.**

### Phase 2 — Community, credit and the hand-off (1–2 sessions + owner actions)

**Contributors**
- Named credit is the product: opt-in display name, a contributor page with
  a shareable certificate (`certificate.html?c=<id>`, textContent only, no
  fetch beyond the app's own API), "what your CPU did this week", and an
  *Acknowledgements* file in every dataset release listing opted-in names.
- Milestone badges by verified units (the Eyes Away rank pattern, effort
  only — never outcome).
- Launch kit in `docs/community/`: a one-page explainer, the honest FAQ
  ("Will this find an immortality drug?" — no; here is what it does find),
  posts drafted for r/longevity, Rapamycin.news and longevity Twitter/X.
  **Realistic targets**: 50–200 contributors in year one on community
  promotion alone; 500–2,000 if Phase 3 lands and one academic partner or
  a DOI'd dataset gives people a reason to keep a tab open.

**The hand-off (owner actions the software prepares, never performs)**
- **NIA ITP nomination**: the generator emits the nomination email from the
  dossier (rationale, dose and route as reported, timing, proposed assays).
  Annual call; the current notice is linked from the dossier. The owner
  sends it. Expected: ~10–20 % of a solid nomination being selected; a
  tested compound has historically extended lifespan in at least one sex
  about one time in five ⇒ **~2–4 % per nomination, 5+ years out**.
- **Ora Biomedical Million Molecule Challenge** (crowd-sponsored *C.
  elegans* lifespan assays): the plan's only optional spend — sponsor worm
  assays for the top three repurposing candidates that lack organism data.
  A worm result attached to a dossier is what turns "computed" into
  "observed".
- **Grant readiness** (owner chose open science + grants): `docs/grants/`
  holds a project summary, the dataset DOI, contributor statistics and the
  reproducibility statement in the shape Impetus Grants and VitaDAO ask
  for. Both need a named PhD-level co-applicant; the plan's job is to make
  saying yes cheap for that person.

### Phase 3 — Make a volunteer's CPU matter (3–5 sessions, go/no-go first)

Today a tab finishes its unit in a blink, which is why nobody keeps one
open. Two steps, each a new `ENGINE_VERSION`, each keeping the trust model
(integer math, two-party consensus, canaries) intact:

- **`los-chem-3` — pharmacophore layer**: 2-point pharmacophore-pair
  fingerprints over topological distances (donor/acceptor/aromatic/charge/
  hydrophobe), fused with ECFP4. Cheap, deterministic, better ranking.
- **`los-chem-4` — shape**: fixed-point (Q16.16) distance-geometry
  embedding + rigid-body shape overlay against each active — integer isqrt,
  CORDIC rotations, no `Math.*` transcendental. Roughly 100× heavier per
  molecule, so 1,000 nodes matter for a million-molecule sweep. Still
  **not docking and never called docking**; still a shortlist, never a
  binding prediction.

Go/no-go before `los-chem-4`: Phase 1 shipped, ≥ 100 contributors, and a
pool large enough (≥ 100k) that the heavier screen has something to rank.

### Phase 4 — Standing operations

- Daily: literature sweep (exists), harvest (exists), pool refresh (new),
  dossier regeneration (new) — all runner-side, all upload-only.
- Monthly: dataset release + DOI; ITP-call reminder when the notice window
  opens; 3 consecutive clean live-QA runs before any release is announced.

## 4. Projections (estimates, dated 2026-09)

**Financial**

| Scenario | Likelihood | Money | Requires |
|---|---|---|---|
| Open science, no revenue | ~70 % | ≈ $0 in, ≈ $0 out | nothing — this is the default |
| Small grant / DeSci award | ~25 % | $10k–$100k one-off | DOI'd dataset + one named scientist |
| Commercial data licence | < 10 % | $5k–$50k / yr | at least one wet-lab result attached to our hypotheses |

**Scientific**: 3 months → citable dataset + first dossiers (high
probability, in our control); 12 months → 1–3 ITP nominations + a preprint
(high probability of *submitting*); an "immortality drug" → 0 % — no
mechanism in existence gets there and the app keeps saying so.

## 5. Competitors and partners

- **Volunteer compute**: Folding@home, Rosetta@home, World Community Grid,
  DreamLab — university-branded, none aging-specific. The geroprotector
  niche is empty, partly because compute is not the bottleneck.
- **Atlases**: DrugAge and Geroprotectors.org already outclass our
  15-compound corpus. DrugAge is CC-BY, so it becomes our reference set
  rather than our rival.
- **AI drug discovery for aging**: Insilico, BioAge, Rejuve.AI — funded,
  staffed, wet-labbed. We feed them; we do not race them.
- **Partners that matter**: the NIA ITP (free nominations, funded studies)
  and Ora Biomedical (crowd-funded worm assays).

## 6. Rules that do not change

Everything in `README.md` §non-negotiables stands. Phase 1 adds:

1. **A dossier is a hypothesis with receipts.** Every number has a source
   field; every PMID re-resolves on the runner; generated text passes the
   same banned-phrase lint as the app.
2. **Doses are reported, never recommended.** "Doses used in published
   studies" is the only framing; `take N mg` and `recommended dose` fail the
   gate wherever they appear.
3. **Status words are sourced.** "Approved" comes from ChEMBL `max_phase=4`
   with the year; "likely off-patent" is a labelled proxy with the Orange
   Book link; "toxic" never appears on the screening surface.
4. **Negatives ship with positives**, in the same export, every release.
5. **Credit is for effort.** Contributor rank counts verified units, never
   whether a unit contained a hit.
