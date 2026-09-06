/* dist — builds dist/longevityos.html: the whole atlas in ONE file that runs
 * from a double-click (file://), a USB stick, an email attachment. Strips the
 * ES-module plumbing and inlines everything; module order is fixed and
 * acyclic: data → grades → feed → app. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "app");
const OUTDIR = join(HERE, "..", "dist");
mkdirSync(OUTDIR, { recursive: true });

const strip = (src) => src
  .split("\n")
  .filter((l) => !/^import /.test(l))
  .map((l) => l.replace(/^export const /, "const ").replace(/^export function /, "function ").replace(/^export /, ""))
  .join("\n");

const js = ["data.js", "grades.js", "feed.js", "app.js"]
  .map((f) => "/* ── " + f + " ── */\n" + strip(readFileSync(join(APP, "js", f), "utf8")))
  .join("\n");

const css = readFileSync(join(APP, "css", "style.css"), "utf8");
let html = readFileSync(join(APP, "index.html"), "utf8");
html = html.replace(/<link rel="stylesheet"[^>]*>/, "<style>\n" + css + "\n</style>");
html = html.replace(/<script type="module" src="js\/app.js"><\/script>/, "<script>\n\"use strict\";\n(() => {\n" + js + "\n})();\n</script>");
html = html.replace("los-1.0.0", "los-1.0.0-dist");

writeFileSync(join(OUTDIR, "longevityos.html"), html);
console.log("dist/longevityos.html built (" + html.length + " bytes)");
