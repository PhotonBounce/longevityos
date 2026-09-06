/* gen-icons — the app's icon, drawn once as SVG and rasterised to the PNGs the
 * manifest declares (192, 512) plus the 180px apple-touch-icon.
 *
 * The glyph: a hexagonal molecule ring with a small pulse line through it, in
 * the brand colours from app/css/style.css, on the app's own background. No
 * text — it has to read at 48px on a launcher.
 *
 * Deterministic: the SVG is a fixed string, the PNGs are a screenshot of that
 * exact SVG at an exact size in a fixed-scale context. The same SVG rendered
 * by the same Chromium produces the same bytes; a different Chromium may
 * antialias differently, which is why the PNGs are committed rather than
 * built on every deploy.
 *
 *   node qa/gen-icons.mjs          # writes app/icons/{icon.svg,icon-192.png,icon-512.png,apple-touch-icon.png}
 */
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ICONS = join(HERE, "..", "app", "icons");
mkdirSync(ICONS, { recursive: true });

/* brand colours — keep in step with app/css/style.css :root */
const BG = "#0c1116";
const ACCENT = "#59d4a5";
const ACCENT2 = "#7ab8ff";

/* A pointy-top hexagon of radius 150 about (256,256), and a pulse line that
 * crosses its middle. Every coordinate is a literal so the file never depends
 * on floating-point trig. */
export const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
  `  <rect width="512" height="512" fill="${BG}"/>`,
  `  <polygon points="256,106 386,181 386,331 256,406 126,331 126,181" fill="none" stroke="${ACCENT}" stroke-width="26" stroke-linejoin="round"/>`,
  `  <polyline points="150,256 210,256 232,214 258,300 282,236 300,256 362,256" fill="none" stroke="${ACCENT2}" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>`,
  "</svg>",
  ""
].join("\n");

const SIZES = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180]
];

const BUDGET = 60 * 1024;   // every icon together, so the PWA costs a phone almost nothing

async function main() {
  writeFileSync(join(ICONS, "icon.svg"), ICON_SVG);

  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  let total = Buffer.byteLength(ICON_SVG);
  for (const [name, size] of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    const html = "<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0;padding:0;width:" + size +
      "px;height:" + size + "px;overflow:hidden;background:" + BG + "}svg{display:block;width:" + size + "px;height:" + size + "px}</style></head><body>" +
      ICON_SVG + "</body></html>";
    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size }, omitBackground: false });
    if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) throw new Error(name + ": not a PNG");
    const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
    if (w !== size || h !== size) throw new Error(name + ": rendered " + w + "x" + h + ", wanted " + size);
    writeFileSync(join(ICONS, name), png);
    total += png.length;
    console.log("  " + name + "  " + w + "x" + h + "  " + png.length + " bytes");
  }
  await browser.close();
  console.log("icons: " + total + " bytes in " + ICONS + " (budget " + BUDGET + ")");
  if (total > BUDGET) { console.error("icons: over the byte budget"); process.exit(1); }
  statSync(join(ICONS, "icon.svg"));
}

main().catch((err) => { console.error(err); process.exit(1); });
