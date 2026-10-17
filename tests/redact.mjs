// Redaction tests: the hidden text must be gone from every object, every
// extraction path and every side channel (tags, form objects, links,
// bookmarks), while everything outside the boxes stays real and selectable.
// The fallback that draws pages as images is tested too, with PDFium made
// to fail and a Node canvas standing in for the browser's.
//
//   node tests/redact.mjs
import {
  PDFDocument, PDFName, PDFString, PDFHexString, PDFRawStream, PDFArray, PDFDict, PDFRef, StandardFonts, degrees, decodePDFRawStream,
  PDFOperator, PDFOperatorNames as Ops, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "pdf-lib";
import { load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

const { redact, findMatches } = await load("security");
const { pageText: textOf } = await load("text");
const results = { failed: 0 };
const test = check(results);
const SECRET = "SECRET-4471";
const W = 400, H = 300;

// Indirect objects that still hold `needle`: stream data (decoded, as text,
// hex or UTF-16), strings in dictionaries and arrays in any encoding, and
// objects packed in object streams (pdf-lib unpacks those on load).
async function holding(bytes, needle) {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  const hex = Buffer.from(needle, "latin1").toString("hex");
  const utf16 = Buffer.from(needle, "utf16le").swap16().toString("latin1");
  const latin1 = (b) => Buffer.from(b).toString("latin1");
  const strings = (o) => o instanceof PDFString || o instanceof PDFHexString ? [o.decodeText()]
    : o instanceof PDFDict ? o.values().flatMap(strings)
    : o instanceof PDFArray ? o.asArray().flatMap(strings)
    : [];
  const hits = [];
  for (const [ref, o] of d.context.enumerateIndirectObjects()) {
    let s = o.toString();
    if (o instanceof PDFRawStream) {
      try { s += latin1(decodePDFRawStream(o).decode()); } catch { s += latin1(o.contents); }
    }
    const found = s.includes(needle) || s.toLowerCase().includes(hex) || s.includes(utf16) || strings(o instanceof PDFRawStream ? o.dict : o).some((t) => t.includes(needle));
    if (found) hits.push(String(ref));
  }
  return hits;
}
const allText = async (bytes) => {
  const pdf = await openPdf(bytes.slice());
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((t) => t.str).join(" "));
  return out.join(" | ");
};

// Pages drawn as images need a canvas.
nodeCanvas();

// ── Fallback: PDFium fails to load, every marked page is drawn as an image.
// Runs first: PDFium is loaded once, and a failed load is retried next time.
{
  const pdfium = await load("pdfium");
  const realLoad = pdfium.pdfiumWasm.load;
  pdfium.pdfiumWasm.load = async () => { throw new Error("PDFium made to fail for the test"); };

  // A contents page links to page 3, which holds the secret.
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const toc = d.addPage([W, H]);
  toc.drawText("Contents: account details on page 3", { x: 20, y: 250, size: 12, font });
  d.addPage([W, H]).drawText("Nothing to hide here", { x: 20, y: 250, size: 12, font });
  const p3 = d.addPage([W, H]);
  p3.drawText("Account SECRET3-4471 belongs to the client", { x: 20, y: 250, size: 12, font });
  toc.node.set(PDFName.of("Annots"), d.context.obj([
    d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [20, 245, 220, 262], Border: [0, 0, 0], Dest: [p3.ref, PDFName.of("Fit")] })),
    d.context.register(d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [20, 225, 220, 240], Border: [0, 0, 0], A: { S: "GoTo", D: [p3.ref, PDFName.of("Fit")] } })),
  ]));
  const input = new Uint8Array(await d.save());
  const pages = [];
  const src = await openPdf(input.slice());
  for (let i = 1; i <= src.numPages; i++) pages.push(await textOf(await src.getPage(i)));
  const hits = findMatches(pages, /SECRET3-4471/g);
  const [res] = await redact(new File([input], "toc.pdf"), hits, { redactDpi: "100" });
  const out = new Uint8Array(await res.blob.arrayBuffer());
  const text = await allText(out);
  console.log(`      fallback text after: ${text}`);

  await test("fallback: the secret is gone from the text layer, the rest stays searchable", () => {
    eq(hits.length, 1, "search hits");
    eq(text.includes("SECRET3"), false, "secret in text");
    eq(text.includes("belongs to the client"), true, "text beside the box kept");
  });
  await test("fallback: a link to the redacted page doesn't bring the original along", async () => {
    eq((await holding(out, "SECRET3")).join(","), "", "objects holding the secret");
    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((r) => doc.context.lookup(r));
    const targets = annots.map((a) => (a.lookupMaybe(PDFName.of("Dest"), PDFArray) ?? a.lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("D"), PDFArray)).get(0));
    eq(targets.map((t) => t instanceof PDFRef && t === doc.getPage(2).ref).join(","), "true,true", "links land on page 3 of the output");
    eq(doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("Page")).length, 3, "page objects");
  });

  await test("fallback: a page drawn as an image keeps nothing of an inherited CropBox", async () => {
    // The CropBox comes from the page tree: the page is seen as 300×200, from (50, 50).
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([W, H]);
    p.drawText("Left edge text SECRET-1 here", { x: 60, y: 200, size: 12, font });
    p.drawText("Bottom line kept", { x: 60, y: 60, size: 12, font });
    d.catalog.lookup(PDFName.of("Pages")).set(PDFName.of("CropBox"), d.context.obj([50, 50, 350, 250]));
    const input = new Uint8Array(await d.save());
    const hits = findMatches([await textOf(await (await openPdf(input.slice())).getPage(1))], /SECRET-1/g);
    const [res] = await redact(new File([input], "crop.pdf"), hits, { redactDpi: "100" });
    const page = await (await openPdf(new Uint8Array(await res.blob.arrayBuffer()))).getPage(1);
    eq(page.view.join(","), "0,0,300,200", "page as seen");
    const lines = (await textOf(page)).lines.map((l) => `${l.text} @${Math.round(l.x)}`);
    eq(lines.join(" | "), "Left edge text here @10 | Bottom line kept @10", "text layer");
  });

  pdfium.pdfiumWasm.load = realLoad;
}

