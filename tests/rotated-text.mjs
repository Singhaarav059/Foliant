// Rotated text tests: pages turned with Rotate, tables printed sideways and
// labels running up the margin must come out in reading order, never
// reversed ("noigeR", 980 → 89) or one character per cell.
//
//   node tests/rotated-text.mjs
import { PDFDocument, PDFName, StandardFonts, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from "pdf-lib";
import JSZip from "jszip";
import { load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

const { pdfToExcel, pdfToWord, pdfToMarkdown } = await load("convert");
const { rotateAll } = await load("organize");
const { pageText } = await load("text");
const ExcelJS = (await import("exceljs")).default;
const results = { failed: 0 };
const test = check(results);

const W = 612, H = 792, SIZE = 14;
const ROWS = [["Region", "Revenue", "Growth"], ["North", "1,200", "12%"], ["South", "980", "13%"]];

// A borderless table, upright or printed sideways (text turned 90°, no /Rotate).
async function tablePage(sideways = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  ROWS.forEach((r, i) => r.forEach((c, j) => {
    if (sideways) page.drawText(c, { x: 200 + i * 20, y: 100 + j * 150, size: SIZE, font, rotate: degrees(90) });
    else page.drawText(c, { x: 72 + j * 150, y: 700 - i * 20, size: SIZE, font });
  }));
  return new Uint8Array(await doc.save());
}

const turned = async (bytes, angle) => new Uint8Array(await (await rotateAll(new File([bytes], "t.pdf"), angle))[0].blob.arrayBuffer());

async function sheet(bytes) {
  const [xlsx] = await pdfToExcel(new File([bytes], "t.pdf"), { sheetPer: "page" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await xlsx.blob.arrayBuffer());
  const cells = {};
  wb.worksheets[0].eachRow((row) => row.eachCell((c) => (cells[c.address] = c.value)));
  return cells;
}

async function wordText(bytes) {
  const [docx] = await pdfToWord(new File([bytes], "t.pdf"), { wordMode: "editable" });
  const xml = await (await JSZip.loadAsync(await docx.blob.arrayBuffer())).file("word/document.xml").async("string");
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
}

const markdown = async (bytes) => (await (await pdfToMarkdown(new File([bytes], "t.pdf"), { pageBreaks: false }))[0].blob.text()).trim();

const plain = await tablePage();
// Opening a file here first starts pdf.js's worker from the package, not from /vendor.
await openPdf(plain.slice());
const upright = await sheet(plain);
console.log(`      upright sheet: ${JSON.stringify(upright)}`);

for (const angle of [180, 90, 270]) {
  await test(`page turned ${angle}° with Rotate: same sheet as the upright page`, async () => {
    const got = await sheet(await turned(plain, angle));
    eq(JSON.stringify(got), JSON.stringify(upright), "cells");
  });
}

await test("page turned 180°: numbers stay numbers, words read forwards", async () => {
  const got = await sheet(await turned(plain, 180));
  eq(got.A1, "Region", "A1");
  eq(got.B2, 1200, "B2");
  eq(got.B3, 980, "B3");
  const all = Object.values(got).join("|");
  for (const reversed of ["noigeR", "htuoS", "089", "002,1"]) eq(all.includes(reversed), false, `"${reversed}" in the sheet`);
});

await test("page turned 180°: Word and Markdown match the upright page", async () => {
  const bytes = await turned(plain, 180);
  eq((await wordText(bytes)).join("|"), (await wordText(plain)).join("|"), "Word text");
  eq(await markdown(bytes), await markdown(plain), "Markdown");
});

await test("sideways table: Excel rows read Region | Revenue | Growth", async () => {
  const got = await sheet(await tablePage(true));
  console.log(`      sideways sheet: ${JSON.stringify(got)}`);
  const row = (n) => ["A", "B", "C"].map((c) => got[`${c}${n}`]).join("|");
  eq(row(1), "Region|Revenue|Growth", "row 1");
  eq(row(2), "North|1200|0.12", "row 2");
  eq(row(3), "South|980|0.13", "row 3");
});

await test("sideways table: Word and Markdown keep whole words", async () => {
  const bytes = await tablePage(true);
  const words = (await wordText(bytes)).join(" ");
  const md = await markdown(bytes);
  for (const w of ["Region", "Revenue", "Growth", "North", "1,200", "980"]) {
    eq(new RegExp(`(^|[^\\w,])${w}([^\\w,]|$)`).test(words), true, `Word has "${w}"`);
    eq(new RegExp(`(^|[^\\w,])${w}([^\\w,]|$)`).test(md), true, `Markdown has "${w}"`);
  }
});

await test("label running up the margin is one line; body lines untouched", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  const body = ["The committee met on Tuesday to review the plan.", "Members agreed to publish the annual report."];
  body.forEach((s, i) => page.drawText(s, { x: 72, y: 700 - i * 16, size: 11, font }));
  const label = "arXiv:2101.00001v1 [cs.CL] 1 Jan 2021";
  page.drawText(label, { x: 40, y: 250, size: 18, font, rotate: degrees(90) });
  const pdf = await openPdf(new Uint8Array(await doc.save()));
  const text = await pageText(await pdf.getPage(1));
  const lines = text.lines.map((l) => l.text);
  eq(lines.filter((l) => body.includes(l)).length, 2, `body lines in ${JSON.stringify(lines)}`);
  eq(lines.includes(label), true, `label in ${JSON.stringify(lines)}`);
  eq(lines.length, 3, "line count");
});

await test("turned page: boxes stay where the words are seen (for redaction)", async () => {
  const pdf = await openPdf(await turned(plain, 180));
  const text = await pageText(await pdf.getPage(1));
  const run = text.items.find((r) => r.text === "Region");
  eq(Boolean(run), true, `"Region" run in ${JSON.stringify(text.items.map((r) => r.text))}`);
  const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
  // Turned 180°, the word drawn at x 72, baseline 700 is seen ending at 612 − 72, hanging down from y 700.
  const w = font.widthOfTextAtSize("Region", SIZE);
  const near = (a, b, what) => eq(Math.abs(a - b) < 1.5, true, `${what}: ${a.toFixed(1)} vs ${b.toFixed(1)}`);
  near(run.x, W - 72 - w, "left");
  near(run.x + run.w, W - 72, "right");
  near(run.y, 700, "top");
  near(run.y + run.h, 700 + SIZE, "bottom");
});

await test("scan with a short label up the margin: Word keeps the page as seen", async () => {
  nodeCanvas();
  // A portrait scan, dark along its top edge, with a Bates number turned 90°.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  const [w, h] = [61, 79];
  const px = new Uint8Array(w * h * 3).fill(220).fill(20, 0, w * 10 * 3);
  page.node.setXObject(PDFName.of("Scan"), doc.context.register(doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 })));
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(W, 0, 0, H, 0, 0), drawObject("Scan"), popGraphicsState());
  page.drawText("BATES 000123", { x: 590, y: 300, size: 9, font, rotate: degrees(90) });
  const [docx] = await pdfToWord(new File([new Uint8Array(await doc.save())], "scan.pdf"), { wordMode: "editable" });
  const xml = await (await JSZip.loadAsync(await docx.blob.arrayBuffer())).file("word/document.xml").async("string");
  const size = xml.match(/<w:pgSz w:w="(\d+)" w:h="(\d+)"/);
  eq(`${size?.[1]}x${size?.[2]}`, "12240x15840", "page size (twips)");
  const extent = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  eq(Number(extent?.[1]) < Number(extent?.[2]), true, `picture upright (${extent?.[0]})`);
});

