// Trust-grade redaction (P2-07): quick marks that check what they match
// (Luhn, mod 97, Verhoeff …), a report of what was checked and removed,
// scanned pages read with OCR before searching and again afterwards, and
// right-to-left text. Tesseract reads the vendored models from disk.
//
//   node tests/redact-trust.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createRequire } from "node:module";
import { createWorker, createScheduler } from "tesseract.js";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { root, vendorDir, load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

nodeCanvas();
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
// Bundled fonts the browser fetches from /vendor are read from disk.
globalThis.fetch = async (url) => new Response(readFileSync(join(vendorDir, "fonts", basename(String(url)))));
const { createCanvas } = createRequire(join(root, "package.json"))("@napi-rs/canvas");

const results = { failed: 0 };
const test = check(results);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const security = await load("security");
const { engine } = await load("ocr");
const { grayPng } = await load("ocrprep");
const { documentText } = await load("text");
const edit = await load("edit");

const cache = mkdtempSync(join(tmpdir(), "tess-"));
engine.create = async (lang) => {
  const scheduler = createScheduler();
  scheduler.addWorker(await createWorker(lang, undefined, { langPath: join(vendorDir, "tessdata"), cachePath: cache }));
  return {
    recognise: async (image) => (await scheduler.addJob("recognize", Buffer.from(grayPng(image)), {}, { blocks: true })).data,
    stop: () => scheduler.terminate(),
  };
};

const asFile = (bytes, name = "in.pdf") => new File([bytes], name, { type: "application/pdf" });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const textOf = async (bytes) => {
  const doc = await openPdf(bytes.slice());
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(" "));
  return out.join(" | ");
};
async function textPdf(lines, extra) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 40 + lines.length * 24]);
  lines.forEach((l, i) => page.drawText(l, { x: 30, y: 20 + (lines.length - i - 1) * 24, size: 12, font }));
  await extra?.(doc, page);
  return doc.save();
}
const pagesOf = async (bytes) => documentText(await openPdf(bytes.slice()));

// A Verhoeff check digit, to build valid and invalid Aadhaar-style numbers.
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
const INV = [0,4,3,2,1,5,6,7,8,9];
const verhoeffDigit = (s) => {
  let c = 0;
  [...s].reverse().forEach((d, i) => (c = D[c][P[(i + 1) % 8][Number(d)]]));
  return String(INV[c]);
};
const aadhaar = "23456789012".slice(0, 11) + verhoeffDigit("23456789012".slice(0, 11));
const badAadhaar = aadhaar.slice(0, 11) + String((Number(aadhaar[11]) + 1) % 10);
const spaced = (s) => `${s.slice(0, 4)} ${s.slice(4, 8)} ${s.slice(8)}`;

await test("checks: Luhn, IBAN mod 97 and Verhoeff accept real numbers only", () => {
  eq(security.luhn("4111111111111111"), true, "Luhn valid");
  eq(security.luhn("4111111111111112"), false, "Luhn invalid");
  eq(security.ibanValid("DE89 3704 0044 0532 0130 00"), true, "IBAN valid");
  eq(security.ibanValid("DE89 3704 0044 0532 0130 01"), false, "IBAN invalid");
  eq(security.ibanValid("GB82 WEST 1234 5698 7654 32"), true, "IBAN with letters");
  eq(security.verhoeff(aadhaar), true, "Verhoeff valid");
  eq(security.verhoeff(badAadhaar), false, "Verhoeff invalid");
});

await test("quick marks find real card numbers, IBANs, Aadhaar, PAN, SSN and dates, and skip look-alikes", async () => {
  const pages = await pagesOf(await textPdf([
    "Card 4111 1111 1111 1111 or 4111 1111 1111 1112",
    "IBAN DE89 3704 0044 0532 0130 00 or DE89 3704 0044 0532 0130 01",
    `Aadhaar ${spaced(aadhaar)} or ${spaced(badAadhaar)}`,
    "PAN ABCPE1234F, not ABCZE1234F",
    "SSN 123-45-6789, not 000-12-3456",
    "Due 31/12/2024 or 2024-12-31, not 45/13/2024",
  ]));
  const find = (preset) => [...new Set(security.searchMatches(pages, { pattern: security.PRESETS[preset], preset }).map((h) => h.text))].join("|");
  eq(find("cards"), "4111 1111 1111 1111", "cards");
  eq(find("ibans"), "DE89 3704 0044 0532 0130 00", "IBANs");
  eq(find("aadhaar"), spaced(aadhaar), "Aadhaar");
  eq(find("pan"), "ABCPE1234F", "PAN");
  eq(find("ssn"), "123-45-6789", "SSN");
  eq(find("dates"), "31/12/2024|2024-12-31", "dates");
});