async function build() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle(`Case ${SECRET}`);

  // Page 1: secret in a line of public text, an image under part of the box,
  // a link over the secret and one over public text.
  const p1 = doc.addPage([W, H]);
  p1.drawText(`Account ${SECRET} belongs to the client`, { x: 20, y: 250, size: 12, font });
  p1.drawText("Public paragraph stays readable", { x: 20, y: 60, size: 12, font });
  const px = new Uint8Array(100 * 50 * 3).fill(200);
  const img = doc.context.register(doc.context.flateStream(px, { Type: "XObject", Subtype: "Image", Width: 100, Height: 50, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  p1.node.setXObject(PDFName.of("Im1"), img);
  p1.pushOperators(pushGraphicsState(), concatTransformationMatrix(200, 0, 0, 100, 100, 120), drawObject("Im1"), popGraphicsState());
  const link = (rect, url) => doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: rect, Border: [0, 0, 0], A: { S: "URI", URI: PDFString.of(url) } }));
  p1.node.set(PDFName.of("Annots"), doc.context.obj([link([70, 245, 140, 262], `mailto:${SECRET}@example.com`), link([20, 55, 120, 72], "https://example.com/public")]));
  p1.node.set(PDFName.of("PieceInfo"), doc.context.obj({ Illustrator: { Private: doc.context.register(doc.context.obj({ Note: PDFString.of(`artwork ${SECRET}`) })) } }));

  // Page 2: the secret only in tagged ActualText, over harmless visible text.
  const p2 = doc.addPage([W, H]);
  p2.pushOperators(PDFOperator.of(Ops.BeginMarkedContentSequence, [PDFName.of("Span"), doc.context.obj({ ActualText: PDFString.of(SECRET) })]));
  p2.drawText("XXXXXXXXXX", { x: 20, y: 250, size: 12, font });
  p2.pushOperators(PDFOperator.of(Ops.EndMarkedContent));
  p2.drawText("Tag page footer", { x: 20, y: 60, size: 12, font });

  // Page 3: the secret inside a form XObject (a stamped page).
  const inner = await PDFDocument.create();
  const ip = inner.addPage([W, H]);
  ip.drawText(`Stamp ${SECRET}`, { x: 20, y: 250, size: 12, font: await inner.embedFont(StandardFonts.Helvetica) });
  const [stamp] = await doc.embedPdf(await inner.save());
  const p3 = doc.addPage([W, H]);
  p3.drawPage(stamp);
  p3.drawText("Form page footer", { x: 20, y: 60, size: 12, font });

  // Page 4: rotated 90° for display.
  const p4 = doc.addPage([H, W]);
  p4.setRotation(degrees(90));
  p4.drawText(`Turned ${SECRET}`, { x: 250, y: 20, size: 12, font, rotate: degrees(90) });
  p4.drawText("Turned page footer", { x: 60, y: 20, size: 12, font, rotate: degrees(90) });

  // Page 5: untouched.
  doc.addPage([W, H]).drawText(`Unmarked page ${SECRET.toLowerCase()}`, { x: 20, y: 250, size: 12, font });

  // A bookmark that names the secret.
  const outline = doc.context.register(doc.context.obj({ Title: PDFString.of(SECRET), Parent: null, Dest: [doc.getPage(0).ref, PDFName.of("Fit")] }));
  doc.catalog.set(PDFName.of("Outlines"), doc.context.obj({ Type: "Outlines", First: outline, Last: outline, Count: 1 }));
  return doc.save();
}

