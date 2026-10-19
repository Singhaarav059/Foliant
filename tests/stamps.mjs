// Page numbers, Bates numbers and watermarks (src/lib/pdf/edit.ts): custom
// templates and number styles, a Bates counter that runs on across a batch,
// the font families, CJK marks that extract as one string, and a page whose
// content ends inside an inline image.
//
//   node tests/stamps.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, refOpen, fileOf, ROOT } from "./robustness/env.mjs";

const { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFArray, StandardFonts, decodePDFRawStream } = await import("pdf-lib");
const { pageNumbers, watermark } = await load("edit");
const { pdfium } = await load("pdfium");
const results = { failed: 0 };
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    results.failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

async function blank(pages, name = "doc.pdf") {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) d.addPage([612, 792]).drawText(`BODY${i + 1}`, { x: 72, y: 700, size: 12, font });
  return fileOf(await d.save(), name);
}

const bytesOf = async (o) => new Uint8Array(await o.blob.arrayBuffer());

// Each page's text as pdf.js gives it, items joined with spaces (as tests/robustness does).
async function texts(bytes) {
  const doc = await refOpen(bytes);
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    out.push((await p.getTextContent()).items.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim());
  }
  await doc.loadingTask.destroy();
  return out;
}

// The first page's text as PDFium extracts it (it honours /ActualText).
async function pdfiumText(bytes) {
  const m = await pdfium();
  const { malloc, free } = m.pdfium.wasmExports;
  const heap = () => m.pdfium.HEAPU8;
  const file = malloc(bytes.length);
  heap().set(bytes, file);
  const doc = m.FPDF_LoadMemDocument(file, bytes.length, "");
  const page = m.FPDF_LoadPage(doc, 0);
  const tp = m.FPDFText_LoadPage(page);
  const n = m.FPDFText_CountChars(tp);
  const buf = malloc((n + 1) * 2);
  m.FPDFText_GetText(tp, 0, n, buf);
  const s = Buffer.from(heap().slice(buf, buf + n * 2)).toString("utf16le");
  free(buf);
  m.FPDFText_ClosePage(tp);
  m.FPDF_ClosePage(page);
  m.FPDF_CloseDocument(doc);
  free(file);
  return s;
}

// A page's content streams, decoded and joined.
async function content(bytes, index = 0) {
  const d = await PDFDocument.load(bytes);
  const c = d.getPages()[index].node.Contents();
  const refs = c instanceof PDFArray ? c.asArray() : [c];
  return refs.map((r) => {
    const s = d.context.lookup(r);
    return s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString("latin1") : "";
  }).join("\n");
}

// Embedded fonts: base name and whether the font program is in the file.
async function fonts(bytes) {
  const d = await PDFDocument.load(bytes);
  const out = [];
  for (const [, o] of d.context.enumerateIndirectObjects()) {
    const dict = o instanceof PDFDict ? o : null;
    if (dict?.get(PDFName.of("Type")) !== PDFName.of("FontDescriptor")) continue;
    out.push({ name: String(dict.get(PDFName.of("FontName"))), embedded: ["FontFile", "FontFile2", "FontFile3"].some((k) => dict.has(PDFName.of(k))) });
  }
  return out;
}

const NUM = { position: "bottom-center", numberFormat: "n", startAt: 1, pageRange: "", skipFirst: false, fontSize: 11, color: "#1f2937", facing: false };
const MARK = { markType: "text", markText: "CONFIDENTIAL", fontSize: 56, color: "#d33f6a", imageScale: 40, position: "middle-center", mosaic: false, opacity: 30, rotation: "45", layer: "over", pageRange: "" };

await test("custom template: 'Sheet {page}/{pages}' gives 'Sheet 2/3' on page 2", async () => {
  const [o] = await pageNumbers(await blank(3), { ...NUM, numberFormat: "custom", template: "Sheet {page}/{pages}" });
  const t = await texts(await bytesOf(o));
  for (let i = 0; i < 3; i++) if (!t[i].includes(`Sheet ${i + 1}/3`)) throw new Error(`page ${i + 1}: ${JSON.stringify(t[i])}`);
});

await test("number styles: i, I, a, A", async () => {
  const want = { i: ["i", "ii", "iii", "iv"], I: ["I", "II", "III", "IV"], a: ["a", "b", "c", "d"], A: ["A", "B", "C", "D"] };
  for (const [style, labels] of Object.entries(want)) {
    const [o] = await pageNumbers(await blank(4), { ...NUM, numberFormat: "custom", template: "[{page}/{pages}]", numberStyle: style });
    const t = await texts(await bytesOf(o));
    labels.forEach((l, i) => { if (!t[i].includes(`[${l}/${labels[3]}]`)) throw new Error(`${style} page ${i + 1}: ${JSON.stringify(t[i])}`); });
  }
});

await test("skip the first 1 and last 2 pages", async () => {
  const [o] = await pageNumbers(await blank(5), { ...NUM, numberFormat: "custom", template: "<{page}>", skipFirst: 1, skipLast: 2 });
  const t = await texts(await bytesOf(o));
  eq(JSON.stringify(t.map((s) => s.match(/<(\d+)>/)?.[1] ?? null)), JSON.stringify([null, "1", "2", null, null]), "labels");
});

await test("Bates: prefix ABC across two 3-page files stamps ABC000001 to ABC000006", async () => {
  const counter = { next: 1 };
  const opts = { ...NUM, numberFormat: "bates", batesPrefix: "ABC", batesDigits: 6, counter };
  const all = [];
  for (const name of ["a.pdf", "b.pdf"]) {
    const [o] = await pageNumbers(await blank(3, name), opts);
    all.push(...(await texts(await bytesOf(o))));
  }
  all.forEach((t, i) => {
    const want = `ABC${String(i + 1).padStart(6, "0")}`;
    if (!t.includes(want)) throw new Error(`page ${i + 1}: expected ${want}, got ${JSON.stringify(t)}`);
  });
});

