// Regression net for PDF → Word, tables and layout: each test pins one piece
// of structure a converter can quietly lose (bold runs, heading styles, the
// header on the first section, merged cells, wrapped cells, table order, a
// one-page memo's first line, text inside a figure, mailto links, pictures).
// Runs in Node; pictures are cut with a Node canvas (tests/lib/load.mjs).
//
//   node tests/word-structure.mjs
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

nodeCanvas();
const { documentLayout } = await load("layout");
const { findTables, pageEdges, grid } = await load("tables");
const { pageText } = await load("text");
const { pdfToWord, pdfToMarkdown, pdfToExcel } = await load("convert");
const ExcelJS = (await import("exceljs")).default;
const results = { failed: 0 };
const test = check(results);
const save = (name, bytes) => process.env.SAVE && writeFileSync(join(process.env.SAVE, name), bytes);

// A w×h PNG in two colours, so a picture is a real image without any files.
function png(w = 40, h = 20) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let x = 0xffffffff;
    for (const v of b) x = table[(x ^ v) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(x < w / 2 ? [30, 90, 200] : [240, 130, 40], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const docxParts = async (bytes, name) => {
  const [docx] = await pdfToWord(new File([bytes], name), { wordMode: "editable" });
  const zip = await JSZip.loadAsync(await docx.blob.arrayBuffer());
  const read = (n) => zip.file(n)?.async("string");
  return { zip, xml: await read("word/document.xml"), rels: await read("word/_rels/document.xml.rels") };
};
// The <w:r> runs and <w:p> paragraphs whose text contains `s`.
const runsWith = (xml, s) => [...xml.matchAll(/<w:r>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g)].map((m) => m[0]).filter((r) => r.includes(s));
const paragraphWith = (xml, s) => [...xml.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*<\/w:p>/g)].map((m) => m[0]).find((p) => p.includes(s));

// ── A two-page newsletter: running header, heading, bold label, picture
// with a caption drawn inside it, and a mailto link.

async function newsletter() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const image = await doc.embedPng(png(120, 80));
  const H = 842;
  for (let p = 1; p <= 2; p++) {
    const page = doc.addPage([595, H]);
    const t = (s, x, top, o = {}) => page.drawText(s, { x, y: H - top - (o.size ?? 10), size: o.size ?? 10, font: o.font ?? font, color: o.color });
    t("Acme Newsletter", 50, 30, { size: 8 });
    t(p === 1 ? "Spring Update" : "Inside This Issue", 50, 70, { size: 22, font: bold });
    for (let i = 0; i < 10; i++) t(`Line ${p}.${i} of the body text runs across the page here`, 50, 120 + i * 14);
    if (p !== 1) continue;
    t("Warning:", 50, 270, { font: bold });
    t("handle with care", 98, 270);
    // A chart with its label drawn on top: the label is part of the picture.
    page.drawImage(image, { x: 50, y: H - 520, width: 300, height: 200 });
    t("Chart label inside", 120, 410, { color: rgb(1, 1, 1) });
    t("Write to jane@example.com for copies.", 50, 560);
    const w = font.widthOfTextAtSize("Write to ", 10);
    const link = doc.context.obj({
      Type: "Annot", Subtype: "Link", Rect: [50 + w, H - 572, 50 + w + font.widthOfTextAtSize("jane@example.com", 10), H - 559], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of("mailto:jane@example.com") },
    });
    page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
  }
  return doc.save();
}

const news = await newsletter();
save("newsletter.pdf", news);
const newsPages = await documentLayout(await openPdf(news.slice()));
const newsDocx = await docxParts(news, "news.pdf");

await test("word: 'Warning:' stays bold", () => {
  const runs = runsWith(newsDocx.xml, "Warning:");
  eq(runs.length > 0, true, "a run with 'Warning:'");
  eq(runs.every((r) => /<w:b\/>/.test(r)), true, "bold");
});