// Boxes as the editor sends them: fractions of the page as seen, top-left origin.
const frac = (x0, top, x1, bottom, w = W, h = H) => ({ x: x0 / w, y: top / h, w: (x1 - x0) / w, h: (bottom - top) / h });
const marks = [
  { page: 0, rect: frac(68, 36, 148, 56) }, // around SECRET-4471 on line 1 (y 250 ⇒ 50 from the top)
  { page: 0, rect: frac(150, 110, 200, 160) }, // over part of the image
  { page: 1, rect: frac(15, 36, 120, 56) },
  { page: 2, rect: frac(15, 36, 140, 56) },
  // Page 4 is seen as 400×300 after the turn. Turned clockwise, user x becomes
  // distance from the visual top: the secret (x 250) is near the bottom, the footer (x 60) near the top.
  { page: 3, rect: frac(0, 120, 400, 300) },
];

const input = await build();
const [out] = await redact(new File([input], "case.pdf"), marks, { redactDpi: "150" });
const bytes = new Uint8Array(await out.blob.arrayBuffer());
const doc = await PDFDocument.load(bytes);
const pdf = await openPdf(bytes.slice());
const pageText = async (i) => (await (await pdf.getPage(i + 1)).getTextContent()).items.map((t) => t.str).join(" ");
const text = (await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pageText(i)))).join(" | ");
console.log(`      text after: ${text}`);

await test("secret gone from every object, in any encoding", async () => {
  const raw = new TextDecoder("latin1").decode(bytes);
  eq(raw.includes(SECRET), false, "secret in the raw file");
  eq((await holding(bytes, SECRET)).join(","), "", "objects holding the secret");
});

await test("secret gone from extracted text, public text still real", () => {
  eq(/4471/.test(text.replace("secret-4471", "")), false, "secret in text");
  for (const kept of ["Account", "belongs to the client", "Public paragraph stays readable", "Tag page footer", "Form page footer", "Turned page footer", "secret-4471"])
    eq(text.includes(kept), true, `"${kept}" kept`);
});

await test("image pixels under the box blacked out, others untouched", () => {
  const [, img] = doc.context.enumerateIndirectObjects().find(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const w = img.dict.get(PDFName.of("Width")).asNumber();
  const raw = decodePDFRawStream(img).decode();
  // Image spans x 100–300, y 120–220 at 2 pt per pixel; the box covers x 150–200, y 140–190.
  const at = (x, y) => raw[(Math.round((220 - y) / 2) * w + Math.round((x - 100) / 2)) * 3];
  eq(at(175, 165), 0, "inside");
  eq(at(260, 165), 200, "outside");
});

await test("link over the secret removed, other link kept", () => {
  const annots = doc.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray).asArray().map((r) => doc.context.lookup(r));
  const urls = annots.map((a) => a.lookup(PDFName.of("A"), PDFDict).lookup(PDFName.of("URI")).decodeText());
  eq(urls.join(","), "https://example.com/public", "links");
});

