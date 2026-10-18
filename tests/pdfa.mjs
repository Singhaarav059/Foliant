// PDF/A tests: a file with the usual PDF/A blockers is converted, and the
// result must keep its real text and vector pages while the blockers are
// gone. Pages that can't be fixed (device CMYK, Symbol font) must be flagged
// for rendering. Full conformance is checked by veraPDF (see VERAPDF below).
//
//   node tests/pdfa.mjs
//   VERAPDF=/path/to/verapdf node tests/pdfa.mjs   (also validates with veraPDF)
import {
  PDFDocument, PDFName, PDFString, PDFDict, PDFArray, PDFRawStream, StandardFonts, rgb, cmyk, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, PDFOperator,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

nodeCanvas();
const { pdfToPdfa } = await load("convert");
const { fixForPdfA, pdfaNeedsRaster } = await load("pdfa");
const results = { failed: 0 };
const test = check(results);

async function build({ cmykPage = false, symbolPage = false, separationPage = false, transparentPage = false, unmappedFontPage = false, attachment = false, keepAF = false } = {}) {
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
  // A link that runs a script when clicked and when the pointer enters it.
  const jsLink = ctx.register(ctx.obj({
    Type: "Annot", Subtype: "Link", Rect: [50, 500, 250, 540], Border: [0, 0, 0],
    A: { S: "JavaScript", JS: PDFString.of("app.alert('click')") }, AA: { E: { S: "JavaScript", JS: PDFString.of("1") } },
  }));
  p.node.set(PDFName.of("Annots"), ctx.obj([link, note, jsLink]));
  // A script that runs when the page opens.
  p.node.set(PDFName.of("AA"), ctx.obj({ O: { S: "JavaScript", JS: PDFString.of("app.alert('page')") } }));
  // A bookmark whose action is a script.
  const outlines = ctx.nextRef();
  const item = ctx.register(ctx.obj({ Title: PDFString.of("Summary"), Parent: outlines, A: { S: "JavaScript", JS: PDFString.of("1") } }));
  ctx.assign(outlines, ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 }));
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  // A small RGB picture that asks for interpolation.
  const pixels = ctx.flateStream(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]), {
    Type: "XObject", Subtype: "Image", Width: 2, Height: 2, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Interpolate: true,
  });
  const im = p.node.newXObject("Im", ctx.register(pixels));
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(40, 0, 0, 40, 300, 600), drawObject(im), popGraphicsState());
  const gs = ctx.obj({ Type: "ExtGState", TR: PDFName.of("Identity"), HT: PDFName.of("Default") });
  p.node.Resources().set(PDFName.of("ExtGState"), ctx.obj({ GS1: ctx.register(gs) }));
  if (cmykPage) doc.addPage([595, 842]).drawRectangle({ x: 50, y: 600, width: 100, height: 100, color: cmyk(0, 1, 1, 0) });
  if (separationPage) {
    // A spot colour whose fallback is DeviceCMYK, which an sRGB output intent can't stand for.
    const sep = doc.addPage([595, 842]);
    const tint = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 0.5, 1, 0], N: 1 });
    sep.node.Resources().set(PDFName.of("ColorSpace"), ctx.obj({ CS0: ctx.obj([PDFName.of("Separation"), PDFName.of("Orange"), PDFName.of("DeviceCMYK"), ctx.register(tint)]) }));
    sep.pushOperators(PDFOperator.of("cs", [PDFName.of("CS0")]), PDFOperator.of("scn", [ctx.obj(1)]), PDFOperator.of("re", [50, 600, 100, 100].map((n) => ctx.obj(n))), PDFOperator.of("f"));
  }
  if (transparentPage) {
    // Office apps give every page a transparency group, whether or not anything on it is transparent.
    p.node.set(PDFName.of("Group"), ctx.obj({ Type: "Group", S: "Transparency", CS: "DeviceRGB" }));
    const t = doc.addPage([595, 842]);
    t.drawText("Under glass", { x: 50, y: 700, size: 14, font: helv });
    t.drawRectangle({ x: 40, y: 690, width: 200, height: 40, color: rgb(1, 0.8, 0), opacity: 0.5 });
  }
  if (unmappedFontPage) {
    // A Type3 font whose only glyph name means nothing in Unicode, and no ToUnicode map.
    const u = doc.addPage([595, 842]);
    const glyph = ctx.register(ctx.stream("500 0 0 0 500 500 d1 0 0 500 500 re f"));
    const font = ctx.register(ctx.obj({
      Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 500, 500], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { blot: glyph }, Encoding: { Type: "Encoding", Differences: [65, PDFName.of("blot")] },
      FirstChar: 65, LastChar: 65, Widths: [500], Resources: {},
    }));
    const f = u.node.newFontDictionary("T3", font);
    u.pushOperators(PDFOperator.of("BT"), PDFOperator.of("Tf", [f, ctx.obj(24)]), PDFOperator.of("Td", [ctx.obj(50), ctx.obj(700)]), PDFOperator.of("Tj", [PDFString.of("A")]), PDFOperator.of("ET"));
  }
  if (attachment) await doc.attach(new TextEncoder().encode("year,revenue\n2025,112\n"), "figures.csv", { mimeType: "text/csv", description: "Source figures" });
  if (symbolPage) doc.addPage([595, 842]).drawText("αβγ", { x: 50, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Symbol) });
  if (!attachment) return doc.save();
  const doc0 = doc;
  if (keepAF) {
    // Associated files the way Factur-X and other PDF/A-3 files carry them: the catalog's AF
    // (pdf-lib sets it on save), a page's AF, and an AF entry that points at no embedded file.
    const doc = await PDFDocument.load(await doc0.save());
    const ctx = doc.context;
    const spec = doc.catalog.lookup(PDFName.of("AF"), PDFArray).get(0);
    doc.getPage(0).node.set(PDFName.of("AF"), ctx.obj([spec]));
    const external = ctx.register(ctx.obj({ Type: "Filespec", F: PDFString.of("elsewhere.xml") }));
    const onlyInAF = ctx.register(ctx.obj({
      Type: "Filespec", F: PDFString.of("data.xml"),
      EF: { F: ctx.register(ctx.flateStream("<x/>", { Type: "EmbeddedFile" })) },
    }));
    doc.catalog.lookup(PDFName.of("AF"), PDFArray).push(external);
    doc.catalog.lookup(PDFName.of("AF"), PDFArray).push(onlyInAF);
    return doc.save();
  }
  // pdf-lib lists the file in the catalog's AF; most PDFs with attachments don't.
  const again = await PDFDocument.load(await doc.save());
  again.catalog.delete(PDFName.of("AF"));
  return again.save();
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
  eq(annots.map((a) => `${a.get(PDFName.of("Subtype"))}:${a.get(PDFName.of("F"))}`).join(","), "/Link:4,/Link:4", "annotations (note without appearance dropped, links printable)");
  eq(annots.map((a) => `${a.lookup(PDFName.of("A"))?.get(PDFName.of("S")) ?? "-"}:${a.has(PDFName.of("AA"))}`).join(","), "/URI:false,-:false", "link actions (web link kept, script and additional actions gone)");
  const gs = doc.context.enumerateIndirectObjects().map(([, o]) => o).find((o) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("ExtGState"));
  eq(Boolean(gs.get(PDFName.of("TR")) || gs.get(PDFName.of("HT"))), false, "TR and HT");
  eq(doc.getPage(0).node.has(PDFName.of("AA")), false, "page additional actions");
  const item = doc.catalog.lookup(PDFName.of("Outlines"), PDFDict).lookup(PDFName.of("First"), PDFDict);
  eq(`${item.lookup(PDFName.of("Title")).decodeText()}:${item.has(PDFName.of("A"))}`, "Summary:false", "bookmark kept without its script");
  const image = doc.context.enumerateIndirectObjects().map(([, o]) => o).find((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(image.dict.has(PDFName.of("Interpolate")), false, "image interpolation");
});