await test("word: 'Spring Update' is a Heading 1", () => {
  eq(/<w:pStyle w:val="Heading1"\/>/.test(paragraphWith(newsDocx.xml, "Spring Update") ?? ""), true, "Heading1 style");
});

await test("word: the first section carries the running header", () => {
  const first = newsDocx.xml.match(/<w:sectPr\b(?:(?!<\/w:sectPr>)[\s\S])*<\/w:sectPr>/)?.[0] ?? "";
  eq(/<w:headerReference\b/.test(first), true, "headerReference in the first sectPr");
});

await test("word: the picture is kept as a drawing", () => {
  eq(/<w:drawing>/.test(newsDocx.xml), true, "<w:drawing>");
  eq(Object.keys(newsDocx.zip.files).some((n) => /^word\/media\//.test(n)), true, "image in word/media");
});

await test("layout: a label drawn inside a figure stays in the picture", () => {
  eq(newsPages[0].figures.length, 1, "figures");
  const lines = newsPages[0].sections.flatMap((s) => s.columns.flatMap((c) => c.items.flatMap((i) => (i.kind === "lines" ? i.lines.map((l) => l.text) : []))));
  eq(lines.some((t) => t.includes("Chart label")), false, "label not in the text flow");
  eq(newsDocx.xml.includes("Chart label inside"), false, "label not in the Word text");
});

await test("layout and word: a mailto link survives", () => {
  eq(newsPages[0].rest.find((r) => r.text.includes("jane@example.com"))?.link, "mailto:jane@example.com", "link on the run");
  eq((newsDocx.rels ?? "").includes("mailto:jane@example.com"), true, "hyperlink target in the .docx");
});

// ── A one-page memo: its first line sits in the header band, but one page
// can't show that it repeats, so it's body text.

async function memo() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const t = (s, top) => page.drawText(s, { x: 50, y: 842 - top - 10, size: 10, font });
  t("Memo to all staff about the office move", 40);
  for (let i = 0; i < 12; i++) t(`The move starts on Friday and line ${i} explains what to pack and where to go.`, 120 + i * 14);
  return doc.save();
}

const memoBytes = await memo();
save("memo.pdf", memoBytes);

await test("layout: a one-page memo's first line isn't a header", async () => {
  const [p] = await documentLayout(await openPdf(memoBytes.slice()));
  eq(p.header.length, 0, "header lines");
  const [md] = await pdfToMarkdown(new File([memoBytes], "memo.pdf"), { pageBreaks: false });
  eq((await md.blob.text()).includes("Memo to all staff"), true, "first line kept in the Markdown");
});

// ── Two ruled tables on one page. The first has a bold header row, a cell
// whose text wraps onto two lines, and a cell merged down two rows.

async function twoTables() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const H = 842;
  const text = (s, x, top, b = false) => page.drawText(s, { x, y: H - top - 10, size: 10, font: b ? bold : font });
  const line = (x0, y0, x1, y1) => page.drawLine({ start: { x: x0, y: H - y0 }, end: { x: x1, y: H - y1 }, thickness: 0.8, color: rgb(0, 0, 0) });

  // Table 1: 4 rows × 3 columns; rows 1–2 share column 0 ("Fruit"); row 3's description wraps.
  text("Stock list", 60, 60, true);
  const xs = [60, 180, 380, 500];
  const ys = [100, 124, 148, 172, 210];
  for (const [i, y] of ys.entries()) line(i === 2 ? xs[1] : xs[0], y, xs[3], y); // no rule under "Fruit" in column 0
  for (const x of xs) line(x, ys[0], x, ys[4]);
  ["Group", "Description", "Count"].forEach((h, k) => text(h, xs[k] + 6, ys[0] + 6, true));
  text("Fruit", xs[0] + 6, ys[1] + 6);
  [["Apples from the north", "120"], ["Pears from the south", "80"]].forEach((r, i) => r.forEach((c, k) => text(c, xs[k + 1] + 6, ys[i + 1] + 6)));
  text("Roots", xs[0] + 6, ys[3] + 6);
  text("Long description that", xs[1] + 6, ys[3] + 6);
  text("wraps onto two lines", xs[1] + 6, ys[3] + 20);
  text("45", xs[2] + 6, ys[3] + 6);

  // Table 2, further down: 3 rows × 2 columns.
  text("Shipping codes", 60, 300, true);
  const xs2 = [60, 240, 420];
  const ys2 = [330, 354, 378, 402];
  for (const y of ys2) line(xs2[0], y, xs2[2], y);
  for (const x of xs2) line(x, ys2[0], x, ys2[3]);
  [["Code", "Carrier"], ["NX1", "Northern Express"], ["SW2", "Southwest Freight"]].forEach((r, i) => r.forEach((c, k) => text(c, xs2[k] + 6, ys2[i] + 6, i === 0)));
  text("Codes change every quarter.", 60, 430);
  return doc.save();
}

