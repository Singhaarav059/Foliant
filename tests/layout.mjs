// Layout tests for PDF → Word and Markdown: reading order across columns,
// headers and footers, styled text, links, lists and pictures.
//
//   node tests/layout.mjs
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "pdf-lib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { load, openPdf, check, eq } from "./lib/load.mjs";

const { documentLayout } = await load("layout");
const { pdfToWord, pdfToMarkdown } = await load("convert");
const results = { failed: 0 };
const test = check(results);

// A 2×2 PNG, so the fixture has a real image without any files.
function png() {
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
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.from([0, 200, 30, 30, 30, 30, 200, 0, 30, 200, 30, 220, 220, 30]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Two pages of a newsletter: header and footer on both, a full-width title,
// then two columns whose lines sit on the same rows (the hard case for reading order).
async function newsletter() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const image = await doc.embedPng(png());
  const H = 842;
  for (let p = 1; p <= 2; p++) {
    const page = doc.addPage([595, H]);
    const t = (s, x, top, o = {}) => page.drawText(s, { x, y: H - top - (o.size ?? 10), size: o.size ?? 10, font: o.font ?? font, color: o.color });
    t("Acme Newsletter", 50, 30, { size: 8 });
    t(`Page ${p} of 2`, 270, 800, { size: 8 });
    t(p === 1 ? "Spring Update" : "Inside This Issue", 50, 70, { size: 22, font: bold });
    for (let i = 0; i < 24; i++) {
      if (i === 8 || i === 16) continue; // paragraph gaps, at the same rows in both columns
      const top = 120 + i * 14;
      t(`Alpha ${p}.${i} left column text runs on here`, 50, top);
      if (i >= 18) continue;
      t(`Beta ${p}.${i} right column text runs on here`, 315, top);
    }
    if (p === 1) {
      t("Read more at", 315, 120 + 18 * 14);
      t("example.com", 380, 120 + 18 * 14);
      const link = doc.context.obj({
        Type: "Annot", Subtype: "Link", Rect: [378, H - 120 - 18 * 14 - 12, 440, H - 120 - 18 * 14 + 1], Border: [0, 0, 0],
        A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/") },
      });
      page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(link)]));
      t("Warning:", 315, 120 + 19 * 14, { font: bold });
      t("handle with care", 363, 120 + 19 * 14, { font: italic, color: rgb(0.8, 0.1, 0.1) });
      page.drawImage(image, { x: 315, y: H - 560, width: 200, height: 120 });
      t("1. First step", 50, 600);
      t("2. Second step", 50, 614);
      t("3. Third step", 50, 628);
    }
  }
  return doc.save();
}

const bytes = await newsletter();
if (process.env.SAVE) writeFileSync(join(process.env.SAVE, "newsletter.pdf"), bytes);
const doc = await openPdf(bytes.slice());
const pages = await documentLayout(doc);
const p1 = pages[0];
const texts = (section) => section.columns.map((c) => c.items.flatMap((i) => (i.kind === "lines" ? i.lines.map((l) => l.text) : [i.kind])));

await test("header and footer found on every page", () => {
  eq(pages.map((p) => p.header.map((l) => l.text).join("|")).join(" / "), "Acme Newsletter / Acme Newsletter", "headers");
  eq(pages.map((p) => p.footer.map((l) => l.text).join("|")).join(" / "), "Page 1 of 2 / Page 2 of 2", "footers");
});

await test("title is its own band, body is two columns", () => {
  eq(p1.sections.length, 2, "sections");
  eq(p1.sections[0].columns.length, 1, "title columns");
  eq(texts(p1.sections[0])[0][0], "Spring Update", "title");
  eq(p1.sections[1].columns.length, 2, "body columns");
  const [left, right] = texts(p1.sections[1]);
  eq(left.every((t) => !t.includes("Beta")), true, "left column holds only left text");
  eq(right.some((t) => t.includes("Beta 1.0")), true, "right column starts with the right text");
});