await test("search boxes cover the whole match, first character included", async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([W, H]).drawText("Account 1234-5678 belongs to the client", { x: 20, y: 250, size: 12, font });
  const input = new Uint8Array(await d.save());
  const page = await textOf(await (await openPdf(input.slice())).getPage(1));
  const hits = findMatches([page], /1234-5678/g);
  eq(hits.length, 1, "hits");
  const run = page.items.find((r) => r.text.includes("1234-5678"));
  const i = run.text.indexOf("1234-5678");
  const pad = run.size * 0.12;
  const { rect } = hits[0];
  eq(rect.x * W <= run.xs[i] - pad + 0.01, true, `box starts at ${(rect.x * W).toFixed(2)}, first digit at ${run.xs[i].toFixed(2)}`);
  eq((rect.x + rect.w) * W >= run.xs[i + 9] + pad - 0.01, true, "box reaches the last digit");
  const [res] = await redact(new File([input], "n.pdf"), hits, { redactDpi: "100" });
  const after = await allText(new Uint8Array(await res.blob.arrayBuffer()));
  eq(/\d/.test(after), false, `digits left in "${after}"`);
});

// ── Search across runs. A phrase can be one run, two text objects, change
// style halfway, wrap to the next line or be hyphenated there.
async function phrases() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const bold = await d.embedFont(StandardFonts.HelveticaBold);
  const p = d.addPage([W, H]);
  let x = 20;
  const put = (s, y, f = font) => {
    p.drawText(s, { x, y, size: 12, font: f });
    x += f.widthOfTextAtSize(s, 12);
  };
  const line = (y, ...parts) => {
    x = 20;
    for (const part of parts) put(...(Array.isArray(part) ? [part[0], y, part[1]] : [part, y]));
  };
  line(270, "Patient John Smith discharged");
  line(250, "Patient John ", "Smith admitted"); // two text objects
  line(230, "Patient John ", [ "Smith", bold ], " seen"); // bold surname
  line(200, "Please call John");
  line(186, "Smith today about the confiden-");
  line(172, "tial file");
  return new Uint8Array(await d.save());
}
const hitCount = (hits) => new Set(hits.map((h) => h.hit)).size;
// What the editor sends for each fully marked text: the text and the search that found it.
const termsOf = (hits, pattern) => [...new Set(hits.map((h) => h.text))].map((text) => ({ text, pattern }));

await test("phrases are found across text runs and line breaks", async () => {
  const { searchPattern } = await load("security");
  const input = await phrases();
  const page = await textOf(await (await openPdf(input.slice())).getPage(1));
  const names = findMatches([page], searchPattern("john smith"));
  eq(hitCount(names), 4, "hits for John Smith");
  eq(names.length, 5, "boxes (the wrapped one has one per line)");
  const word = findMatches([page], searchPattern("confidential"));
  eq(hitCount(word), 1, "hits for the hyphenated word");
  // The hyphen left at the line end is part of the word: its box reaches past it.
  const run = page.items.find((r) => r.text.endsWith("confiden-"));
  const first = word.find((h) => h.rect.y * H < run.y + run.h);
  eq((first.rect.x + first.rect.w) * W >= run.xs[run.text.length] + run.size * 0.12 - 0.01, true, "box covers the hyphen");
  const terms = [...termsOf(names, searchPattern("john smith")), ...termsOf(word, searchPattern("confidential"))];
  const [res] = await redact(new File([input], "p.pdf"), [...names, ...word], { redactDpi: "100", terms });
  const after = await allText(new Uint8Array(await res.blob.arrayBuffer()));
  console.log(`      phrases after: ${after}`);
  for (const gone of ["John", "Smith", "confiden", "tial"]) eq(after.includes(gone), false, `"${gone}" left`);
  for (const kept of ["discharged", "admitted", "seen", "Please call", "today about the", "file"]) eq(after.includes(kept), true, `"${kept}" kept`);
});

await test("phrases wrap in turned text too", async () => {
  const { searchPattern } = await load("security");
  for (const angle of [90, 180, 270]) {
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([612, 792]);
    const [c, s] = [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)];
    // Each line under the one before, in the text's own direction.
    ["Please call John", "Smith today about the confiden-", "tial file"].forEach((t, i) => p.drawText(t, { x: 306 + s * i * 14, y: 396 - c * i * 14, size: 12, font, rotate: degrees(angle) }));
    const input = new Uint8Array(await d.save());
    const page = await textOf(await (await openPdf(input.slice())).getPage(1));
    const names = findMatches([page], searchPattern("john smith"));
    const word = findMatches([page], searchPattern("confidential"));
    eq(hitCount(names), 1, `${angle}°: hits for John Smith in ${JSON.stringify(page.lines.map((l) => l.text))}`);
    eq(hitCount(word), 1, `${angle}°: hits for the hyphenated word`);
    const [res] = await redact(new File([input], "t.pdf"), [...names, ...word], { redactDpi: "100" });
    const after = await allText(new Uint8Array(await res.blob.arrayBuffer()));
    for (const gone of ["John", "Smith", "confiden", "tial"]) eq(after.includes(gone), false, `${angle}°: "${gone}" left in "${after}"`);
  }
});

