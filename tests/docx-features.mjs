// Word → PDF in the static build (docx-preview, src/lib/office/docx.ts): a
// continuous section break stays on the page, footnotes are printed, and a
// simple PAGE field in the footer counts the pages. The .docx files are built
// here with the docx package, the footer field rewritten as <w:fldSimple>.
// Printed with Chrome like the print dialog (see tests/lib/chrome.mjs).
//
// Cases listed in tests/known-failures.json fail because of a product bug:
// they print KNOWN and don't fail the run, and fail it once they pass.
//
//   node tests/docx-features.mjs
import pw from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { Document, Packer, Paragraph, TextRun, Footer, FootnoteReferenceRun, PageBreak, SectionType } from "docx";
import { root, openPdf, eq } from "./lib/load.mjs";
import { requireChrome } from "./lib/chrome.mjs";

const chrome = requireChrome();
const known = JSON.parse(readFileSync(join(root, "tests/known-failures.json"), "utf8"));
let failed = 0;
const test = async (name, fn) => {
  const why = known[`docx-features: ${name}`];
  try {
    await fn();
    if (why) {
      failed++;
      console.log(`FAIL  ${name}: passes now; remove it from tests/known-failures.json (${why})`);
    } else console.log(`ok    ${name}`);
  } catch (e) {
    if (why) console.log(`KNOWN ${name}: ${e.message} (${why})`);
    else {
      failed++;
      console.log(`FAIL  ${name}: ${e.message}`);
    }
  }
};

const require = createRequire(join(root, "package.json"));
const out = mkdtempSync(join(tmpdir(), "docx-features-"));
execFileSync(join(root, "node_modules/.bin/tsc"), ["--outDir", out, "--module", "esnext", "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck", "--noCheck", "--lib", "es2022,dom", "src/lib/office/docx.ts"], { cwd: root, stdio: "inherit" });

// Page 1: a paragraph with a footnote, a continuous section break, more text;
// then a page break and page 2. Every page's footer reads "Folio <PAGE>".
// `firstContinuous` also marks the first section continuous (where the first
// section's own type has no effect); Word marks only the second.
const FOLIO = "FOLIOFIELD";
async function build(firstContinuous) {
  const doc = new Document({
    creator: "Nopload tests",
    footnotes: { 1: { children: [new Paragraph("Source: the 2025 ledger, audited in March.")] } },
    sections: [
      {
        properties: firstContinuous ? { type: SectionType.CONTINUOUS } : {},
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun("Folio "), new TextRun(FOLIO)] })] }) },
        children: [new Paragraph({ children: [new TextRun("Opening section before the continuous break"), new FootnoteReferenceRun(1)] })],
      },
      {
        properties: { type: SectionType.CONTINUOUS },
        children: [new Paragraph("Continued section on the same page"), new Paragraph({ children: [new PageBreak()] }), new Paragraph("Second page text")],
      },
    ],
  });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  for (const name of Object.keys(zip.files).filter((n) => /^word\/footer\d*\.xml$/.test(n))) {
    const xml = await zip.file(name).async("string");
    // A simple field with a stale cached result, as Word often leaves it.
    const fixed = xml.replace(new RegExp(`<w:r><w:t[^>]*>${FOLIO}</w:t></w:r>`), '<w:fldSimple w:instr=" PAGE "><w:r><w:t>9</w:t></w:r></w:fldSimple>');
    if (fixed === xml) throw new Error("fixture: footer field not rewritten");
    zip.file(name, fixed);
  }
  const body = await zip.file("word/document.xml").async("string");
  if ((body.match(/<w:type w:val="continuous"\/>/g) ?? []).length !== (firstContinuous ? 2 : 1)) throw new Error("fixture: section types");
  return zip.generateAsync({ type: "nodebuffer" });
}

const files = {
  "/": `<!doctype html><script src="/jszip.js"></script>
    <script type="importmap">{"imports":{"docx-preview":"/docx-preview.mjs","jszip":"/jszip-shim.js","/settled":"/settled.js"}}</script>
    <script type="module">import { docxPreviewHtml } from "/docx.js"; window.render = (b64) => docxPreviewHtml(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));</script>`,
  "/jszip.js": readFileSync(join(root, "node_modules/jszip/dist/jszip.min.js")),
  "/jszip-shim.js": "export default window.JSZip;",
  "/docx-preview.mjs": readFileSync(join(require.resolve("docx-preview").replace(/docx-preview\.js$/, ""), "docx-preview.mjs")),
  "/docx.js": readFileSync(join(out, "docx.js")),
  // docx.ts imports "./settled" (src/lib/office/settled.ts); the import map sends it here.
  "/settled.js": readFileSync(join(out, "settled.js")),
};
const browser = await pw.chromium.launch({ executablePath: chrome });
try {
  const page = await browser.newPage();
  await page.route("http://test.local/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = files[path];
    if (body === undefined) return route.fulfill({ status: 404 });
    return route.fulfill({ body, contentType: path.endsWith("js") || path.endsWith("mjs") ? "text/javascript" : "text/html" });
  });
  await page.goto("http://test.local/");
  await page.waitForFunction(() => typeof window.render === "function");
  // Each printed page's text.
  const printed = async (docx, name) => {
    if (process.env.SAVE) writeFileSync(join(process.env.SAVE, name), docx);
    const html = await page.evaluate((b64) => window.render(b64), docx.toString("base64"));
    const p = await browser.newPage();
    await p.setContent(html, { waitUntil: "load" });
    const pdf = await openPdf(new Uint8Array(await p.pdf({ preferCSSPageSize: true, printBackground: true })));
    await p.close();
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) pages.push((await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join(" ").replace(/\s+/g, " "));
    console.log(`      ${name}: ${pages.length} pages: ${pages.map((t) => JSON.stringify(t.slice(0, 60))).join(" | ")}`);
    return pages;
  };
  const sameSheet = (pages) => {
    eq(pages.length, 2, "pages");
    eq(pages[0].includes("Opening section") && pages[0].includes("Continued section on the same page"), true, "both sections on page 1");
    eq(pages[1].includes("Second page text"), true, "page break kept");
  };

  const pages = await printed(await build(true), "features.docx");
  await test("a continuous section break stays on the same page", () => sameSheet(pages));
  await test("the footnote is printed", () => eq(pages[0].includes("Source: the 2025 ledger"), true, "footnote text on page 1"));
  await test("a simple PAGE field in the footer counts the pages", () => eq(pages.map((t) => t.match(/Folio (\d+)/)?.[1] ?? "-").join(" "), "1 2", "folios"));

  const word = await printed(await build(false), "continuous-word.docx");
  await test("a continuous break marked on the next section only (as Word saves it)", () => sameSheet(word));
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