await test("margins: large sits further from the edge than small", async () => {
  const y = async (margin) => {
    const [o] = await pageNumbers(await blank(1), { ...NUM, margin });
    const doc = await refOpen(await bytesOf(o));
    const item = (await (await doc.getPage(1)).getTextContent()).items.find((x) => x.str === "1");
    return item.transform[5];
  };
  const small = await y("small"), normal = await y("normal"), large = await y("large");
  if (!(small < normal && normal < large)) throw new Error(`baselines small ${small}, normal ${normal}, large ${large}`);
});

await test("watermark: the Times font choice embeds a serif font", async () => {
  const [o] = await watermark(await blank(1), { ...MARK, font: "tinos" });
  const f = await fonts(await bytesOf(o));
  if (!f.some((x) => /Tinos/.test(x.name) && x.embedded)) throw new Error(`fonts: ${JSON.stringify(f)}`);
  const t = await texts(await bytesOf(o));
  if (!t[0].includes("CONFIDENTIAL")) throw new Error(`text: ${t[0]}`);
});

await test("page numbers: the monospace font choice embeds Cousine", async () => {
  const [o] = await pageNumbers(await blank(1), { ...NUM, font: "cousine" });
  const f = await fonts(await bytesOf(o));
  if (!f.some((x) => /Cousine/.test(x.name) && x.embedded)) throw new Error(`fonts: ${JSON.stringify(f)}`);
});

await test("watermark: '机密文件' extracts as one string, with no spaces", async () => {
  const [o] = await watermark(await blank(1), { ...MARK, markText: "机密文件" });
  const bytes = await bytesOf(o);
  const s = await content(bytes);
  // The runs (one per font slice) sit inside one marked-content span that carries the whole text.
  const m = s.match(/\/ActualText\s*<([0-9A-Fa-f]+)>[^]*?BDC([^]*?)EMC/);
  if (!m) throw new Error("no /ActualText span around the mark");
  eq(Buffer.from(m[1], "hex").swap16().toString("utf16le").replace(/^﻿/, ""), "机密文件", "ActualText");
  if ((m[2].match(/\bTj\b/g) ?? []).length < 2) throw new Error("the span doesn't hold the runs");
  const text = await pdfiumText(bytes);
  if (!text.includes("机密文件")) throw new Error(`PDFium text: ${JSON.stringify(text)}`);
});

await test("watermark: {filename} and {date}", async () => {
  const [o] = await watermark(await blank(1, "Q3 report.pdf"), { ...MARK, markText: "{filename} {date}", rotation: "0" });
  const t = (await texts(await bytesOf(o)))[0];
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (!t.includes(`Q3 report ${today}`)) throw new Error(JSON.stringify(t));
});

await test("watermark: continuous angle, background box and tile spacing", async () => {
  const [o] = await watermark(await blank(1), { ...MARK, rotation: 30, markBox: true });
  const s = await content(await bytesOf(o));
  // The box is a white filled path drawn just before the text.
  if (!/1 1 1 rg[^]*?\bf\s[^]*?BT/.test(s)) throw new Error("no background box");
  if (!/0\.866\d* 0\.5 -0\.5 0\.866\d* [\d.]+ [\d.]+ Tm/.test(s.replace(/0\.49999+\d*/g, "0.5"))) throw new Error("text not at 30°");
  const tiles = async (tileSpacing) => {
    const [t] = await watermark(await blank(1), { ...MARK, mosaic: true, tileSpacing });
    return ((await content(await bytesOf(t))).match(/\bTj\b/g) ?? []).length;
  };
  const tight = await tiles(60), loose = await tiles(200);
  if (!(tight > loose)) throw new Error(`tiles at 60%: ${tight}, at 200%: ${loose}`);
});

await test("malformed-content.pdf: page 5 (content ends inside an inline image) shows 'Page 5 of 7'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stamps-"));
  try {
    const r = spawnSync(process.execPath, [join(ROOT, "tests/robustness/gen.mjs"), dir, "^malformed-content"], { stdio: ["ignore", "ignore", "inherit"] });
    if (r.status !== 0) throw new Error("gen.mjs failed");
    const f = fileOf(readFileSync(join(dir, "malformed-content.pdf")), "malformed-content.pdf");
    const [o] = await pageNumbers(f, { ...NUM, numberFormat: "pageNOfTotal" });
    const t = await texts(await bytesOf(o));
    if (!t[4].includes("Page 5 of 7")) throw new Error(`page 5: ${JSON.stringify(t[4])}`);
    const [w] = await watermark(f, MARK);
    const wt = await texts(await bytesOf(w));
    if (!wt[4].includes("CONFIDENTIAL")) throw new Error(`watermark page 5: ${JSON.stringify(wt[4])}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test("a 3 x 3 pt page: the label and the mark shrink to stay on it", async () => {
  // pdf.js leaves out glyphs that fall outside the page, so text found means text on the page.
  const d = await PDFDocument.create();
  d.addPage([3, 3]);
  const f = fileOf(await d.save(), "tiny.pdf");
  const [o] = await pageNumbers(f, { ...NUM, numberFormat: "pageNOfTotal" });
  eq((await texts(await bytesOf(o)))[0], "Page 1 of 1", "label");
  const [w] = await watermark(f, MARK);
  eq((await texts(await bytesOf(w)))[0], "CONFIDENTIAL", "mark");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