await test("words and numbers wrapped at a hyphen are found as typed", async () => {
  const { searchPattern, PRESETS } = await load("security");
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([W, H]);
  ["Her social security number is 123-45-", "6789 and the claim reference is AB-", "77120 as filed. The drug is a well-", "known anti-", "cancer agent."]
    .forEach((t, i) => p.drawText(t, { x: 20, y: 250 - i * 14, size: 12, font }));
  const input = new Uint8Array(await d.save());
  const page = await textOf(await (await openPdf(input.slice())).getPage(1));
  const count = (q, o) => hitCount(findMatches([page], searchPattern(q, o)));
  for (const [q, o] of [["123-45-6789", {}], ["AB-77120", {}], ["well-known", {}], ["known", { wholeWord: true }], ["anti-cancer", {}], ["cancer", { wholeWord: true }], ["wellknown", {}]])
    eq(count(q, o), 1, `hits for "${q}" ${JSON.stringify(o)}`);
  const numbers = findMatches([page], PRESETS.numbers);
  eq(`${hitCount(numbers)} ${numbers[0]?.text}`, "1 123-45-6789", "long numbers");
  const pattern = searchPattern("123-45-6789");
  const hits = findMatches([page], pattern);
  const [res] = await redact(new File([input], "w.pdf"), hits, { redactDpi: "100", terms: termsOf(hits, pattern) });
  const after = await allText(new Uint8Array(await res.blob.arrayBuffer()));
  eq(/123|6789/.test(after), false, `number left in "${after}"`);
  eq(after.includes("and the claim reference"), true, "text beside it kept");
});

await test("quick marks stay within a line and a table cell", async () => {
  const { PRESETS } = await load("security");
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([W, H]);
  [["2023", 20], ["2024", 120], ["2025", 220]].forEach(([s, x]) => p.drawText(s, { x, y: 260, size: 12, font }));
  p.drawText("1999", { x: 20, y: 240, size: 12, font });
  p.drawText("2000", { x: 20, y: 226, size: 12, font });
  p.drawText("Card 4111 1111 1111 1111, call +1 (555) 123-4567", { x: 20, y: 200, size: 12, font });
  const page = await textOf(await (await openPdf(new Uint8Array(await d.save()))).getPage(1));
  eq(findMatches([page], PRESETS.numbers).map((h) => h.text).join("|"), "4111 1111 1111 1111|123-4567", "long numbers");
  eq(findMatches([page], PRESETS.phones).map((h) => h.text).join("|"), "4111 1111 1111 1111|+1 (555) 123-4567", "phone numbers");
});

await test("match case and whole words", async () => {
  const { searchPattern } = await load("security");
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([W, H]).drawText("Ann met ANN and Anna about the annual plan", { x: 20, y: 250, size: 12, font });
  const page = await textOf(await (await openPdf(new Uint8Array(await d.save()))).getPage(1));
  const count = (q, o) => hitCount(findMatches([page], searchPattern(q, o)));
  eq(count("ann"), 4, "anywhere, any case");
  eq(count("ann", { wholeWord: true }), 2, "whole words");
  eq(count("Ann", { matchCase: true }), 2, "same case");
  eq(count("Ann", { matchCase: true, wholeWord: true }), 1, "both");
});