await test("PDF/A identification, output intent and matching metadata", () => {
  const xmp = new TextDecoder().decode(doc.catalog.lookup(PDFName.of("Metadata"), PDFRawStream).contents);
  eq(/<pdfaid:part>2<\/pdfaid:part>/.test(xmp) && /<pdfaid:conformance>B</.test(xmp), true, "pdfaid");
  eq(xmp.includes("Finance team") && xmp.includes("Figures for the year") && xmp.includes("Annual report"), true, "author, subject and title in XMP");
  eq(String(doc.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict).get(PDFName.of("S"))), "/GTS_PDFA1", "output intent");
  const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(images.map(([, o]) => o.dict.get(PDFName.of("Width"))).join(","), "2", "only the original picture, no page turned into an image");
});

await test("CMYK, spot colour over CMYK and Symbol pages are flagged for rendering, others are not", async () => {
  const d = await PDFDocument.load(await build({ cmykPage: true, separationPage: true, symbolPage: true }));
  const { raster } = await fixForPdfA(d);
  eq([...raster].sort().join(","), "1,2,3", "pages to render");
});

const outputOf = async (bytes, level) => {
  const [r] = await pdfToPdfa(new File([bytes], "report.pdf"), { pdfaDpi: "150", keepText: true, pdfaLevel: level });
  return { bytes: new Uint8Array(await r.blob.arrayBuffer()), note: r.note };
};
const pdfaId = (d) => {
  const xmp = new TextDecoder().decode(d.catalog.lookup(PDFName.of("Metadata"), PDFRawStream).contents);
  return `${xmp.match(/<pdfaid:part>(\d)</)?.[1]}${xmp.match(/<pdfaid:conformance>([A-Z])</)?.[1]}`;
};
const header = (bytes) => new TextDecoder().decode(bytes.subarray(0, 8));