await test("picture found and placed in the right column", () => {
  eq(p1.figures.length, 1, "figures");
  eq(texts(p1.sections[1])[1].includes("figure"), true, "figure in right column");
});

await test("link, colour and italics survive", () => {
  const runs = p1.rest;
  eq(runs.find((r) => r.text.includes("example.com"))?.link, "https://example.com/", "link");
  const care = runs.find((r) => r.text.includes("handle with care"));
  eq(care?.italic, true, "italic");
  eq(care?.color, "#cc1a1a", "colour");
});

await test("word: columns, header, page field, link, styles, numbered list", async () => {
  const [docx] = await pdfToWord(new File([bytes], "n.pdf"), { wordMode: "editable" });
  const zip = await JSZip.loadAsync(await docx.blob.arrayBuffer());
  const xml = await zip.file("word/document.xml").async("string");
  const rels = await zip.file("word/_rels/document.xml.rels").async("string");
  const parts = Object.keys(zip.files);
  const header = await zip.file(parts.find((f) => /word\/header\d*\.xml/.test(f))).async("string");
  const footer = await zip.file(parts.find((f) => /word\/footer\d*\.xml/.test(f))).async("string");
  eq(/<w:cols [^>]*w:num="2"/.test(xml), true, "two-column section");
  eq(xml.includes('<w:br w:type="column"/>'), true, "column break");
  eq(header.includes("Acme Newsletter"), true, "header text");
  eq(/PAGE/.test(footer) && /NUMPAGES/.test(footer), true, "page fields in footer");
  eq(rels.includes("https://example.com/"), true, "hyperlink target");
  eq(/<w:color w:val="CC1A1A"\/>/i.test(xml) && xml.includes("<w:i/>"), true, "colour and italics");
  eq((xml.match(/<w:numPr>/g) ?? []).length, 3, "numbered list items");
  eq(xml.includes("Acme Newsletter"), false, "header not repeated in the body");
  const alpha = xml.indexOf("Alpha 1.23");
  const beta = xml.indexOf("Beta 1.0 ");
  eq(alpha > 0 && beta > alpha, true, "left column comes before right column");
});

await test("markdown: reading order, link, emphasis, list, no furniture", async () => {
  const [md] = await pdfToMarkdown(new File([bytes], "n.pdf"), { pageBreaks: false });
  const text = await md.blob.text();
  eq(text.startsWith("# Spring Update"), true, "title first");
  eq(text.indexOf("Alpha 1.23") < text.indexOf("Beta 1.0 "), true, "columns in order");
  eq(text.includes("[example.com](https://example.com/)"), true, "link");
  eq(text.includes("**Warning:** *handle with care*"), true, "bold and italics");
  eq(text.includes("1. First step\n2. Second step"), true, "numbered list");
  eq(/Acme Newsletter|Page \d of 2/.test(text), false, "headers and footers left out");
});

// A plain report: one column of wrapped paragraphs and a borderless table.
async function report() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const page = doc.addPage([595, 842]);
  const t = (s, x, top, f = font, size = 11) => page.drawText(s, { x, y: 842 - top - size, size, font: f });
  t("Annual Report", 72, 72, bold, 18);
  const prose = "The board met four times this year and approved the budget for the coming period after a long review of costs";
  for (let i = 0; i < 6; i++) t(prose.slice(0, 90 - (i === 5 ? 40 : 0)), 72, 110 + i * 14);
  [["Region", "Sales", "Change"], ["North", "1,200", "+4%"], ["South", "950", "-2%"], ["East", "1,430", "+9%"]]
    .forEach((r, i) => r.forEach((c, k) => t(c, [72, 220, 330][k], 220 + i * 16, i === 0 ? bold : font)));
  for (let i = 0; i < 3; i++) t(prose.slice(0, 90), 72, 300 + i * 14);
  return doc.save();
}
const reportBytes = await report();
const [r1] = await documentLayout(await openPdf(reportBytes.slice()));

