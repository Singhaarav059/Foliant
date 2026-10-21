// Table detection tests: builds PDFs with known tables and checks what
// src/lib/pdf/tables.ts finds in them. Runs in Node, no browser needed.
//
//   node tests/tables.mjs
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, load, openPdf } from "./lib/load.mjs";

const { findTables, pageEdges, grid } = await load("tables");
const { pageText } = await load("text");
const { pdfToExcel, pdfToWord, pdfToMarkdown } = await load("convert");
const ExcelJS = (await import("exceljs")).default;
const JSZip = (await import("jszip")).default;

// ── Fixtures

async function make(draw) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const H = 842;
  const text = (s, x, top, o = {}) => page.drawText(s, { x, y: H - top - 10, size: 10, font: o.bold ? bold : font });
  const line = (x0, y0, x1, y1, t = 0.8) => page.drawLine({ start: { x: x0, y: H - y0 }, end: { x: x1, y: H - y1 }, thickness: t, color: rgb(0, 0, 0) });
  const rect = (x, top, w, h, o = {}) => page.drawRectangle({ x, y: H - top - h, width: w, height: h, ...o });
  draw({ text, line, rect, doc, page, font, H });
  return doc.save();
}

const fixtures = {
  // Full grid, header cell spanning two columns.
  async gridMerged() {
    return make(({ text, line }) => {
      const xs = [60, 200, 330, 460, 540];
      const ys = [100, 124, 148, 172, 196];
      text("Quarterly results", 60, 60, { bold: true });
      for (const y of ys) line(xs[0], y, xs[4], y);
      // No rule between B and C in the header row, so B1:C1 is one cell.
      for (const [k, x] of xs.entries()) line(x, k === 2 ? ys[1] : ys[0], x, ys[4]);
      ["Region", "Revenue (2025)", null, "Growth"].forEach((h, k) => h && text(h, xs[k] + 6, 106, { bold: true }));
      [["North", "1,200", "1,350", "12.5%"], ["South", "980", "1,010", "3.1%"], ["West", "2,450", "2,600", "6.1%"]]
        .forEach((r, i) => r.forEach((c, k) => text(c, xs[k] + 6, ys[i + 1] + 6)));
      text("Figures in thousands of euros.", 60, 220);
    });
  },
  // Rules above, below the header and at the bottom only (report style).
  async booktabs() {
    return make(({ text, line }) => {
      text("Table 2. Sample sizes", 60, 60, { bold: true });
      line(60, 90, 500, 90, 1.2);
      ["Group", "n", "Mean", "SD"].forEach((h, k) => text(h, [64, 240, 330, 430][k], 96, { bold: true }));
      line(60, 112, 500, 112, 0.6);
      [["Control", "48", "12.4", "3.1"], ["Treatment A", "51", "14.9", "2.8"], ["Treatment B", "47", "15.2", "3.4"]]
        .forEach((r, i) => r.forEach((c, k) => text(c, [64, 240, 330, 430][k], 118 + i * 18)));
      line(60, 174, 500, 174, 1.2);
    });
  },
  // Two columns of prose between a header rule and a footer rule: not a table.
  async twoColumnProse() {
    return make(({ text, line }) => {
      line(50, 50, 545, 50);
      const words = "The quick brown fox jumps over the lazy dog while the committee reviews the annual report in detail".split(" ");
      for (let i = 0; i < 30; i++) {
        const s = words.slice(i % 5, (i % 5) + 9).join(" ");
        text(s, 50, 70 + i * 14);
        text(s, 310, 70 + i * 14);
      }
      line(50, 520, 545, 520);
    });
  },
  // A framed note: one box, not a table.
  async framedNote() {
    return make(({ text, rect }) => {
      rect(60, 100, 400, 60, { borderColor: rgb(0, 0, 0), borderWidth: 1 });
      text("Note: this box is a callout, not a table.", 70, 120);
    });
  },
  // Filled cell backgrounds and thin filled rectangles instead of stroked lines.
  async filledRules() {
    return make(({ text, rect }) => {
      const xs = [60, 180, 300, 420];
      const ys = [100, 122, 144, 166];
      rect(60, 100, 360, 22, { color: rgb(0.9, 0.9, 0.95) });
      for (const y of ys) rect(60, y - 0.4, 360, 0.8, { color: rgb(0, 0, 0) });
      for (const x of xs) rect(x - 0.4, 100, 0.8, 66, { color: rgb(0, 0, 0) });
      [["Item", "Qty", "Price"], ["Pens", "10", "2.50"], ["Paper", "5", "4.00"]]
        .forEach((r, i) => r.forEach((c, k) => text(c, xs[k] + 6, ys[i] + 6, { bold: i === 0 })));
    });
  },
  // Bordered form fields above a real 2x2 table. A field's appearance is an
  // annotation drawn in its own coordinates, not page content: read as page
  // content, the boxes all land on the page origin and stack into cells.
  async formFieldAndTable() {
    return make(({ text, line, doc, page, font, H }) => {
      const form = doc.getForm();
      [["Name", 240, "Ada Lovelace"], ["Email", 160, ""], ["Phone", 120, ""]].forEach(([label, width, value], i) => {
        const field = form.createTextField(label.toLowerCase());
        if (value) field.setText(value);
        field.addToPage(page, { x: 120, y: H - 82 - i * 30, width, height: 22, borderColor: rgb(0, 0, 0), borderWidth: 1, font });
        text(label, 60, 66 + i * 30);
      });
      const xs = [60, 240, 420];
      const ys = [180, 204, 228];
      for (const y of ys) line(xs[0], y, xs[2], y);
      for (const x of xs) line(x, ys[0], x, ys[2]);
      [["Item", "Qty"], ["Pens", "10"]].forEach((r, i) => r.forEach((c, k) => text(c, xs[k] + 6, ys[i] + 6)));
    });
  },
};