const transparent = await build({ transparentPage: true });
const out1b = await outputOf(transparent, "1b");
await test("PDF/A-1b: transparency rendered, PDF 1.4, identified as 1B", async () => {
  eq((await fixForPdfA(await PDFDocument.load(transparent), "2b")).raster.size, 0, "PDF/A-2 keeps transparency as it is");
  eq([...(await fixForPdfA(await PDFDocument.load(transparent), "1b")).raster].join(","), "1", "PDF/A-1 renders the transparent page");
  const d = await PDFDocument.load(out1b.bytes);
  eq(header(out1b.bytes), "%PDF-1.4", "header");
  eq(pdfaId(d), "1B", "pdfaid");
  eq(d.getPages().some((p) => p.node.has(PDFName.of("Group"))), false, "no page transparency groups");
  const pages = await text(out1b.bytes);
  eq(pages[0], (await text(transparent))[0], "the opaque page keeps its real text");
  eq(pages[1].includes("Under glass"), true, "the rendered page stays searchable");
  eq(out1b.note, undefined, "no downgrade");
});

const out2u = await outputOf(input, "2u");
await test("PDF/A-2u: every font maps to Unicode, identified as 2U", async () => {
  eq(pdfaId(await PDFDocument.load(out2u.bytes)), "2U", "pdfaid");
  eq(out2u.note, undefined, "no downgrade");
});

await test("PDF/A-2u downgrades to 2b when a font can't map to Unicode", async () => {
  const bytes = await build({ unmappedFontPage: true });
  eq((await fixForPdfA(await PDFDocument.load(bytes), "2u")).level, "2b", "level reached");
  eq((await fixForPdfA(await PDFDocument.load(bytes), "2b")).raster.size, 0, "the page stays as it is");
  const out = await outputOf(bytes, "2u");
  eq(pdfaId(await PDFDocument.load(out.bytes)), "2B", "pdfaid");
  eq(out.note, "pdfaDowngraded:2b", "note");
});

const out3b = await outputOf(await build({ attachment: true }), "3b");
await test("PDF/A-3b: embedded files kept as associated files", async () => {
  const d = await PDFDocument.load(out3b.bytes);
  eq(pdfaId(d), "3B", "pdfaid");
  const tree = d.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray).asArray();
  eq(tree.filter((_, i) => i % 2 === 0).map((k) => k.decodeText()).join(","), "figures.csv", "only the file that is really embedded");
  const spec = d.context.lookup(tree[1]);
  eq(String(spec.get(PDFName.of("AFRelationship"))), "/Unspecified", "AFRelationship");
  eq(spec.lookup(PDFName.of("UF")).decodeText(), "figures.csv", "UF");
  eq(String(spec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F"), PDFRawStream).dict.get(PDFName.of("Subtype"))), "/text#2Fcsv", "MIME type");
  eq(d.catalog.lookup(PDFName.of("AF"), PDFArray).asArray().some((r) => r === tree[1]), true, "listed in the catalog's AF");
  eq((await PDFDocument.load(out3b.bytes.slice())).getPageCount(), 1, "pages");
  const asB = await PDFDocument.load((await outputOf(await build({ attachment: true }), "2b")).bytes);
  eq(asB.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)?.has(PDFName.of("EmbeddedFiles")) ?? false, false, "PDF/A-2 still drops attachments");
});

