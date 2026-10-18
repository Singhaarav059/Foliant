// Builds tests/fixtures/mixed-script.pdf: a scanned A4 page (an image, no
// text) of a form in English and Hindi, some lines mixing both. Drawn in
// Chrome with the bundled Noto Sans, at 200 dpi. Run once; the file is
// checked in. Its text is in tests/lib/mixed-script.mjs.
//
//   node tests/make-mixed-script.mjs
import pw from "playwright-core";
import { PDFDocument } from "pdf-lib";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireChrome } from "./lib/chrome.mjs";
import { MIXED_LINES } from "./lib/mixed-script.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const browser = await pw.chromium.launch({ executablePath: requireChrome() });
const page = await browser.newPage();
await page.route("http://test.local/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><link rel="stylesheet" href="/fonts/noto-sans/400.css">` });
  const file = join(root, "node_modules/@fontsource", path.replace(/^\/fonts\//, ""));
  if (!path.startsWith("/fonts/") || path.includes("..") || !existsSync(file)) return route.fulfill({ status: 404 });
  return route.fulfill({ body: readFileSync(file), contentType: file.endsWith(".css") ? "text/css" : "font/woff2" });
});
await page.goto("http://test.local/");
const png = await page.evaluate(async (lines) => {
  const font = "34px 'Noto Sans'";
  await document.fonts.load(font, lines.join(""));
  if (!document.fonts.check(font, lines.join(""))) throw new Error("Noto Sans not loaded");
  const W = 1654, H = 2339; // A4 at 200 dpi
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const x = cv.getContext("2d");
  x.fillStyle = "#fbfaf6";
  x.fillRect(0, 0, W, H);
  x.fillStyle = "#1a1a1a";
  x.font = font;
  lines.forEach((line, i) => x.fillText(line, 150, 260 + i * 80));
  return cv.toDataURL("image/png");
}, MIXED_LINES);
await browser.close();

const doc = await PDFDocument.create();
const image = await doc.embedPng(Buffer.from(png.split(",")[1], "base64"));
doc.addPage([595.28, 841.89]).drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
const out = join(root, "tests/fixtures/mixed-script.pdf");
writeFileSync(out, await doc.save());
console.log(`wrote ${out}`);
