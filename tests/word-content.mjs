// PDF → Word never comes back empty: scans that carry a stamp, pages whose
// only text is a running header, and pages with very little text keep both
// their pictures and their words. Pictures need a canvas, so this suite uses
// @napi-rs/canvas (installed with pdf.js) in place of the browser's.
//
//   node tests/word-content.mjs
import { PDFDocument, PDFName, StandardFonts, rgb, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import JSZip from "jszip";
import { root, load, check, eq } from "./lib/load.mjs";

globalThis.document ??= { createElement: () => createCanvas(1, 1) };
// pdf.js runs its worker on this thread instead of fetching it from /vendor.
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

const { pdfToWord } = await load("convert");
const results = { failed: 0 };
const test = check(results);

const scan = readFileSync(join(root, "tests/fixtures/scanned.pdf"));
const H = 825;

// What a docx holds: body, header and footer text, pictures.
async function unpack(bytes, name) {
  if (process.env.SAVE) writeFileSync(join(process.env.SAVE, `${name}.pdf`), bytes);
  const [docx] = await pdfToWord(new File([bytes], `${name}.pdf`), { wordMode: "editable" });
  const zip = await JSZip.loadAsync(await docx.blob.arrayBuffer());
  if (process.env.SAVE) writeFileSync(join(process.env.SAVE, `${name}.docx`), Buffer.from(await docx.blob.arrayBuffer()));
  const parts = Object.keys(zip.files);
  const read = (re) => Promise.all(parts.filter((f) => re.test(f)).map((f) => zip.file(f).async("string")));
  const textOf = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
  const body = await zip.file("word/document.xml").async("string");
  const headers = await read(/^word\/header\d*\.xml$/);
  const footers = await read(/^word\/footer\d*\.xml$/);
  return {
    body, headers, footers,
    bodyText: textOf(body),
    headerText: headers.map(textOf).join(" | "),
    footerText: footers.map(textOf).join(" | "),
    media: parts.filter((f) => /^word\/media\/.+\.\w+$/.test(f)).length,
    drawings: (body.match(/<w:drawing>/g) ?? []).length,
    // The first section's properties: where Word looks for the first page's header.
    firstSection: body.match(/<w:sectPr[ >][\s\S]*?<\/w:sectPr>/)?.[0] ?? "",
  };
}

// Pages from the scanned fixture, each with a line of real text drawn on top
// and a punch hole in a different place (identical pictures share one file).
async function scans(pages, stamp) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [page] = await doc.embedPdf(scan);
  for (let p = 1; p <= pages; p++) {
    const pg = doc.addPage([600, H]);
    pg.drawPage(page, { x: 0, y: 0, width: 600, height: H });
    pg.drawText(stamp(p), { x: 60, y: 22, size: 9, font });
    pg.drawCircle({ x: 24, y: 200 * p, size: 6, color: rgb(0.2, 0.2, 0.2) });
  }
  return doc.save();
}

// The scanned fixture made searchable the way the OCR tool does it: its two
// lines laid over the scan as invisible text. `stamp(p)`, if given, is drawn
// on top as real text, as a Bates stamp added after OCR would be.
async function searchable(pages, stamp) {
  const { addInvisibleText } = await load("textlayer");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [page] = await doc.embedPdf(scan);
  for (let p = 1; p <= pages; p++) {
    const pg = doc.addPage([600, H]);
    pg.drawPage(page, { x: 0, y: 0, width: 600, height: H });
    // Where the scan shows each line: left edge, right edge, baseline from the top.
    const words = [["Scanned invoice 4471", 46, 311, 84], ["Total due: 1,250.00 EUR", 46, 351, 146]].flatMap(([line, x0, x1, base]) => {
      const scale = (x1 - x0) / line.length;
      let at = 0;
      return line.split(" ").map((text) => {
        const word = { text, x: x0 + at * scale, y: H - base, width: text.length * scale, height: 20, angle: 0 };
        at += text.length + 1;
        return word;
      });
    });
    addInvisibleText(doc, pg, words);
    if (stamp) pg.drawText(stamp(p), { x: 60, y: 22, size: 9, font });
  }
  return doc.save();
}