await test("a redaction reports what it checked and what else it removed", async () => {
  const bytes = await textPdf(["Contact jane@example.com today", "Keep this line"], async (doc, page) => {
    doc.setAuthor("Jane Roe");
    doc.setKeywords(["secret"]);
    const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [30, 40, 200, 56], A: { S: "URI", URI: PDFString.of("mailto:jane@example.com") } }));
    page.node.set(PDFName.of("Annots"), doc.context.obj([link]));
  });
  const pages = await pagesOf(bytes);
  const hits = security.searchMatches(pages, { pattern: security.PRESETS.emails, preset: "emails" });
  const [out] = await security.redact(asFile(bytes), hits.map((h) => ({ page: h.page, rect: h.rect })), { redactDpi: "150", terms: [{ text: "jane@example.com", pattern: security.PRESETS.emails }] });
  const r = out.report;
  eq(r.kind, "redact", "kind");
  eq(r.areas, 1, "areas");
  eq(r.terms, 1, "terms checked");
  eq(r.textLeft, 0, "none left");
  eq(r.annots, 1, "the link under the box");
  eq(r.metadata.join(","), "Author,Keywords", "properties removed");
  const text = await textOf(await bytesOf(out.blob));
  ok(!text.includes("jane@example.com") && text.includes("Keep this line"), text);
});

// A scanned page: a picture of text, no text layer.
async function scan(lines) {
  const W = 1240, H = 400;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.fillStyle = "#000";
  g.font = "44px sans-serif";
  lines.forEach((l, i) => g.fillText(l, 60, 110 + i * 90));
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(c.toBuffer("image/png"));
  doc.addPage([W * 0.48, H * 0.48]).drawImage(img, { x: 0, y: 0, width: W * 0.48, height: H * 0.48 });
  return doc.save();
}

await test("a scanned page is read with OCR, the email is redacted, and neither text nor OCR finds it after", async () => {
  const file = asFile(await scan(["Contact anna@example.com now", "Invoice number 4471"]), "scanned.pdf");
  const r = await security.searchable(file, "eng");
  eq(r.scanned.join(), "0", "the scanned page");
  const hits = security.searchMatches(r.pages, { pattern: security.PRESETS.emails, preset: "emails" });
  eq(hits.map((h) => h.text).join(), "anna@example.com", "found by OCR");
  const [out] = await security.redact(r.file, hits.map((h) => ({ page: h.page, rect: h.rect })), {
    redactDpi: "150", terms: hits.map((h) => ({ text: h.text, pattern: security.PRESETS.emails })), scanned: r.scanned, ocrLang: "eng",
  });
  const bytes = await bytesOf(out.blob);
  ok(!(await textOf(bytes)).includes("anna@example.com"), "pdf.js text");
  const again = await security.searchable(asFile(await scan([])), "eng"); // engine warm, a blank page reads nothing
  eq(again.scanned.length, 0, "a blank picture has no text");
  // The report's own OCR reading of the result, plus one here.
  eq(out.report.ocrPages, 1, "OCR pages");
  eq(out.report.ocrLeft, 0, "OCR finds nothing");
  const { autoOcr } = await load("ocr");
  const reread = await autoOcr(asFile(bytes), { ocrLang: "eng" });
  const text = await textOf(await bytesOf(reread.file));
  ok(!text.includes("anna@example.com"), `OCR of the output: ${text}`);
  ok(/4471/.test(text), `the rest is still readable: ${text}`);
});

await test("batch redaction reads scans too", async () => {
  const [out] = await security.redactSearches(asFile(await scan(["Mail bob@example.org please"]), "b.pdf"), [{ pattern: security.PRESETS.emails, preset: "emails" }], { redactDpi: "150", ocrLang: "eng" });
  eq(out.name, "b-redacted.pdf", "name");
  eq(out.report.ocrLeft, 0, "OCR finds nothing");
  eq(out.report.areas >= 1, true, "an area");
});

await test("right-to-left: an Arabic word is found and redacted, its neighbour kept", async () => {
  const base = await textPdf([" "]);
  const [marked] = await edit.watermark(asFile(base), {
    markType: "text", markText: "مرحبا محمد", fontSize: 28, color: "#000000", imageScale: 40, position: "middle-center",
    mosaic: false, opacity: 100, rotation: 0, layer: "over", pageRange: "", font: "noto",
  });
  const bytes = await bytesOf(marked.blob);
  // Without the control characters the font's unmapped glyphs read as, in either order.
  const words = async (b) => (await textOf(b)).replace(/[\x00-\x1f]/g, "");
  const has = (t, w) => t.includes(w) || t.includes([...w].reverse().join(""));
  ok(has(await words(bytes), "مرحبا"), `the word is there before: ${await words(bytes)}`);
  const pages = await pagesOf(bytes);
  const hits = security.searchMatches(pages, { pattern: security.searchPattern("مرحبا", { wholeWord: true }) });
  eq(hits.length, 1, `one match in ${JSON.stringify(pages[0].lines.map((l) => l.text))}`);
  const [out] = await security.redact(asFile(bytes), hits.map((h) => ({ page: h.page, rect: h.rect })), { redactDpi: "150", terms: [{ text: "مرحبا", pattern: security.searchPattern("مرحبا", { wholeWord: true }) }] });
  const text = await words(await bytesOf(out.blob));
  ok(!has(text, "مرحبا") && !has(text, "مرحب"), `redacted: ${text}`);
  ok(has(text, "محمد"), `neighbour kept: ${text}`);
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