await test("checked terms: only what the same search finds again counts as left", async () => {
  const { searchPattern } = await load("security");
  // The output's own dates and producer hold the year and "Foliant".
  const year = String(new Date().getUTCFullYear());
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([W, H]);
  p.drawText("Ann met Anna about the plan", { x: 20, y: 250, size: 12, font });
  p.drawText(`Invoice of 17 Oct ${year}, printed by Foliant`, { x: 20, y: 220, size: 12, font });
  p.drawText("Account 4471 closed", { x: 20, y: 190, size: 12, font });
  // Two table cells, far apart.
  p.drawText("44", { x: 20, y: 160, size: 12, font });
  p.drawText("71", { x: 120, y: 160, size: 12, font });
  const input = new Uint8Array(await d.save());
  const page = await textOf(await (await openPdf(input.slice())).getPage(1));
  for (const [q, o, gone, kept] of [["ann", { wholeWord: true }, /\bAnn\b/, "Anna"], [year, {}, year, "Invoice of 17 Oct"], ["Foliant", {}, "Foliant", "printed by"], ["4471", {}, "4471", "44 71"]]) {
    const pattern = searchPattern(q, o);
    const hits = findMatches([page], pattern);
    const res = await redact(new File([input], "t.pdf"), hits, { redactDpi: "100", terms: termsOf(hits, pattern) }).then(([r]) => r, (e) => e);
    eq(res.code, undefined, `"${q}" ${JSON.stringify(o)}: error`);
    const after = (await allText(new Uint8Array(await res.blob.arrayBuffer()))).replace(/\s+/g, " ");
    eq(typeof gone === "string" ? after.includes(gone) : gone.test(after), false, `"${q}" left in "${after}"`);
    eq(after.includes(kept), true, `"${kept}" kept in "${after}"`);
  }
});

// `terms` asks redact() to check the whole output for the searched texts.
async function noted(where) {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([W, H]);
  p.drawText("Patient SECRET-9 discharged", { x: 20, y: 250, size: 12, font });
  const other = d.addPage([W, H]);
  other.drawText("Follow-up notes", { x: 20, y: 250, size: 12, font });
  const note = d.context.register(d.context.obj({ Type: "Annot", Subtype: "Text", Rect: [300, 50, 320, 70], Contents: PDFHexString.fromText("Call about SECRET-9") }));
  if (where) (where === "same" ? p : other).node.set(PDFName.of("Annots"), d.context.obj([note]));
  const input = new Uint8Array(await d.save());
  const hits = findMatches([await textOf(await (await openPdf(input.slice())).getPage(1))], /SECRET-9/g);
  const [res] = await redact(new File([input], "n.pdf"), hits, { redactDpi: "100", terms: [{ text: "SECRET-9" }] });
  return new Uint8Array(await res.blob.arrayBuffer());
}
const images = async (bytes) => (await PDFDocument.load(bytes)).context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")).length;

await test("checked terms: a clean result stays vector", async () => {
  const out = await noted(null);
  eq((await holding(out, "SECRET-9")).length + (await allText(out)).includes("SECRET-9"), 0, "secret left");
  eq(await images(out), 0, "pages drawn as images");
});

await test("checked terms: a copy left on a marked page is cleared by drawing it as an image", async () => {
  const out = await noted("same");
  eq((await holding(out, "SECRET-9")).join(","), "", "objects holding the secret");
  eq(await images(out), 1, "pages drawn as images");
  eq((await allText(out)).includes("Follow-up notes"), true, "other page kept");
});

await test("checked terms: a copy left on another page stops the export", async () => {
  const err = await noted("other").then(() => null, (e) => e);
  eq(err?.code, "redaction_leak", `error (${err?.message})`);
});

await test("a form field under a box is gone, though its form goes on another page", async () => {
  // Fields named applicant.name and applicant.address share a parent field.
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  const [p1, p2] = [d.addPage([W, H]), d.addPage([W, H])];
  p1.drawText("Name:", { x: 20, y: 250, size: 12, font });
  const form = d.getForm();
  const nameField = form.createTextField("applicant.name");
  nameField.setText("SECRET-5555");
  nameField.addToPage(p1, { x: 80, y: 240, width: 150, height: 24, font });
  const address = form.createTextField("applicant.address");
  address.setText("1 Main Street");
  address.addToPage(p2, { x: 80, y: 240, width: 150, height: 24, font });
  const input = new Uint8Array(await d.save());
  const box = [{ page: 0, rect: frac(70, 30, 240, 65) }];
  const [res] = await redact(new File([input], "f.pdf"), box, { redactDpi: "100" });
  const out = new Uint8Array(await res.blob.arrayBuffer());
  eq((await holding(out, "SECRET-5555")).join(","), "", "objects holding the secret");
  eq((await PDFDocument.load(out)).getPage(1).node.lookup(PDFName.of("Annots"), PDFArray).size(), 1, "widget on page 2 kept");
  const err = await redact(new File([input], "f.pdf"), box, { redactDpi: "100", terms: [{ text: "SECRET-5555" }] }).then(() => null, (e) => e);
  eq(err?.code, undefined, "checked terms: error");
});