await test("render options are needed only when a page must become an image", async () => {
  const file = (bytes) => new File([bytes], "f.pdf");
  eq(await pdfaNeedsRaster(file(input), "2b"), false, "plain file");
  eq(await pdfaNeedsRaster(file(transparent), "2b"), false, "transparency at PDF/A-2");
  eq(await pdfaNeedsRaster(file(transparent), "1b"), true, "transparency at PDF/A-1");
  eq(await pdfaNeedsRaster(file(await build({ cmykPage: true })), "2b"), true, "device CMYK");
});

// Every dictionary in the file, direct ones inside indirect objects included.
const allDicts = (d) => {
  const out = [];
  const walk = (o, depth = 0) => {
    if (depth > 32) return;
    const dict = o instanceof PDFRawStream ? o.dict : o instanceof PDFDict ? o : null;
    if (dict) {
      out.push(dict);
      for (const [, v] of dict.entries()) walk(v, depth + 1);
    } else if (o instanceof PDFArray) o.asArray().forEach((v) => walk(v, depth + 1));
  };
  for (const [, o] of d.context.enumerateIndirectObjects()) walk(o);
  return out;
};
const withAF = await build({ attachment: true, keepAF: true });
const out1bAF = await outputOf(withAF, "1b");
const out2bAF = await outputOf(withAF, "2b");
await test("PDF/A-1b and 2b: associated files and their embedded streams are gone", async () => {
  for (const [lvl, out] of [["1b", out1bAF], ["2b", out2bAF]]) {
    const d = await PDFDocument.load(out.bytes);
    const dicts = allDicts(d);
    eq(dicts.filter((x) => x.has(PDFName.of("AF"))).length, 0, `${lvl}: no AF anywhere`);
    eq(dicts.filter((x) => x.has(PDFName.of("EF"))).length, 0, `${lvl}: no file specification with EF`);
    eq(dicts.filter((x) => x.get(PDFName.of("Type")) === PDFName.of("EmbeddedFile")).length, 0, `${lvl}: no embedded file stream left in the file`);
    eq((await text(out.bytes))[0], (await text(withAF))[0], `${lvl}: text unchanged`);
  }
});
const out3bAF = await outputOf(withAF, "3b");
await test("PDF/A-3b: files only in the catalog's AF are made valid; AF entries with no file go", async () => {
  const d = await PDFDocument.load(out3bAF.bytes);
  const af = d.catalog.lookup(PDFName.of("AF"), PDFArray).asArray().map((r) => d.context.lookup(r));
  eq(af.map((s) => s.lookup(PDFName.of("UF"))?.decodeText()).join(","), "figures.csv,data.xml", "catalog AF");
  for (const s of af) {
    const file = s.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F"), PDFRawStream);
    eq(s.get(PDFName.of("AFRelationship")) instanceof PDFName, true, "AFRelationship");
    eq(file.dict.get(PDFName.of("Subtype")) instanceof PDFName, true, "MIME type");
    eq(file.dict.lookup(PDFName.of("Params"), PDFDict).has(PDFName.of("ModDate")), true, "ModDate");
  }
  const pageAF = d.getPage(0).node.lookup(PDFName.of("AF"), PDFArray).asArray();
  eq(pageAF.length === 1 && d.context.lookup(pageAF[0]).lookup(PDFName.of("UF")).decodeText() === "figures.csv", true, "page AF kept");
});

