// Word, PowerPoint and Excel → PDF in the static build make a real PDF file
// with the default options, on a host that sends no isolation headers and in
// a browser that has never seen the site: the first conversion asks once for
// the LibreOffice download, reloads the page by itself to become
// cross-origin isolated, and picks the job up again. Then the export options
// chosen in the page change the PDF. Desktop Chromium by default;
// BROWSER=webkit or firefox tries another engine.
//
//   npm run build:static
//   node tests/e2e-office.mjs [dir=out]
//
// The test serves the build itself, without the headers in out/_headers, the
// way GitHub Pages would (PORT, default 3203). BASE_URL tests a running site
// instead. CHROME_PATH runs an installed Chrome instead of Playwright's Chromium.
import pw from "playwright-core";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFName } from "pdf-lib";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { Document, Packer, Paragraph, HeadingLevel, PageBreak } from "docx";

const here = dirname(fileURLToPath(import.meta.url));
const downloads = mkdtempSync(join(tmpdir(), "e2e-office-"));
let failed = 0;

// /a → a.html or a/index.html, as scripts/serve-static.mjs and Cloudflare Pages resolve it.
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".woff2": "font/woff2", ".png": "image/png" };
let server = null;
let base = process.env.BASE_URL;
if (!base) {
  const dir = resolve(process.argv[2] ?? join(here, "../out"));
  if (!existsSync(join(dir, "en"))) throw new Error(`no static build in ${dir}: run npm run build:static`);
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  server = createServer((req, res) => {
    const target = join(dir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    const file = target.startsWith(dir) && [target, `${target}.html`, join(target, "index.html")].find(isFile);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  const port = Number(process.env.PORT ?? 3203);
  await new Promise((ok) => server.listen(port, ok));
  base = `http://localhost:${port}`;
}

const engine = process.env.BROWSER ?? "chromium";
const browser = await pw[engine].launch(engine === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
// A new context is a fresh profile: no service worker, no stored consent, no cached LibreOffice.
const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const alerts = [];
page.on("dialog", (d) => { alerts.push(d.message()); d.dismiss(); });
let loads = 0;
page.on("load", () => loads++);
// Console errors, from the page and its workers: LibreOffice's own log lines
// must stay out of them (P3-02; scripts/vendor.mjs quiets its worker).
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));

const test = async (label, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    console.log(`ok    ${label} (${Math.round((Date.now() - t0) / 1000)} s): ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}: ${e.message.split("\n")[0].slice(0, 300)}`);
  }
};
const hydrated = () => page.waitForFunction(() => {
  const input = document.querySelector("input[type=file]");
  return input && Object.keys(input).some((k) => k.startsWith("__reactProps"));
}, null, { timeout: 30000 });
const open = async (path) => {
  await page.goto(base + path, { waitUntil: "load" });
  await hydrated();
};
// The text of a PDF, as pdf.js reads it, and the program that wrote it.
async function pdfText(path) {
  const bytes = new Uint8Array(readFileSync(path));
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new Error(`not a PDF: starts with ${JSON.stringify(Buffer.from(bytes.subarray(0, 8)).toString("latin1"))}`);
  const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(" "));
  const text = pages.map((p) => p + "\n").join("");
  return { text, pages, producer: String((await doc.getMetadata()).info?.Producer ?? "") };
}
// What the PDF's catalog says about it: bookmarks, tags, PDF/A.
async function catalog(path) {
  const pdf = await PDFDocument.load(readFileSync(path), { updateMetadata: false });
  const md = pdf.catalog.lookup(PDFName.of("Metadata"));
  const xmp = md ? Buffer.from(md.getContents()).toString("utf8") : "";
  return {
    outline: Boolean(pdf.catalog.get(PDFName.of("Outlines"))),
    tagged: Boolean(pdf.catalog.get(PDFName.of("StructTreeRoot"))),
    pdfa: (xmp.match(/pdfaid:part(?:>|=")(\d)/) ?? [])[1],
  };
}
// Waits for the result to download, failing at once if an error message or a
// print preview shows instead.
async function download(trigger, timeout) {
  // Not Next's route announcer, which reads out the page title after navigating.
  const alert = page.locator("[role=alert]:not(#__next-route-announcer__)").filter({ hasText: /\S/ }).first();
  const error = alert.waitFor({ timeout }).then(async () => { throw new Error(`alert: ${await alert.innerText()}`); });
  const preview = page.locator("iframe").first().waitFor({ timeout }).then(() => { throw new Error("a print preview instead of a PDF file"); });
  // Still pending when the download wins.
  error.catch(() => {});
  preview.catch(() => {});
  const [dl] = await Promise.race([Promise.all([page.waitForEvent("download", { timeout }), trigger()]), error, preview]);
  const path = join(downloads, dl.suggestedFilename());
  await dl.saveAs(path);
  return path;
}

await test("Word → PDF on a first visit: one consent, a real PDF", async () => {
  await open("/en/word-to-pdf");
  // Without the headers the page starts out not isolated, so the job has to go through the reload.
  const isolatedAtFirst = await page.evaluate(() => crossOriginIsolated);
  await page.locator("input[type=file]").first().setInputFiles(join(here, "fixtures/brief.docx"));
  const before = loads;
  const path = await download(async () => {
    await page.getByRole("button", { name: "Convert to PDF", exact: true }).click();
    await page.getByRole("button", { name: "Download and convert", exact: true }).click({ timeout: 15000 });
  }, 300000);
  if (!/\.pdf$/.test(path)) throw new Error(`downloaded ${path}`);
  const { text, producer } = await pdfText(path);
  if (!text.includes("Project brief")) throw new Error(`text was ${JSON.stringify(text.slice(0, 80))}`);
  if (!/LibreOffice/.test(producer)) throw new Error(`written by ${producer}`);
  if (alerts.length) throw new Error(`alert: ${alerts.join(" | ")}`);
  if (consoleErrors.length) throw new Error(`${consoleErrors.length} console errors, e.g. ${consoleErrors[0]}`);
  const reloads = loads - before;
  if (!isolatedAtFirst && reloads !== 1) throw new Error(`${reloads} reloads, expected 1`);
  return `isolated at first ${isolatedAtFirst}, ${reloads} reload, "Project brief" found, written by ${producer}`;
});

await test("the PDF continues into another tool", async () => {
  await page.getByRole("link", { name: "Compress PDF" }).click();
  await page.waitForURL(/\/en\/compress-pdf/);
  await page.getByText("brief.pdf").first().waitFor({ timeout: 15000 });
  const path = await download(() => page.getByRole("button", { name: "Compress PDF", exact: true }).click(), 60000);
  const { text } = await pdfText(path);
  if (!text.includes("Project brief")) throw new Error("compressed PDF lost its text");
  return "compressed";
});

await test("Excel → PDF afterwards: one click, no questions", async () => {
  await open("/en/excel-to-pdf");
  await page.locator("input[type=file]").first().setInputFiles(join(here, "fixtures/budget.xlsx"));
  const path = await download(() => page.getByRole("button", { name: "Convert to PDF", exact: true }).click(), 300000);
  const { text, producer } = await pdfText(path);
  if (!text.includes("Hosting")) throw new Error(`text was ${JSON.stringify(text.slice(0, 80))}`);
  if (!/LibreOffice/.test(producer)) throw new Error(`written by ${producer}`);
  return '"Hosting" found';
});

// Fixtures for the export options, made here.
const made = (name, bytes) => {
  const path = join(downloads, name);
  writeFileSync(path, bytes);
  return path;
};
const sections = [];
for (const [i, title] of ["Overview", "Budget", "Timeline"].entries()) {
  if (i) sections.push(new Paragraph({ children: [new PageBreak()] }));
  sections.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, outlineLevel: 0 }), new Paragraph(`Section ${i + 1}`));
}
const report = made("sections.docx", await Packer.toBuffer(new Document({ sections: [{ children: sections }] })));
const book = new ExcelJS.Workbook();
for (const name of ["Wide", "Second"]) {
  const ws = book.addWorksheet(name);
  ws.columns = Array.from({ length: 30 }, () => ({ width: 14 }));
  for (let r = 0; r < 60; r++) ws.addRow(Array.from({ length: 30 }, (_, c) => `${name}R${r}C${c}`));
}
const wide = made("wide.xlsx", new Uint8Array(await book.xlsx.writeBuffer()));
const deck = new PptxGenJS();
deck.addSlide().addText("Opening slide", { x: 1, y: 1, w: 8, h: 1 });
const backup = deck.addSlide();
backup.addText("Backup slide", { x: 1, y: 1, w: 8, h: 1 });
backup.hidden = true;
deck.addSlide().addText("Closing slide", { x: 1, y: 1, w: 8, h: 1 }).addNotes("Thank the team");
const slides = made("deck.pptx", new Uint8Array(await deck.write({ outputType: "arraybuffer" })));
const convert = async (path, choose) => {
  await page.locator("input[type=file]").first().setInputFiles(path);
  await choose();
  return download(() => page.getByRole("button", { name: "Convert to PDF", exact: true }).click(), 300000);
};

