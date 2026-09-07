/* dist — builds dist/longevityos.html: the whole platform in ONE file that runs
 * from a double-click, a USB stick or an email attachment.
 *
 * The module graph is inlined in dependency order (it is acyclic by design, and
 * that order is asserted below rather than assumed). A single file cannot spawn
 * a Web Worker from a URL, so the donation client falls back to screening on
 * the main thread — the offline copy is still a complete atlas, and still a
 * working swarm node if it is pointed at a live server.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "app");
const OUTDIR = join(HERE, "..", "dist");
mkdirSync(OUTDIR, { recursive: true });

/* dependency order — every module may only reference the ones above it */
const ORDER = [
  "js/chem/digest.js",
  "js/chem/smiles.js",
  "js/chem/aromatic.js",
  "js/chem/fingerprint.js",
  "js/chem/descriptors.js",
  "js/chem/alerts.js",
  "js/chem/targets.js",
  "js/chem/score.js",
  "js/view/layout.js",
  "js/view/lens.js",
  "js/view/charts.js",
  "js/view/observatory.js",
  "js/view/sound.js",
  "js/view/guide.js",
  "js/view/wizard.js",
  "js/swarm/client.js",
  "js/data.js",
  "js/grades.js",
  "js/feed.js",
  "js/evidence.js",
  /* 4.0 view modules: after the engine, before the Lab that uses them */
  "js/view/led.js",
  "js/view/telemetry.js",
  "js/lab.js",
  "js/app.js"
];

/* A real (small) bundler, because naive concatenation is wrong: ES modules each
 * have their own scope, and these files legitimately reuse helper names —
 * `adjacency` in three chemistry modules, `el` in two view modules,
 * `isPlainObject` in two. Flattening them into one scope produced a bundle that
 * would not parse at all ("Identifier 'el' has already been declared").
 *
 * So each module is emitted inside its own closure that opens by destructuring
 * exactly what it imports from a shared registry and closes by publishing
 * exactly what it exports back into it — which is what `import`/`export` mean.
 * Module-private helpers stay private and can collide freely. */

function parseImports(src) {
  const pairs = [];
  for (const m of src.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s*["'][^"']+["'];?/gm)) {
    for (const spec of m[1].split(",")) {
      const s = spec.trim();
      if (!s) continue;
      const as = s.match(/^(\S+)\s+as\s+(\S+)$/);
      pairs.push(as ? { from: as[1], local: as[2] } : { from: s, local: s });
    }
  }
  return pairs;
}

function parseExports(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm)) {
    for (const spec of m[1].split(",")) {
      const s = spec.trim();
      if (!s) continue;
      const as = s.match(/^\S+\s+as\s+(\S+)$/);
      names.add(as ? as[1] : s);
    }
  }
  return [...names];
}

const stripModuleSyntax = (src) => src
  .split("\n")
  .filter((l) => !/^\s*import\s/.test(l) && !/^\s*export\s*\{[^}]*\}\s*;?\s*$/.test(l))
  .map((l) => l
    .replace(/^(\s*)export\s+(const|let|var|function|class)\s/, "$1$2 ")
    .replace(/^(\s*)export\s+default\s/, "$1const __default = "))
  .join("\n");

const missing = [];
const parts = [];
const allExports = new Set();
const exportOwner = new Map();
for (const rel of ORDER) {
  const p = join(APP, rel);
  if (!existsSync(p)) { missing.push(rel); continue; }
  const src = readFileSync(p, "utf8");
  const imports = parseImports(src);
  const exports = parseExports(src);
  /* Every module publishes into ONE shared registry, so two modules exporting
   * the same name would silently overwrite each other in the bundle while
   * working perfectly as separate ES modules. That is a hard failure, not a
   * warning — and it is why every js/view/ export is prefixed view* (or is
   * UPPER_CASE data). */
  const reExported = new Set(imports.map((i) => i.local));
  for (const n of exports) {
    /* a name the module imported and passes straight through (score.js
     * re-exports targets.js's ENGINE_VERSION) is the same binding, not a
     * second definition */
    if (exportOwner.has(n) && reExported.has(n)) continue;
    if (exportOwner.has(n)) {
      console.error(`dist: duplicate export '${n}' in ${rel} (already exported by ${exportOwner.get(n)}) — the single-file registry cannot hold both`);
      process.exit(1);
    }
    exportOwner.set(n, rel);
    if (rel.startsWith("js/view/") && !/^view[A-Z]/.test(n) && !/^[A-Z][A-Z0-9_]*$/.test(n)) {
      console.error(`dist: ${rel} exports '${n}' — js/view/ exports must be prefixed view* or be UPPER_CASE data`);
      process.exit(1);
    }
  }
  exports.forEach((n) => allExports.add(n));
  const head = imports.length
    ? `  const { ${imports.map((i) => (i.from === i.local ? i.from : `${i.from}: ${i.local}`)).join(", ")} } = __M;\n`
    : "";
  const tail = exports.length ? `\n  Object.assign(__M, { ${exports.join(", ")} });` : "";
  parts.push(`/* ── ${rel} ── */\n(() => {\n${head}${stripModuleSyntax(src)}${tail}\n})();`);
}
if (missing.length) {
  console.error("dist: these modules are missing from app/: " + missing.join(", "));
  process.exit(1);
}

/* the registry, every module, then the whole surface bound as ordinary names so
 * anything running afterwards (the app's own entry code) sees a normal scope */
const js = "const __M = {};\n" + parts.join("\n") +
  `\nconst { ${[...allExports].join(", ")} } = __M;\n`;
const cssFiles = ["css/style.css", "css/lab.css", "css/observatory.css", "css/lens.css", "css/charts.css", "css/wizard.css"].filter((f) => existsSync(join(APP, f)));
const css = cssFiles.map((f) => readFileSync(join(APP, f), "utf8")).join("\n");

let html = readFileSync(join(APP, "index.html"), "utf8");
html = html.replace(/<link rel="stylesheet"[^>]*>\s*/g, "");
html = html.replace("</head>", "<style>\n" + css + "\n</style>\n</head>");
html = html.replace(/<script type="module"[^>]*><\/script>/,
  '<script>\n"use strict";\n/* single-file build: no module workers, no server — the client\n   screens on the main thread if it is ever pointed at a live swarm. */\nwindow.__LOS_SINGLE_FILE = true;\n(() => {\n' + js + "\n})();\n</script>");
html = html.replace("los-4.0.0", "los-4.0.0-dist");

writeFileSync(join(OUTDIR, "longevityos.html"), html);

/* a build that silently lost a module is worse than a failed build */
for (const marker of ["const COMPOUNDS", "const HUMAN_EVIDENCE", "function screenUnit", "function morganFingerprint", "function renderLab", "function viewTelemetry", "function viewLed", "function viewLayoutMolecule", "function viewLens", "function viewObservatory", "function viewChartStepArea", "function viewWizard", "function viewSoundBoard", "function viewGuide", "const NARRATION", "const SFX"]) {
  if (!html.includes(marker)) { console.error(`dist: '${marker}' is missing from the bundle — inlining broke`); process.exit(1); }
}
if (/^\s*import\s/m.test(html)) { console.error("dist: an ES import survived into the bundle"); process.exit(1); }

console.log(`dist/longevityos.html built (${(html.length / 1024).toFixed(0)} KB, ${ORDER.length} modules, ${cssFiles.length} stylesheets)`);