await test("single column stays one column, prose isn't a table", () => {
  eq(r1.sections.length, 1, "sections");
  eq(r1.sections[0].columns.length, 1, "columns");
  const kinds = r1.sections[0].columns[0].items.map((i) => i.kind).join(",");
  eq(kinds, "lines,table,lines", "items");
});

await test("borderless table becomes a Word table between paragraphs", async () => {
  const [docx] = await pdfToWord(new File([reportBytes], "r.pdf"), { wordMode: "editable" });
  const xml = await (await JSZip.loadAsync(await docx.blob.arrayBuffer())).file("word/document.xml").async("string");
  eq((xml.match(/<w:tbl>/g) ?? []).length, 1, "tables");
  eq((xml.match(/<w:tr[ >]/g) ?? []).length, 4, "rows");
  eq(/<w:cols [^>]*w:num="2"/.test(xml), false, "no columns");
  eq(xml.includes('w:ascii="Times New Roman"'), true, "font family");
});

// A filled form: the field values are drawn by the fields' appearance streams,
// in their own coordinates, and belong where the fields are shown.
async function form() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const H = 842;
  const page = doc.addPage([595, H]);
  page.drawText("Name:", { x: 72, y: H - 80, size: 12, font });
  page.drawText("City:", { x: 72, y: H - 130, size: 12, font });
  const f = doc.getForm();
  const name = f.createTextField("name");
  name.setText("Ada Lovelace");
  name.addToPage(page, { x: 150, y: H - 88, width: 200, height: 20, font });
  const city = f.createTextField("city");
  city.setText("London");
  city.addToPage(page, { x: 150, y: H - 138, width: 200, height: 20, font });
  // A stamp whose appearance is turned by its Matrix: it reads up the page,
  // starting near the bottom-right corner of its Rect.
  const ap = doc.context.stream("BT /F1 10 Tf 2 5 Td (APPROVED) Tj ET", {
    Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 20], Matrix: [0, 1, -1, 0, 0, 0],
    Resources: { Font: { F1: font.ref } },
  });
  const stamp = doc.context.obj({
    Type: "Annot", Subtype: "Stamp", Rect: [400, 400, 420, 500], F: 4, AP: { N: doc.context.register(ap) },
  });
  page.node.set(PDFName.of("Annots"), doc.context.obj([...page.node.Annots().asArray(), doc.context.register(stamp)]));
  return doc.save();
}
const formBytes = await form();

await test("filled field values sit where the fields are shown", async () => {
  const { pageText } = await load("text");
  const pdf = await openPdf(formBytes.slice());
  const { lines } = await pageText(await pdf.getPage(1));
  const at = (s) => lines.find((l) => l.text.includes(s));
  for (const [label, value] of [["Name:", "Ada Lovelace"], ["City:", "London"]]) {
    const l = at(value);
    eq(Boolean(l), true, `${value} found`);
    eq(l.text.includes(label), true, `${value} on the ${label} line (got "${l.text}" at y=${l.y.toFixed(1)})`);
    const x = l.runs.find((r) => r.text.includes(value)).x;
    eq(x > 150 && x < 160, true, `${value} starts inside its field (x=${x.toFixed(1)})`);
  }
  // Glyph origin (2, 5) → Matrix (-5, 2) → onto the Rect (415, 402), y down 440.
  const stamp = lines.flatMap((l) => l.runs).find((r) => r.text === "APPROVED");
  eq(Boolean(stamp), true, "stamp found");
  eq(stamp.turn?.angle, 270, "stamp reads up the page");
  eq([Math.round(stamp.turn.x), Math.round(stamp.turn.y)].join(","), "415,440", "stamp starts in its Rect");
});

await test("Markdown keeps field values next to their labels", async () => {
  const [md] = await pdfToMarkdown(new File([formBytes], "f.pdf"), { pageBreaks: false });
  const text = await md.blob.text();
  eq(/Name:\s+Ada Lovelace/.test(text), true, `name line in:\n${text}`);
  eq(/City:\s+London/.test(text), true, "city line");
});

process.exit(results.failed ? 1 : 0);