await test("Word → PDF options: pages, PDF/A, tags, bookmarks", async () => {
  await open("/en/word-to-pdf");
  const path = await convert(report, async () => {
    await page.getByLabel("Pages (blank for all)").fill("2-3");
    await page.getByLabel("PDF/A for archiving").selectOption("2b");
    await page.getByLabel("Tagged PDF for screen readers").check({ force: true });
  });
  const { pages } = await pdfText(path);
  const info = await catalog(path);
  if (pages.length !== 2 || !pages[0].includes("Budget")) throw new Error(`pages ${JSON.stringify(pages)}`);
  if (info.pdfa !== "2" || !info.tagged || !info.outline) throw new Error(`catalog ${JSON.stringify(info)}`);
  await open("/en/word-to-pdf");
  const plain = await convert(report, () => page.getByLabel("Bookmarks from headings").uncheck({ force: true }));
  if ((await catalog(plain)).outline) throw new Error("bookmarks when turned off");
  return `pages 2-3, PDF/A-${info.pdfa}, tagged, bookmarks on and then off`;
});

await test("Excel → PDF options: fit to page width, chosen sheet", async () => {
  await open("/en/excel-to-pdf");
  const path = await convert(wide, async () => {
    await page.getByRole("radio", { name: /Fit to page width/ }).click();
    await page.getByLabel("Sheets (blank for all)").fill("Second");
  });
  const { pages } = await pdfText(path);
  const rows = (p, c) => [...p.matchAll(new RegExp(`(\\w+R\\d+)C${c}\\b`, "g"))].map((m) => m[1]).join();
  if (pages.some((p) => /Wide/.test(p) || rows(p, 0) !== rows(p, 29))) throw new Error(`pages ${JSON.stringify(pages.map((p) => p.slice(0, 40)))}`);
  if (!pages.join(" ").includes("SecondR59C29")) throw new Error("last cell missing");
  return `${pages.length} page(s), every row whole, only "Second"`;
});

await test("PowerPoint → PDF options: hidden slides and notes pages", async () => {
  await open("/en/powerpoint-to-pdf");
  const path = await convert(slides, async () => {
    await page.getByRole("radio", { name: /Slides, then notes pages/ }).click();
    await page.getByLabel("Include hidden slides").check({ force: true });
  });
  const { pages } = await pdfText(path);
  if (pages.length !== 6 || !pages[1].includes("Backup slide") || !pages[5].includes("Thank the team")) throw new Error(`pages ${JSON.stringify(pages)}`);
  return "3 slides with the hidden one, then 3 notes pages";
});

await browser.close();
server?.close();
process.exit(failed ? 1 : 0);
