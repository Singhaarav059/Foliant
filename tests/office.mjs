// Word → PDF in the static build: renders tests/fixtures/rich.docx the way the
// browser does (docx-preview), prints it with Chrome like the print dialog,
// and checks what survived. The old mammoth path runs on the same file for
// comparison. Needs Chrome (CHROME_PATH, or the usual install location).
//
//   node tests/office.mjs
import pw from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, openPdf, check, eq } from "./lib/load.mjs";

const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!chrome) {
  console.log("skip  no Chrome found (set CHROME_PATH)");
  process.exit(0);
}
const results = { failed: 0 };
const test = check(results);
const require = createRequire(join(root, "package.json"));
const out = mkdtempSync(join(tmpdir(), "office-"));
execFileSync(join(root, "node_modules/.bin/tsc"), ["--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--noCheck", "--lib", "es2022,dom", "src/lib/office/docx.ts", "src/lib/office/html.ts"], { cwd: root, stdio: "inherit" });

const files = {
  "/": `<!doctype html><script src="/jszip.js"></script>
    <script type="importmap">{"imports":{"docx-preview":"/docx-preview.mjs","jszip":"/jszip-shim.js"}}</script>
    <script type="module">import { docxPreviewHtml } from "/docx.js"; window.render = (b64) => docxPreviewHtml(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));</script>`,
  "/jszip.js": readFileSync(join(root, "node_modules/jszip/dist/jszip.min.js")),
  "/jszip-shim.js": "export default window.JSZip;",
  "/docx-preview.mjs": readFileSync(join(require.resolve("docx-preview").replace(/docx-preview\.js$/, ""), "docx-preview.mjs")),
  "/docx.js": readFileSync(join(out, "docx.js")),
};
const browser = await pw.chromium.launch({ executablePath: chrome });
const page = await browser.newPage();
await page.route("http://test.local/**", (route) => {
  const path = new URL(route.request().url()).pathname;
  const body = files[path];
  if (body === undefined) return route.fulfill({ status: 404 });
  return route.fulfill({ body, contentType: path.endsWith("js") || path.endsWith("mjs") ? "text/javascript" : "text/html" });
});
await page.goto("http://test.local/");
await page.waitForFunction(() => typeof window.render === "function");

const docx = readFileSync(join(root, "tests/fixtures/rich.docx"));
const printed = async (html) => {
  const p = await browser.newPage();
  await p.setContent(html, { waitUntil: "load" });
  const pdf = await p.pdf({ preferCSSPageSize: true, printBackground: true });
  await p.close();
  // Embedded font names, e.g. /BaseFont /AAAAAA+Georgia-Bold.
  const fontNames = [...new Set([...Buffer.from(pdf).toString("latin1").matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/\]>]+)/g)].map((m) => m[1]))];
  const doc = await openPdf(new Uint8Array(pdf));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    const { width, height } = pg.getViewport({ scale: 1 });
    const content = await pg.getTextContent();
    const items = content.items.filter((t) => t.str.trim());
    const ops = await pg.getOperatorList();
    pages.push({
      width, height,
      text: items.map((t) => t.str).join(" ").replace(/\s+/g, " "),
      xs: items.map((t) => t.transform[4]),
      images: ops.fnArray.filter((f) => f === 85 || f === 86).length, // paintImageXObject / paintInlineImageXObject
    });
  }
  pages.fonts = fontNames;
  return pages;
};

const now = await printed(await page.evaluate((b64) => window.render(b64), docx.toString("base64")));
const { docxHtml } = await import(join(out, "html.js"));
const before = await printed(await docxHtml(new Uint8Array(docx)));
const summary = (pages) => `${pages.length} pages, sizes ${[...new Set(pages.map((p) => `${Math.round(p.width)}×${Math.round(p.height)}`))].join(" / ")}`;
console.log(`      docx-preview: ${summary(now)}`);
console.log(`      mammoth (before): ${summary(before)}`);
const all = now.map((p) => p.text).join(" | ");
const has = (pages, s) => pages.some((p) => p.text.includes(s));

await test("header on every page of the first section", () => {
  eq(now.slice(0, 2).every((p) => p.text.includes("Northwind Quarterly")), true, "header text");
  console.log(`      (mammoth: header ${has(before, "Northwind Quarterly") ? "kept" : "lost"})`);
});
await test("later sections inherit the header and footer, with live page numbers", () => {
  eq(now.every((p) => p.text.includes("Northwind Quarterly")), true, "header on every page");
  eq(now.map((p) => (p.text.match(/Page (\d+) of (\d+)/) ?? []).slice(1).join("/")).join(" "), now.map((_, i) => `${i + 1}/${now.length}`).join(" "), "page numbers");
});
await test("page break, two columns and landscape section kept", () => {
  eq(now.findIndex((p) => p.text.includes("After the page break")) > now.findIndex((p) => p.text.includes("Quarterly Review")), true, "page break");
  const cols = now.find((p) => p.text.includes("Two columns"));
  const mid = cols.width / 2;
  eq(cols.xs.some((x) => x < mid - 20) && cols.xs.some((x) => x > mid + 10), true, "text in both columns");
  const last = now[now.length - 1];
  eq(last.text.includes("Landscape appendix") && last.width > last.height, true, "landscape last page");
  console.log(`      (mammoth: landscape page ${before.some((p) => p.width > p.height) ? "kept" : "lost"})`);
});
await test("image, table, numbered list and fonts kept", () => {
  eq(now.some((p) => p.images > 0), true, "image");
  eq(/Region Q1 Q2 North 1,200 1,350/.test(all), true, "table text in order");
  // Chrome writes "fi" as a ligature, which extracts as "fi " — compare without spaces.
  const flat = all.replace(/\s+/g, "");
  eq(flat.includes("1.Collectthefigures") && flat.includes("3.Sendthereport"), true, "numbered list");
  eq(now.fonts.some((f) => /georgia/i.test(f)), true, `Georgia embedded (fonts: ${now.fonts.join(", ")})`);
});

await browser.close();
process.exit(results.failed ? 1 : 0);