// Plain pages: `lines(p)` lists [text, top] pairs for page p.
async function textPages(pages, lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const pg = doc.addPage([595, 842]);
    for (const [s, top] of lines(p)) pg.drawText(s, { x: 72, y: 842 - top - 10, size: 10, font });
  }
  return doc.save();
}

await test("3 scans with a 48-character stamp keep their pictures and the stamp", async () => {
  const stamp = (p) => `Case 2024-cv-0042 Exhibit B Page ${p} of 3 ABC0001${p}`;
  eq(stamp(1).length, 48, "stamp length");
  const d = await unpack(await scans(3, stamp), "stamped");
  eq(d.media, 3, "pictures");
  eq(d.drawings, 3, "pictures placed");
  // Repeated on every page, the stamp is the footer.
  eq(/Exhibit B Page/.test(d.footerText), true, `stamp text (body "${d.bodyText.slice(0, 40)}", footer "${d.footerText}")`);
  eq(/<w:footerReference /.test(d.firstSection), true, "footer on the first page");
  // The Bates number counts up with the page: each page keeps its own.
  eq([1, 2, 3].every((p) => d.footerText.includes(`ABC0001${p}`)), true, `Bates numbers (footer "${d.footerText}")`);
});

await test("1 scan with a stamp keeps the picture and the stamp", async () => {
  const d = await unpack(await scans(1, () => "CONFIDENTIAL - SUBJECT TO PROTECTIVE ORDER 0001"), "stamped-one");
  eq(d.media, 1, "pictures");
  eq(d.bodyText.includes("CONFIDENTIAL - SUBJECT TO PROTECTIVE ORDER"), true, "stamp text");
  // The scan sits behind the text, not in its way.
  eq(/<wp:anchor [^>]*behindDoc="1"/.test(d.body), true, "picture behind the text");
});

// The scan already shows the words its OCR text layer holds: behind the text
// as well, every word would show twice.
await test("a searchable scan becomes its words, once", async () => {
  const d = await unpack(await searchable(1), "searchable");
  eq(/Scanned invoice 4471.*Total due: 1,250\.00 EUR/.test(d.bodyText), true, `words (got "${d.bodyText}")`);
  eq(/behindDoc="1"/.test(d.body), false, "no scan behind the words");
  eq(d.media, 0, "pictures");
});

await test("a searchable scan stamped after OCR keeps the stamp, words once", async () => {
  const d = await unpack(await searchable(3, (p) => `Case 2024-cv-0042 Exhibit B Page ${p} of 3 ABC0001${p}`), "searchable-stamped");
  eq((d.bodyText.match(/Scanned invoice 4471/g) ?? []).length, 3, `words (got "${d.bodyText.slice(0, 80)}")`);
  eq([1, 2, 3].every((p) => `${d.bodyText} ${d.footerText}`.includes(`ABC0001${p}`)), true, `stamps (footer "${d.footerText}")`);
  eq(/behindDoc="1"/.test(d.body), false, "no scan behind the words");
});

await test("3 pages with only a running header keep the header", async () => {
  const d = await unpack(await textPages(3, (p) => [[`MANYPAGES page ${p} of 3`, 30]]), "header-only");
  eq(/MANYPAGES page/.test(d.headerText), true, `header part (got "${d.headerText}")`);
  eq(/<w:headerReference /.test(d.firstSection), true, "header on the first page");
  eq(d.headers.length, 1, "one header with a page field, not one per page");
  eq(d.media, 0, "no pictures of blank pages");
});