await test("without qpdf's rewrite, nothing is saved", async () => {
  // qpdf drops what PDFium took off the page but left in its resources.
  const qpdf = await load("qpdf");
  const [url, log] = [qpdf.qpdfWasm.url, console.error];
  qpdf.qpdfWasm.url = () => "/nonexistent/qpdf.wasm";
  console.error = () => {};
  try {
    const err = await redact(new File([input], "case.pdf"), marks, { redactDpi: "150" }).then(() => null, (e) => e);
    eq(err instanceof Error, true, "redact() refused");
  } finally {
    [qpdf.qpdfWasm.url, console.error] = [url, log];
  }
});

await test("pages stay vector (no page turned into an image)", () => {
  const images = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(images.length, 1, "images (only the original one)");
  eq(doc.getPage(3).getRotation().angle, 90, "rotation kept");
});

await test("bookmarks and metadata don't carry the secret", () => {
  eq(doc.catalog.get(PDFName.of("Outlines")), undefined, "outlines");
  eq(String(doc.getTitle()).includes("4471"), false, "title");
});

// ── Odd page boxes. Both are legal: a rectangle may name any two opposite
// corners, and what's seen is the CropBox clipped to the MediaBox. Pages 8
// and 9 of 10 carry them; the rest are plain.
const { pageNumbers, watermark } = await load("edit");
async function oddBoxes() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 10; i++) {
    const p = d.addPage([612, 792]);
    p.drawText(`Page body SECRET-${i + 1}0 here`, { x: 160, y: 500, size: 16, font });
    if (i === 7) p.node.set(PDFName.of("MediaBox"), d.context.obj([612, 792, 0, 0]));
    if (i === 8) p.setCropBox(-100, -100, 2000, 2000);
  }
  return new Uint8Array(await d.save());
}
const odd = await oddBoxes();
// Text of each page that lies on the page as seen.
async function seen(bytes) {
  const pdf = await openPdf(bytes.slice());
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const t = await textOf(await pdf.getPage(i));
    out.push(t.lines.filter((l) => l.x >= 0 && l.y >= 0 && l.x + l.w <= t.width && l.y + l.size <= t.height).map((l) => l.text).join(" | "));
  }
  return out;
}

await test("odd page boxes: the secret is redacted where it's seen", async () => {
  // Boxes as the editor makes them: search hits on pdf.js's view of each page.
  const pdf = await openPdf(odd.slice());
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) pages.push(await textOf(await pdf.getPage(i)));
  const hits = findMatches(pages, /SECRET-\d+/g);
  eq(hits.length, 10, "search hits");
  const [res] = await redact(new File([odd], "odd.pdf"), hits, { redactDpi: "150" });
  const after = await seen(new Uint8Array(await res.blob.arrayBuffer()));
  eq(after.filter((t) => /SECRET/.test(t)).join(" || "), "", "pages still showing a secret");
  eq(after.filter((t) => /Page body\s+here/.test(t)).length, 10, "text beside the box kept");
});

await test("odd page boxes: page numbers and watermarks land on the page", async () => {
  const [numbered] = await pageNumbers(new File([odd], "odd.pdf"), {
    position: "bottom-center", numberFormat: "pageNOfTotal", startAt: 1, pageRange: "", skipFirst: false, fontSize: 12, color: "#000000", facing: false,
  });
  const labels = await seen(new Uint8Array(await numbered.blob.arrayBuffer()));
  for (const n of [1, 8, 9, 10]) eq(labels[n - 1].includes(`Page ${n} of 10`), true, `label on page ${n} in "${labels[n - 1]}"`);
  const [marked] = await watermark(new File([odd], "odd.pdf"), {
    markType: "text", markText: "DRAFT COPY", fontSize: 40, color: "#cc0000", imageScale: 50, position: "middle-center", mosaic: false, opacity: 50, rotation: "0", layer: "over", pageRange: "",
  });
  const marks = await seen(new Uint8Array(await marked.blob.arrayBuffer()));
  eq(marks.filter((t) => t.includes("DRAFT COPY")).length, 10, `pages with the mark: ${JSON.stringify(marks)}`);
});

process.exit(results.failed ? 1 : 0);
