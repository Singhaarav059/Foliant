// PDF/A tests: a file with the usual PDF/A blockers is converted, and the
// result must keep its real text and vector pages while the blockers are
// gone. Pages that can't be fixed (device CMYK, Symbol font) must be flagged
// for rendering. Full conformance is checked by veraPDF (see VERAPDF below).
//
//   node tests/pdfa.mjs
//   VERAPDF=/path/to/verapdf node tests/pdfa.mjs   (also validates with veraPDF)
import { PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRawStream, StandardFonts, rgb, cmyk, decodePDFRawStream } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, openPdf, check, eq } from "./lib/load.mjs";

const { pdfToPdfa } = await load("convert");
const { fixForPdfA } = await load("pdfa");
const results = { failed: 0 };
const test = check(results);

async function build({ cmykPage = false, symbolPage = false } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle("Annual report");
  doc.setAuthor("Finance team");
  doc.setSubject("Figures for the year");
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const timesBold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const p = doc.addPage([595, 842]);
  p.drawText("Revenue grew by 12% – “strong” year, café € naïve", { x: 50, y: 760, size: 14, font: helv });
  p.drawText("Times Bold heading", { x: 50, y: 720, size: 20, font: timesBold });
  p.drawRectangle({ x: 50, y: 600, width: 200, height: 60, color: rgb(0.2, 0.4, 0.8) });
  const ctx = doc.context;
  // Blockers: a script that runs on open, an attachment, a hidden link, a note with no appearance, a transfer function.
  doc.catalog.set(PDFName.of("OpenAction"), ctx.obj({ S: "JavaScript", JS: PDFString.of("app.alert('hi')") }));
  doc.catalog.set(PDFName.of("Names"), ctx.obj({
    JavaScript: { Names: [PDFString.of("init"), ctx.obj({ S: "JavaScript", JS: PDFString.of("1") })] },
    EmbeddedFiles: { Names: [PDFString.of("a.txt"), ctx.obj({ Type: "Filespec", F: PDFString.of("a.txt") })] },
  }));
  const link = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [50, 600, 250, 660], F: 2, Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of("https://example.com/") } }));
  const note = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Text", Rect: [300, 700, 320, 720], Contents: PDFString.of("note") }));
  p.node.set(PDFName.of("Annots"), ctx.obj([link, note]));
  const gs = ctx.obj({ Type: "ExtGState", TR: PDFName.of("Identity"), HT: PDFName.of("Default") });
  p.node.Resources().set(PDFName.of("ExtGState"), ctx.obj({ GS1: ctx.register(gs) }));
  if (cmykPage) doc.addPage([595, 842]).drawRectangle({ x: 50, y: 600, width: 100, height: 100, color: cmyk(0, 1, 1, 0) });
  if (symbolPage) doc.addPage([595, 842]).drawText("αβγ", { x: 50, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Symbol) });
  return doc.save();
}

const text = async (bytes) => {
  const pdf = await openPdf(bytes.slice());
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join(" "));
  return out;
};

