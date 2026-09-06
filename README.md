# LongevityOS — the immortality-drug evidence atlas

**No drug has ever been shown to extend human lifespan.** This app tracks the
candidates people call immortality drugs — rapamycin, metformin, senolytics,
NAD+ boosters, taurine and friends — with the actual published evidence,
including every rigorous failure. Not medical advice; a map of what is known.

## What makes it honest (structurally, not aspirationally)

- **Every claim carries its source.** Each evidence row ships a primary-source
  URL and a `titleCheck`; CI re-fetches every link and verifies the article
  title against the page (`qa/verify-sources.mjs`). A wrong citation is a red
  build.
- **Grades are computed, never typed.** A compound's badge derives from its
  evidence rows' (organism, outcome) — `app/js/grades.js`. The ladder's top
  rung ("human RCT, aging outcome met") is empty, and the app says so.
- **Failures are first-class.** Metformin, fisetin, resveratrol and NR all
  failed the NIA Interventions Testing Program; ASPREE said no to aspirin in
  humans; taurine's biomarker premise took two 2025 hits. All of it renders,
  tagged NULL / CONTRARY, filterable as a group.
- **The atlas keeps researching.** A daily PubMed E-utilities sweep
  (`tools/crawl.mjs` via `crawl.yml`) refreshes `data/feed.json`, validated
  through the app's own parser. No sweep? The app shows its bundled citation
  library and says exactly that — a bundled library is never dressed up as a
  live feed, and a stale sweep calls itself stale.
- **No advice, ever.** `qa/content.mjs` lints every shipped string against
  imperative dosing, "clinically proven", cure/reversal claims and the rest.

## Layout

- `app/` — the atlas: zero dependencies, offline-first, ES modules.
- `data/feed.json` — the literature sweep (written by CI, never by hand).
- `tools/crawl.mjs` — the sweep; `tools/dist.mjs` — builds
  `dist/longevityos.html`, the whole app in one double-clickable file.
- `qa/` — the gate: `npm run qa` = unit (data contracts) + content (honesty
  lint) + crawler selftest + e2e (Playwright); `verify-sources.mjs` (CI);
  `apk-binary.mjs` drives the signed APK before any publish.
- `android/` — zero-permission WebView shell (`com.photonbounce.longevityos`);
  built + signed by `build-apk.yml`, binary lands on the `media-apk-longevityos`
  branch and as a workflow artifact.

## Run it

```
cd qa && npm install && npm run qa     # the full gate
node tools/dist.mjs                    # one-file build → dist/longevityos.html
```

Open `app/index.html` over any static server (or just double-click the dist).