// A legacy Type1 Helvetica with no Encoding: its built-in StandardEncoding puts ’ at 39 and ‘ at 96.
const legacy = async (s) => {
  const d = await PDFDocument.create();
  const ctx = d.context;
  const pg = d.addPage([595, 842]);
  const f = pg.node.newFontDictionary("F1", ctx.register(ctx.obj({ Type: "Font", Subtype: "Type1", BaseFont: "Helvetica" })));
  pg.pushOperators(PDFOperator.of("BT"), PDFOperator.of("Tf", [f, ctx.obj(14)]), PDFOperator.of("Td", [ctx.obj(50), ctx.obj(700)]), PDFOperator.of("Tj", [PDFString.of(s)]), PDFOperator.of("ET"));
  return d.save();
};
const trueTypeOf = (d) => d.context.enumerateIndirectObjects().map(([, x]) => x).find((x) => x instanceof PDFDict && x.get(PDFName.of("Subtype")) === PDFName.of("TrueType"));
// (platform, encoding) of every cmap subtable in a TrueType program.
const cmapEncodings = (sfnt) => {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  for (let i = 0; i < v.getUint16(4); i++) {
    if (v.getUint32(12 + i * 16) !== 0x636d6170) continue;
    const at = v.getUint32(20 + i * 16);
    return Array.from({ length: v.getUint16(at + 2) }, (_, j) => `${v.getUint16(at + 4 + j * 8)},${v.getUint16(at + 6 + j * 8)}`);
  }
  return [];
};
const legacyQuote = await legacy("It's `done`");
const out1bQuote = await outputOf(legacyQuote, "1b");
await test("PDF/A-1b: stand-ins use a plain WinAnsi encoding, or are symbolic with one (3,0) cmap", async () => {
  const plain = trueTypeOf(await PDFDocument.load((await outputOf(await legacy("Plain words"), "1b")).bytes));
  eq(String(plain.get(PDFName.of("Encoding"))), "/WinAnsiEncoding", "codes WinAnsi agrees with: plain WinAnsiEncoding");
  const d = await PDFDocument.load(out1bQuote.bytes);
  const f = trueTypeOf(d);
  const desc = f.lookup(PDFName.of("FontDescriptor"), PDFDict);
  const flags = desc.lookup(PDFName.of("Flags")).asNumber();
  eq(`${flags & 4},${flags & 32}`, "4,0", "symbolic, not non-symbolic");
  eq(f.has(PDFName.of("Encoding")), false, "a symbolic TrueType has no Encoding");
  eq(cmapEncodings(decodePDFRawStream(desc.lookup(PDFName.of("FontFile2"), PDFRawStream)).decode()).join(";"), "3,0", "exactly one cmap, (3,0)");
  eq((await text(out1bQuote.bytes))[0], (await text(legacyQuote))[0], "text and quotes unchanged");
  eq(out1bQuote.note, undefined, "no downgrade");
  eq((await fixForPdfA(await PDFDocument.load(legacyQuote), "1b")).raster.size, 0, "nothing rendered");
  // PDF/A-2 allows Differences on a non-symbolic TrueType; that stays.
  const two = trueTypeOf(await PDFDocument.load((await outputOf(legacyQuote, "2b")).bytes));
  eq(two.lookup(PDFName.of("Encoding")) instanceof PDFDict, true, "2b keeps WinAnsi plus Differences");
});