const tablesBytes = await twoTables();
save("two-tables.pdf", tablesBytes);
const tablesPage = await (await openPdf(tablesBytes.slice())).getPage(1);
const tl = findTables(await pageText(tablesPage), await pageEdges(tablesPage));
const stock = tl.tables.find((t) => t.cells.some((c) => c.text === "Group"));
const cellOf = (t, s) => t?.cells.find((c) => c.text.startsWith(s));

await test("tables: two tables found, in page order", () => {
  eq(tl.tables.length, 2, "tables");
  eq(tl.tables.map((t) => grid(t)[0][0]?.text).join(" / "), "Group / Code", "order");
});

await test("tables: a wrapped cell joins its lines with a space", () => {
  eq(cellOf(stock, "Long")?.text, "Long description that wraps onto two lines", "cell text");
});

await test("tables: a cell merged down two rows spans them", () => {
  eq(cellOf(stock, "Fruit")?.rowSpan, 2, "rowSpan");
  eq(`${stock.rows}x${stock.cols}`, "4x3", "size");
});

await test("tables: the header row is bold", () => {
  eq(stock.cells.filter((c) => c.row === 0).every((c) => c.bold), true, "header cells bold");
  eq(cellOf(stock, "Apples")?.bold, false, "body cell not bold");
});

const tablesDocx = await docxParts(tablesBytes, "tables.pdf");

await test("word: the merged cell becomes vMerge, tables stay in order", () => {
  eq((tablesDocx.xml.match(/<w:tbl>/g) ?? []).length, 2, "tables");
  eq(/<w:vMerge w:val="restart"\/>/.test(tablesDocx.xml) && /<w:vMerge\/>|<w:vMerge w:val="continue"\/>/.test(tablesDocx.xml), true, "vMerge restart + continue");
  eq(tablesDocx.xml.indexOf("Group") < tablesDocx.xml.indexOf("Carrier"), true, "first table first");
  eq(tablesDocx.xml.includes("Long description that wraps onto two lines") || /Long description that<\/w:t>[\s\S]{0,400}wraps onto two lines/.test(tablesDocx.xml), true, "wrapped cell text");
});

await test("word: the header row's text is bold", () => {
  eq(runsWith(tablesDocx.xml, "Description").every((r) => /<w:b\/>/.test(r)), true, "bold header");
  eq(runsWith(tablesDocx.xml, "Apples").some((r) => /<w:b\/>/.test(r)), false, "body not bold");
});

await test("excel: the wrapped cell is one cell with a space", async () => {
  const [xlsx] = await pdfToExcel(new File([tablesBytes], "t.pdf"), { sheetPer: "page" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await xlsx.blob.arrayBuffer());
  const values = [];
  wb.worksheets[0].eachRow((row) => row.eachCell((c) => values.push(String(c.value))));
  eq(values.includes("Long description that wraps onto two lines"), true, `cell values ${JSON.stringify(values.slice(0, 12))}`);
});

process.exit(results.failed ? 1 : 0);