await test("turned page with a filled form field: the value reads forwards inside its field", async () => {
  // Rotate 90 with the field turned to match, as a form filled in landscape
  // would be; pdf-lib turns the text inside the field's appearance.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([W, H]);
  page.setRotation(degrees(90));
  const field = doc.getForm().createTextField("name");
  field.setText("Ada Lovelace");
  field.addToPage(page, { x: 288, y: 120, width: 240, height: 22, font, rotate: degrees(90), borderWidth: 1 });
  const pdf = await (await openPdf(new Uint8Array(await doc.save()))).getPage(1);
  const text = await pageText(pdf, { upright: true });
  const value = text.items.find((r) => r.text.includes("Lovelace"));
  eq(value?.text.trim(), "Ada Lovelace", "value as one forward run");
  // The field as seen: its widget rect (pdf-lib turns it about its corner) in the page's view.
  const [rect] = (await pdf.getAnnotations()).map((a) => a.rect);
  const view = pdf.getViewport({ scale: 1, rotation: text.rotation });
  const [x0, y0] = view.convertToViewportPoint(rect[0], rect[1]);
  const [x1, y1] = view.convertToViewportPoint(rect[2], rect[3]);
  const box = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
  eq(box.x1 - box.x0 > box.y1 - box.y0, true, `field reads across the page as seen (${JSON.stringify(box)})`);
  const inside = value.x >= box.x0 && value.x + value.w <= box.x1 && value.y >= box.y0 && value.y + value.h <= box.y1;
  eq(inside, true, `value at ${Math.round(value.x)},${Math.round(value.y)} inside field ${JSON.stringify(box)}`);
});

process.exit(results.failed ? 1 : 0);