// A Type3 font drawing code 0x41 (/blot, a name Unicode doesn't know), with a ToUnicode map.
const type3With = async (cmapBody) => {
  const d = await PDFDocument.create();
  const ctx = d.context;
  const pg = d.addPage([595, 842]);
  const glyph = ctx.register(ctx.stream("500 0 0 0 500 500 d1 0 0 500 500 re f"));
  const cmap = ctx.register(ctx.stream(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def 1 begincodespacerange <00> <FF> endcodespacerange ${cmapBody} endcmap CMapName currentdict /CMap defineresource pop end end`));
  const font = ctx.register(ctx.obj({
    Type: "Font", Subtype: "Type3", FontBBox: [0, 0, 500, 500], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    CharProcs: { blot: glyph }, Encoding: { Type: "Encoding", Differences: [65, PDFName.of("blot")] }, FirstChar: 65, LastChar: 65, Widths: [500], Resources: {}, ToUnicode: cmap,
  }));
  const f = pg.node.newFontDictionary("T3", font);
  pg.pushOperators(PDFOperator.of("BT"), PDFOperator.of("Tf", [f, ctx.obj(24)]), PDFOperator.of("Td", [ctx.obj(50), ctx.obj(700)]), PDFOperator.of("Tj", [PDFString.of("A")]), PDFOperator.of("ET"));
  return PDFDocument.load(await d.save());
};
await test("PDF/A-2u: a ToUnicode map counts only for the codes it really maps", async () => {
  eq((await fixForPdfA(await type3With("1 beginbfchar <42> <0042> endbfchar"), "2u")).level, "2b", "code drawn missing from the map");
  eq((await fixForPdfA(await type3With("1 beginbfchar <41> <0000> endbfchar"), "2u")).level, "2b", "code mapped to U+0000");
  eq((await fixForPdfA(await type3With("1 beginbfchar <41> <FEFF> endbfchar"), "2u")).level, "2b", "code mapped to U+FEFF");
  eq((await fixForPdfA(await type3With("1 beginbfchar <41> <25A0> endbfchar"), "2u")).level, "2u", "bfchar");
  eq((await fixForPdfA(await type3With("1 beginbfrange <40> <42> <25A0> endbfrange"), "2u")).level, "2u", "bfrange");
  eq((await fixForPdfA(await type3With("1 beginbfrange <41> <41> [<25A0>] endbfrange"), "2u")).level, "2u", "bfrange with an array");
  // A composite font (Identity-H, two-byte codes) as pdf-lib embeds it, with its ToUnicode map.
  const composite = async (edit) => {
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    // The TrueType program of an Arimo stand-in made above.
    const ttf = decodePDFRawStream(fonts[0].lookup(PDFName.of("FontDescriptor"), PDFDict).lookup(PDFName.of("FontFile2"), PDFRawStream)).decode();
    const font = await d.embedFont(ttf);
    d.addPage([595, 842]).drawText("Hello", { x: 50, y: 700, size: 14, font });
    const loaded = await PDFDocument.load(await d.save());
    const t0 = loaded.context.enumerateIndirectObjects().map(([, o]) => o).find((o) => o instanceof PDFDict && o.get(PDFName.of("Subtype")) === PDFName.of("Type0"));
    edit(t0, loaded);
    return loaded;
  };
  // A map of just the two-byte codes the page draws, all of them or all but the first.
  const mapOf = (keep) => (f, d) => {
    const contents = d.getPage(0).node.Contents();
    const content = (contents instanceof PDFArray ? contents.asArray().map((r) => d.context.lookup(r)) : [contents])
      .map((st) => new TextDecoder().decode(decodePDFRawStream(st).decode())).join("\n");
    const codes = [...new Set(content.match(/<([0-9A-Fa-f]+)>\s*Tj/)[1].match(/.{4}/g))].slice(keep);
    f.set(PDFName.of("ToUnicode"), d.context.register(d.context.stream(
      `/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange ${codes.length} beginbfchar ${codes.map((c) => `<${c}> <0041>`).join(" ")} endbfchar endcmap end end`,
    )));
  };
  eq((await fixForPdfA(await composite(() => {}), "2u")).level, "2u", "composite font with pdf-lib's map");
  eq((await fixForPdfA(await composite(mapOf(0)), "2u")).level, "2u", "composite font whose map has exactly the codes drawn");
  eq((await fixForPdfA(await composite(mapOf(1)), "2u")).level, "2b", "composite font whose map misses a code drawn");
});

// Full validation, when a veraPDF command line is available (CI).
if (process.env.VERAPDF) {
  const dir = mkdtempSync(join(tmpdir(), "pdfa-"));
  for (const [flavour, bytes, tag] of [
    ["2b", output, ""], ["1b", out1b.bytes, ""], ["2u", out2u.bytes, ""], ["3b", out3b.bytes, ""],
    ["1b", out1bAF.bytes, "attachments"], ["2b", out2bAF.bytes, "attachments"], ["3b", out3bAF.bytes, "attachments"], ["1b", out1bQuote.bytes, "legacy Helvetica"],
  ]) {
    await test(`veraPDF: PDF/A-${flavour}${tag ? ` (${tag})` : ""} compliant`, () => {
      const file = join(dir, `report-pdfa-${flavour}${tag ? `-${tag.replace(/ /g, "-")}` : ""}.pdf`);
      writeFileSync(file, bytes);
      let report;
      try {
        report = execFileSync(process.env.VERAPDF, ["--flavour", flavour, "--format", "text", file], { encoding: "utf8" });
      } catch (e) {
        report = e.stdout?.toString() ?? String(e);
      }
      console.log(report.split("\n").map((l) => `      ${l}`).join("\n"));
      eq(/^PASS /m.test(report), true, "veraPDF verdict");
    });
  }
} else console.log("skip  veraPDF (set VERAPDF to validate the 1b, 2b, 2u and 3b outputs)");

process.exit(results.failed ? 1 : 0);