await test("header-only first page keeps the header for the whole document", async () => {
  const body = "The committee reviewed the annual figures and approved the plan for next year";
  const d = await unpack(await textPages(3, (p) => [[`MANYPAGES page ${p} of 3`, 30], ...(p > 1 ? [[body, 120], [body, 134]] : [])]), "header-first");
  eq(/MANYPAGES page/.test(d.headerText), true, `header part (got "${d.headerText}")`);
  eq(/<w:headerReference /.test(d.firstSection), true, "header on the first page");
  eq(d.bodyText.includes("The committee reviewed"), true, "body text");
  eq(d.bodyText.includes("MANYPAGES"), false, "header not repeated in the body");
  eq(d.media, 0, "no pictures of blank pages");
});

// Draws a raw image (`channels` 3 for RGB, 4 for CMYK) at x, y (from the bottom), w × h points.
function drawRaw(doc, pg, name, [x, y, w, h], channels, px) {
  const size = Math.round(Math.sqrt(px.length / channels));
  const image = doc.context.register(doc.context.flateStream(px, {
    Type: "XObject", Subtype: "Image", Width: size, Height: size, ColorSpace: channels === 4 ? "DeviceCMYK" : "DeviceRGB", BitsPerComponent: 8,
  }));
  pg.node.setXObject(PDFName.of(name), image);
  pg.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, x, y), drawObject(name), popGraphicsState());
}

// A page with a CMYK picture and a 19-character caption.
async function captioned() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([595, 842]);
  drawRaw(doc, pg, "Im1", [137, 400, 320, 240], 4, new Uint8Array(48 * 48 * 4).map((_, i) => [0, 160, 220, 20][i % 4] ^ ((i >> 6) & 0x3f)));
  pg.drawText("CMYKJPEG image page", { x: 137, y: 370, size: 12, font });
  return doc.save();
}

await test("a page with a 19-character caption keeps the caption and the picture", async () => {
  const d = await unpack(await captioned(), "captioned");
  eq(d.bodyText.includes("CMYKJPEG"), true, `caption (got "${d.bodyText}")`);
  eq(d.media, 1, "picture");
  eq(d.drawings, 1, "picture placed once");
});

// A diagram: vector boxes with one-letter labels.
async function diagram() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([595, 842]);
  for (const [k, label] of ["A", "B", "C"].entries()) {
    pg.drawRectangle({ x: 80 + k * 160, y: 500, width: 110, height: 70, borderColor: rgb(0.1, 0.3, 0.6), borderWidth: 2 });
    pg.drawText(label, { x: 130 + k * 160, y: 530, size: 14, font });
  }
  return doc.save();
}

await test("a diagram with a few labels keeps the labels and the drawing", async () => {
  const d = await unpack(await diagram(), "diagram");
  eq(["A", "B", "C"].every((l) => d.bodyText.includes(l)), true, `labels (got "${d.bodyText}")`);
  eq(d.media, 1, "drawing");
  eq(/<wp:anchor [^>]*behindDoc="1"/.test(d.body), true, "drawing behind the labels");
});

// Letterhead: a full-page picture, a logo on it, and a letter.
async function letterhead() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([595, 842]);
  drawRaw(doc, pg, "Bg", [0, 0, 595, 842], 3, new Uint8Array(8 * 8 * 3).map((_, i) => 225 + (i % 7) * 3));
  drawRaw(doc, pg, "Logo", [60, 740, 120, 60], 3, new Uint8Array(16 * 16 * 3).map((_, i) => (i % 3 === 2 ? 200 : 40)));
  ["Dear Ms Rao,", "Thank you for your letter of 3 October about the new office lease.", "We have signed the agreement and enclose a copy for your records."]
    .forEach((s, k) => pg.drawText(s, { x: 72, y: 640 - k * 16, size: 11, font }));
  return doc.save();
}

await test("a letterhead keeps its picture behind the letter, logo included once", async () => {
  const d = await unpack(await letterhead(), "letterhead");
  eq(d.bodyText.includes("We have signed the agreement"), true, "letter text");
  eq(d.drawings, 1, "one picture: the background with the logo drawn in");
  eq(/<wp:anchor [^>]*behindDoc="1"/.test(d.body), true, "picture behind the text");
});

process.exit(results.failed ? 1 : 0);