// ── Expectations

const expect = {
  gridMerged: (L) => {
    const t = only(L, 1);
    eq(`${t.rows}x${t.cols}`, "4x4", "size");
    const head = t.cells.find((c) => c.row === 0 && c.col === 1);
    eq(head?.colSpan, 2, "merged header span");
    eq(head?.text, "Revenue (2025)", "merged header text");
    eq(grid(t)[1].map((c) => c?.text).join("|"), "North|1,200|1,350|12.5%", "row 1");
    has(L, "Figures in thousands of euros.");
    has(L, "Quarterly results");
  },
  booktabs: (L) => {
    const t = only(L, 1);
    eq(`${t.rows}x${t.cols}`, "4x4", "size");
    eq(grid(t)[2].map((c) => c?.text).join("|"), "Treatment A|51|14.9|2.8", "row 2");
    eq(t.ruled, false, "columns from text");
  },
  twoColumnProse: (L) => only(L, 0),
  framedNote: (L) => { only(L, 0); has(L, "Note: this box is a callout, not a table."); },
  filledRules: (L) => {
    const t = only(L, 1);
    eq(`${t.rows}x${t.cols}`, "3x3", "size");
    eq(grid(t)[2].map((c) => c?.text).join("|"), "Paper|5|4.00", "row 2");
  },
  formFieldAndTable: (L) => {
    const t = only(L, 1);
    eq(`${t.rows}x${t.cols}`, "2x2", "size");
    eq(grid(t).map((r) => r.map((c) => c?.text).join("|")).join("/"), "Item|Qty/Pens|10", "cells");
    const corner = t.cells.find((c) => Math.min(c.x, L.width - c.x - c.w) < 40 && Math.min(c.y, L.height - c.y - c.h) < 40);
    if (corner) throw new Error(`cell near a page corner at ${Math.round(corner.x)},${Math.round(corner.y)}`);
    // The filled value reads where the field shows it: inside its box, beside "Name".
    const value = L.lines.flatMap((l) => l.runs).find((r) => r.text.includes("Ada Lovelace"));
    if (!value) throw new Error("field value missing from the text");
    if (!(value.x > 120 && value.x < 360 && value.y > 60 && value.y + value.h < 82))
      throw new Error(`field value at ${Math.round(value.x)},${Math.round(value.y)}, outside its field`);
  },
};

function only(L, n) {
  if (L.tables.length !== n) throw new Error(`expected ${n} table(s), found ${L.tables.length}`);
  return L.tables[0];
}
function eq(a, b, what) {
  if (a !== b) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function has(L, text) {
  if (!L.lines.some((l) => l.text === text)) throw new Error(`text outside tables missing: ${text}`);
}

let failed = 0;
for (const [name, build] of Object.entries(fixtures)) {
  const bytes = await build();
  if (process.env.SAVE) writeFileSync(join(process.env.SAVE, `${name}.pdf`), bytes);
  const doc = await openPdf(bytes);
  const page = await doc.getPage(1);
  const layout = findTables(await pageText(page), await pageEdges(page));
  try {
    expect[name](layout);
    console.log(`ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${e.message}`);
    for (const t of layout.tables) console.log(`      table ${t.rows}x${t.cols}:`, grid(t).map((r) => r.map((c) => c?.text ?? "").join(" | ")));
  }
}
// The shared fixtures: prints what is found, so false tables show up.
for (const name of ["report.pdf", "report-v2.pdf"]) {
  const doc = await openPdf(new Uint8Array(readFileSync(join(root, "tests/fixtures", name))));
  const found = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    found.push(...findTables(await pageText(page), await pageEdges(page)).tables.map((t) => `p${i} ${t.rows}x${t.cols}: ${grid(t)[0].map((c) => c?.text ?? "").join(" | ")}`));
  }
  console.log(`${found.length ? "INFO" : "ok  "}  ${name}: ${found.length} table(s)`, found.join("; "));
}

// ── Conversions keep the detected structure

const conversions = {
  async excel(bytes) {
    const [xlsx] = await pdfToExcel(new File([bytes], "t.pdf"), { sheetPer: "page" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await xlsx.blob.arrayBuffer());
    const ws = wb.worksheets[0];
    const row = ws.getRow(3); // title, header, North
    eq(row.values.slice(1).join("|"), "North|1200|1350|0.125", "row values as numbers");
    eq(ws.getCell("C2").isMerged && ws.getCell("C2").master.address, "B2", "merged header");
  },
  async word(bytes) {
    const [docx] = await pdfToWord(new File([bytes], "t.pdf"), { wordMode: "editable" });
    const xml = await (await JSZip.loadAsync(await docx.blob.arrayBuffer())).file("word/document.xml").async("string");
    eq((xml.match(/<w:tbl>/g) ?? []).length, 1, "tables");
    eq((xml.match(/<w:tr[ >]/g) ?? []).length, 4, "rows");
    eq(/<w:gridSpan w:val="2"\/>/.test(xml), true, "merged header");
    eq(xml.includes("Figures in thousands of euros."), true, "text after table");
  },
  async markdown(bytes) {
    const [md] = await pdfToMarkdown(new File([bytes], "t.pdf"), { pageBreaks: false });
    const text = await md.blob.text();
    eq(text.includes("| North | 1,200 | 1,350 | 12.5% |"), true, "table row");
    eq(text.includes("| --- | --- | --- | --- |"), true, "header separator");
  },
};
const sample = await fixtures.gridMerged();
for (const [name, check] of Object.entries(conversions)) {
  try {
    await check(sample);
    console.log(`ok    convert:${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  convert:${name}: ${e.message}`);
  }
}

process.exit(failed ? 1 : 0);
