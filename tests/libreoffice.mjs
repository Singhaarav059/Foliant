// High-fidelity Office → PDF: the LibreOffice WASM build the browser loads,
// run here through its Node API. Checks that Word, OpenDocument, Excel and
// PowerPoint files come out with their structure intact.
//
//   node tests/libreoffice.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import PptxGenJS from "pptxgenjs";
import { convertDocument } from "@matbee/libreoffice-converter";
import { root, openPdf, check, eq } from "./lib/load.mjs";

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

process.exit(results.failed ? 1 : 0);