const input = await build();
const [result] = await pdfToPdfa(new File([input], "report.pdf"), { pdfaDpi: "150", keepText: true });
const output = new Uint8Array(await result.blob.arrayBuffer());
const doc = await PDFDocument.load(output);
const fonts = doc.context.enumerateIndirectObjects().map(([, o]) => o).filter((o) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Font"));

await test("text stays real text, identical to the original", async () => {
  eq(JSON.stringify(await text(output)), JSON.stringify(await text(input)), "extracted text");
});

await test("fonts embedded as metric-compatible stand-ins", () => {
  const names = fonts.map((f) => String(f.get(PDFName.of("BaseFont")))).sort();
  eq(names.join(","), "/Arimo-Regular,/Tinos-Bold", "fonts");
  for (const f of fonts) eq(Boolean(f.lookup(PDFName.of("FontDescriptor"), PDFDict).get(PDFName.of("FontFile2"))), true, "FontFile2");
});

await test("widths match the embedded font program", () => {
  for (const f of fonts) {
    const desc = f.lookup(PDFName.of("FontDescriptor"), PDFDict);
    const kit = fontkit.create(decodePDFRawStream(desc.lookup(PDFName.of("FontFile2"), PDFRawStream)).decode());
    const widths = f.lookup(PDFName.of("Widths"), PDFArray).asArray().map((n) => n.asNumber());
    // 'H' (0x48) and 'e' (0x65): same in the font program and in /Widths.
    for (const [code, cp] of [[0x48, 0x48], [0x65, 0x65]])
      eq(widths[code], Math.round((kit.glyphForCodePoint(cp).advanceWidth * 1000) / kit.unitsPerEm), `width of ${String.fromCharCode(cp)}`);
  }
});

await test("Helvetica stand-in keeps the original widths (no reflow)", () => {
  // Helvetica's AFM width for 'H' is 722, 'e' 556.
  const arimo = fonts.find((f) => String(f.get(PDFName.of("BaseFont"))) === "/Arimo-Regular");
  const w = arimo.lookup(PDFName.of("Widths"), PDFArray).asArray().map((n) => n.asNumber());
  eq(`${w[0x48]},${w[0x65]}`, "722,556", "widths");
});

await test("blockers removed: scripts, attachments, hidden flags, transfer functions", () => {
  eq(doc.catalog.get(PDFName.of("OpenAction")), undefined, "open action");
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  eq(Boolean(names?.get(PDFName.of("JavaScript")) || names?.get(PDFName.of("EmbeddedFiles"))), false, "scripts and attachments");
  const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((r) => doc.context.lookup(r));
  eq(annots.map((a) => `${a.get(PDFName.of("Subtype"))}:${a.get(PDFName.of("F"))}`).join(","), "/Link:4", "annotations (note without appearance dropped, link printable)");
  const gs = doc.context.enumerateIndirectObjects().map(([, o]) => o).find((o) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("ExtGState"));
  eq(Boolean(gs.get(PDFName.of("TR")) || gs.get(PDFName.of("HT"))), false, "TR and HT");
});

await test("PDF/A identification, output intent and matching metadata", () => {
  const xmp = new TextDecoder().decode(doc.catalog.lookup(PDFName.of("Metadata"), PDFRawStream).contents);
  eq(/<pdfaid:part>2<\/pdfaid:part>/.test(xmp) && /<pdfaid:conformance>B</.test(xmp), true, "pdfaid");
  eq(xmp.includes("Finance team") && xmp.includes("Figures for the year") && xmp.includes("Annual report"), true, "author, subject and title in XMP");
  eq(String(doc.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict).get(PDFName.of("S"))), "/GTS_PDFA1", "output intent");
  const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(images.length, 0, "no page turned into an image");
});

await test("CMYK and Symbol pages are flagged for rendering, others are not", async () => {
  const d = await PDFDocument.load(await build({ cmykPage: true, symbolPage: true }));
  const { raster } = await fixForPdfA(d);
  eq([...raster].sort().join(","), "1,2", "pages to render");
});

// Full validation, when a veraPDF command line is available.
if (process.env.VERAPDF) {
  await test("veraPDF: PDF/A-2b compliant", () => {
    const dir = mkdtempSync(join(tmpdir(), "pdfa-"));
    const file = join(dir, "report-pdfa.pdf");
    writeFileSync(file, output);
    let report;
    try {
      report = execFileSync(process.env.VERAPDF, ["--flavour", "2b", "--format", "text", file], { encoding: "utf8" });
    } catch (e) {
      report = e.stdout?.toString() ?? String(e);
    }
    console.log(report.split("\n").map((l) => `      ${l}`).join("\n"));
    eq(/^PASS /m.test(report), true, "veraPDF verdict");
  });
}

process.exit(results.failed ? 1 : 0);
