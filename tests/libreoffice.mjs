// High-fidelity Office → PDF: the LibreOffice WASM build the browser loads,
// run here through its Node API. Checks that Word, OpenDocument, Excel and
// PowerPoint files come out with their structure intact, and that the export
// options (src/lib/office/export.ts) change the PDF the way they say.
//
//   node tests/libreoffice.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { convertDocument, createWorkerConverter } from "@matbee/libreoffice-converter";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { Document, Packer, Paragraph, ImageRun } from "docx";
import { root, openPdf, check, eq } from "./lib/load.mjs";
import { exportPdf } from "../src/lib/office/export.ts";

const results = { failed: 0 };
const test = check(results);
const require = createRequire(join(root, "package.json"));
const wasmPath = join(require.resolve("@matbee/libreoffice-converter/package.json"), "..", "wasm");
const convert = async (data, outputFormat = "pdf") => (await convertDocument(data, { outputFormat }, { wasmPath })).data;

async function pages(pdfBytes) {
  const pdf = await openPdf(new Uint8Array(pdfBytes));
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const { width, height } = p.getViewport({ scale: 1 });
    out.push({ width, height, text: (await p.getTextContent()).items.map((t) => t.str).join(" ").replace(/\s+/g, " ") });
  }
  return out;
}

const docx = readFileSync(join(root, "tests/fixtures/rich.docx"));
const word = await pages(await convert(docx));

await test("Word: header, live page numbers and landscape section", () => {
  eq(word.every((p) => p.text.includes("Northwind Quarterly")), true, "header on every page");
  eq(word.map((p) => (p.text.match(/Page (\d+) of (\d+)/) ?? []).slice(1).join("/")).join(" "), word.map((_, i) => `${i + 1}/${word.length}`).join(" "), "page numbers");
  const last = word[word.length - 1];
  eq(last.text.includes("Landscape appendix") && last.width > last.height, true, "landscape last page");
  eq(/1\.\s*Collect the figures/.test(word.map((p) => p.text).join(" ")), true, "numbered list");
});

await test("OpenDocument text converts the same way", async () => {
  const odt = await convert(docx, "odt");
  const fromOdt = await pages(await convert(odt));
  eq(fromOdt.length, word.length, "page count");
  eq(fromOdt[0].text.includes("Quarterly Review"), true, "content");
});

await test("Excel: every sheet, numbers as formatted", async () => {
  const wb = new ExcelJS.Workbook();
  const a = wb.addWorksheet("Revenue");
  a.addRows([["Region", "Q1", "Q2"], ["North", 1200, 1350], ["West", 2040, 2210]]);
  a.getColumn(2).numFmt = "#,##0";
  a.getColumn(3).numFmt = "#,##0";
  wb.addWorksheet("Notes").addRow(["Second sheet note"]);
  const pdf = await pages(await convert(new Uint8Array(await wb.xlsx.writeBuffer())));
  const all = pdf.map((p) => p.text).join(" | ");
  eq(/North 1,200 1,350/.test(all), true, `formatted numbers (got "${all.slice(0, 80)}")`);
  eq(all.includes("Second sheet note"), true, "second sheet");
});

await test("PowerPoint: one landscape page per slide", async () => {
  const deck = new PptxGenJS();
  deck.addSlide().addText("Launch plan", { x: 1, y: 1, w: 8, h: 1, fontSize: 36 });
  deck.addSlide().addText("Milestones and owners", { x: 1, y: 1, w: 8, h: 1, fontSize: 28 });
  const pdf = await pages(await convert(new Uint8Array(await deck.write({ outputType: "arraybuffer" }))));
  eq(pdf.length, 2, "pages");
  eq(pdf.every((p) => p.width > p.height), true, "landscape");
  eq(pdf[0].text.includes("Launch plan") && pdf[1].text.includes("Milestones and owners"), true, "slide text");
});

// The export options, through the same pipeline the browser runs (one
// LibreOffice for all of them).
const lo = await createWorkerConverter({ wasmPath });
const run = (data, name, options) =>
  exportPdf((bytes, format, file, filterOptions) => lo.convert(bytes, { outputFormat: format, filterOptions }, file).then((r) => r.data), new Uint8Array(data), name, options);
const catalog = async (bytes) => {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const md = pdf.catalog.lookup(PDFName.of("Metadata"));
  return {
    pdf,
    outline: Boolean(pdf.catalog.get(PDFName.of("Outlines"))),
    tagged: Boolean(pdf.catalog.get(PDFName.of("StructTreeRoot"))),
    xmp: md ? Buffer.from(md.getContents()).toString("utf8") : "",
  };
};
// The widest image in a PDF, in pixels, and how it's compressed.
const images = (pdf) =>
  pdf.context.enumerateIndirectObjects().map(([, o]) => o).filter((o) => o instanceof PDFRawStream && String(o.dict.get(PDFName.of("Subtype"))) === "/Image")
    .map((o) => ({ width: o.dict.get(PDFName.of("Width")).asNumber(), filter: String(o.dict.get(PDFName.of("Filter"))) }));
// Headings with outline levels, made the way Word writes them (LibreOffice's own DOCX export).
const headed = (await lo.convert(new TextEncoder().encode("<html><body><h1>Introduction</h1><p>One.</p><h2>Details</h2><p>Two.</p></body></html>"), { outputFormat: "docx" }, "h.html")).data;

await test("Word options: a page range keeps just those pages", async () => {
  const out = await pages(await run(docx, "rich.docx", { officeRange: "2-3" }));
  eq(out.length, 2, "pages");
  eq(out[0].text.includes("Page 2 of"), true, `first page is page 2 (got "${out[0].text.slice(0, 60)}")`);
});

await test("Word options: a page range past the end is the user's mistake", async () => {
  const err = await run(docx, "rich.docx", { officeRange: "40-41" }).then(() => null, (e) => e);
  eq(err?.code, "bad_ranges", `error (${err})`);
  eq((await pages(await run(docx, "rich.docx", {}))).length, word.length, "LibreOffice still converts afterwards");
});

await test("Word options: bookmarks from headings, on by default and off on request", async () => {
  const on = await catalog(await run(headed, "h.docx", {}));
  eq(on.outline, true, "outline by default");
  const titles = [];
  for (let item = on.pdf.catalog.lookup(PDFName.of("Outlines")).lookup(PDFName.of("First")); item; item = item.lookup(PDFName.of("Next"))) titles.push(item.lookup(PDFName.of("Title")).decodeText());
  eq(titles[0], "Introduction", "first bookmark");
  eq((await catalog(await run(headed, "h.docx", { officeBookmarks: false }))).outline, false, "no outline when off");
});

await test("Word options: tagged PDF for screen readers", async () => {
  eq((await catalog(await run(headed, "h.docx", {}))).tagged, false, "untagged by default");
  eq((await catalog(await run(headed, "h.docx", { officeTagged: true }))).tagged, true, "StructTreeRoot");
});

await test("Word options: PDF/A-2b identifies itself", async () => {
  eq(/pdfaid:part/.test((await catalog(await run(headed, "h.docx", {}))).xmp), false, "not PDF/A by default");
  const { xmp } = await catalog(await run(headed, "h.docx", { officePdfa: "2b" }));
  eq((xmp.match(/pdfaid:part(?:>|=")(\d)/) ?? [])[1], "2", "pdfaid:part");
  eq((xmp.match(/pdfaid:conformance(?:>|=")(\w)/) ?? [])[1], "B", "pdfaid:conformance");
  const a1 = await catalog(await run(headed, "h.docx", { officePdfa: "1b" }));
  eq((a1.xmp.match(/pdfaid:part(?:>|=")(\d)/) ?? [])[1], "1", "PDF/A-1b part");
});

await test("Word options: image quality lowers resolution, lossless keeps every pixel", async () => {
  const { createCanvas } = require("@napi-rs/canvas");
  const canvas = createCanvas(1600, 1600);
  const g = canvas.getContext("2d");
  for (let i = 0; i < 4000; i++) {
    g.fillStyle = `hsl(${(i * 37) % 360} 70% 50%)`;
    g.fillRect((i * 97) % 1600, (i * 53) % 1600, 40, 40);
  }
  const photo = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph({ children: [new ImageRun({ type: "png", data: canvas.toBuffer("image/png"), transformation: { width: 192, height: 192 } })] })] }] }));
  const widest = async (o) => Math.max(...images((await catalog(await run(photo, "photo.docx", o))).pdf).map((i) => i.width));
  const [lossless, high, low] = [await widest({ officeImages: "lossless" }), await widest({ officeImages: "high" }), await widest({ officeImages: "low" })];
  eq(lossless, 1600, "lossless keeps the original pixels");
  eq(high <= 2 * 300 + 2 && high > low, true, `high (${high} px for 2 in) is at most 300 dpi and above low`);
  eq(low <= 2 * 75 + 2, true, `low (${low} px for 2 in) is at most 75 dpi`);
  const kinds = images((await catalog(await run(photo, "photo.docx", { officeImages: "low" }))).pdf).map((i) => i.filter);
  eq(kinds.includes("/DCTDecode"), true, `low is JPEG (${kinds})`);
});

// Three sheets, each 30 columns wide (wide enough to show each cell whole)
// and 60 rows long: too wide for a page.
const wideBook = new ExcelJS.Workbook();
for (const name of ["Wide", "Second", "Third"]) {
  const ws = wideBook.addWorksheet(name);
  ws.columns = Array.from({ length: 30 }, () => ({ width: 14 }));
  for (let r = 0; r < 60; r++) ws.addRow(Array.from({ length: 30 }, (_, c) => `${name}R${r}C${c}`));
}
const wide = new Uint8Array(await wideBook.xlsx.writeBuffer());
// Rows whose first and last columns are on different pages.
const split = (out) => out.filter((p) => {
  const first = [...p.text.matchAll(/(\w+R\d+)C0\b/g)].map((m) => m[1]).sort().join();
  const last = [...p.text.matchAll(/(\w+R\d+)C29\b/g)].map((m) => m[1]).sort().join();
  return first !== last;
}).length;

await test("Excel options: fit to page width keeps every row whole", async () => {
  const plain = await pages(await run(wide, "wide.xlsx", {}));
  eq(split(plain) > 0, true, "columns split across pages by default");
  const fit = await pages(await run(wide, "wide.xlsx", { sheetFit: "width" }));
  eq(split(fit), 0, "pages with a split row");
  eq(fit.length < plain.length, true, `${fit.length} pages, fewer than ${plain.length}`);
  eq(fit.map((p) => p.text).join(" ").includes("ThirdR59C29"), true, "last cell of the last sheet");
  // A long sheet still runs onto more pages, at a readable size.
  const longBook = new ExcelJS.Workbook();
  const ws = longBook.addWorksheet("Long");
  ws.columns = Array.from({ length: 30 }, () => ({ width: 14 }));
  for (let r = 0; r < 400; r++) ws.addRow(Array.from({ length: 30 }, (_, c) => `LongR${r}C${c}`));
  const long = await pages(await run(new Uint8Array(await longBook.xlsx.writeBuffer()), "long.xlsx", { sheetFit: "width" }));
  eq(long.length > 1, true, `${long.length} pages for 400 rows`);
  eq(split(long), 0, "long sheet: pages with a split row");
});

await test("Excel options: one page per sheet", async () => {
  const out = await pages(await run(wide, "wide.xlsx", { sheetFit: "page" }));
  eq(out.length, 3, "pages");
  eq(out.every((p, i) => p.text.includes(`${["Wide", "Second", "Third"][i]}R59C29`)), true, "each sheet whole on its page");
  eq(out.every((p) => p.width < 700 && p.height < 900), true, "paper-sized pages");
});

await test("Excel options: chosen sheets only, by number or name", async () => {
  const one = await pages(await run(wide, "wide.xlsx", { sheetFit: "page", sheetPick: "2" }));
  eq(one.length, 1, "pages for sheet 2");
  eq(one[0].text.includes("SecondR0C0") && !/Wide|Third/.test(one[0].text), true, "only the second sheet");
  const two = await pages(await run(wide, "wide.xlsx", { sheetFit: "page", sheetPick: "third, 1" }));
  eq(two.map((p) => p.text.match(/^(\w+?)R0C0/)?.[1]).join(), "Wide,Third", "first and third, in workbook order");
  const plain = await pages(await run(wide, "wide.xlsx", { sheetPick: "1" }));
  eq(plain.every((p) => !/Second|Third/.test(p.text)), true, "without fitting too");
});

await test("Excel options: a sheet choice that matches nothing is the user's mistake", async () => {
  const err = await run(wide, "wide.xlsx", { sheetPick: "7, Totals" }).then(() => null, (e) => e);
  eq(err?.code, "bad_sheets", `error (${err})`);
});

await test("Excel options: OpenDocument and old Excel files fit too", async () => {
  for (const format of ["ods", "xls"]) {
    const other = (await lo.convert(wide, { outputFormat: format }, "wide.xlsx")).data;
    const fit = await pages(await run(other, `wide.${format}`, { sheetFit: "width", sheetPick: "Second" }));
    eq(split(fit), 0, `${format}: split rows`);
    eq(fit.every((p) => p.text.includes("Second") && !/Wide|Third/.test(p.text)), true, `${format}: only the second sheet`);
  }
});

const notedDeck = new PptxGenJS();
notedDeck.addSlide().addText("Opening slide", { x: 1, y: 1, w: 8, h: 1 });
const hidden = notedDeck.addSlide();
hidden.addText("Backup slide", { x: 1, y: 1, w: 8, h: 1 });
hidden.hidden = true;
notedDeck.addSlide().addText("Closing slide", { x: 1, y: 1, w: 8, h: 1 });
notedDeck.addSlide().addNotes("Thank the team");
const noted = new Uint8Array(await notedDeck.write({ outputType: "arraybuffer" }));

await test("PowerPoint options: hidden slides left out unless asked for", async () => {
  const plain = await pages(await run(noted, "deck.pptx", {}));
  eq(plain.length, 3, "pages without hidden slides");
  eq(plain.some((p) => p.text.includes("Backup slide")), false, "hidden slide left out");
  const all = await pages(await run(noted, "deck.pptx", { hiddenSlides: true }));
  eq(all.length, 4, "pages with hidden slides");
  eq(all[1].text.includes("Backup slide"), true, "hidden slide in its place");
});

await test("PowerPoint options: notes pages after the slides, or instead of them", async () => {
  const both = await pages(await run(noted, "deck.pptx", { slideNotes: "both" }));
  eq(both.length, 6, "slides then notes pages");
  eq(both[5].text.includes("Thank the team") && both[5].height > both[5].width, true, "portrait notes page with the notes");
  const notes = await pages(await run(noted, "deck.pptx", { slideNotes: "notes" }));
  eq(notes.length, 3, "notes pages only");
  eq(notes.every((p) => p.height > p.width), true, "all portrait");
});

process.exit(results.failed ? 1 : 0);
