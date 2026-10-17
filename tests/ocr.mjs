// OCR tests: reads the scanned fixture as it is, turned sideways either way,
// upside down, skewed and in shadow, and checks the words come back and land
// where they are on the page, with Tesseract (the vendored English model) and
// PaddleOCR (high accuracy). Then runs the whole tool and checks the output
// PDF: sideways pages turned upright, the text layer upright over the words.
//
//   node tests/ocr.mjs
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, createScheduler } from "tesseract.js";
import { createCanvas } from "@napi-rs/canvas";
import { Util } from "pdfjs-dist/legacy/build/pdf.mjs";
import { root, vendorDir, load, openPdf, check, eq } from "./lib/load.mjs";

const { readPage, ocr, engine } = await load("ocr");
const { rotate90, deskew } = await load("ocrprep");
const paddle = await load("paddle");
paddle.paddleFiles.url = (name) => join(vendorDir, "paddle", name);
paddle.paddleFiles.load = async (name) => new Uint8Array(readFileSync(join(vendorDir, "paddle", name)));
paddle.paddleFiles.proxy = () => false;
const results = { failed: 0 };
const test = check(results);

// The scan inside tests/fixtures/scanned.pdf, as grey pixels.
const src = await PDFDocument.load(readFileSync(join(root, "tests/fixtures/scanned.pdf")));
const [, stream] = src.context.enumerateIndirectObjects().find(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
const rgb = decodePDFRawStream(stream).decode();
const W = 800, H = 1100;
const upright = { w: W, h: H, data: new Uint8Array(W * H).map((_, i) => (rgb[i * 3] * 77 + rgb[i * 3 + 1] * 150 + rgb[i * 3 + 2] * 29) >> 8) };

// Two workers reading the vendored language data from disk.
const scheduler = createScheduler();
const cache = mkdtempSync(join(tmpdir(), "tess-"));
for (let i = 0; i < 2; i++) scheduler.addWorker(await createWorker("eng", undefined, { langPath: join(vendorDir, "tessdata"), cachePath: cache }));
const { grayPng } = await load("ocrprep");
const recognise = async (image) => (await scheduler.addJob("recognize", Buffer.from(grayPng(image)), {}, { blocks: true })).data;

const deg = Math.PI / 180;
const shadow = (g) => ({ ...g, data: g.data.map((v, i) => Math.round(v * (0.42 + 0.58 * ((i % g.w) / g.w)))) });

// Each variant and how a point on the upright scan moves into it.
// `turns`: the clockwise quarter turns that put it upright again.
const variants = {
  upright: { image: upright, turns: 0, move: (x, y) => [x, y] },
  sideways: { image: rotate90(upright, 1), turns: 3, move: (x, y) => [H - y, x] },
  sidewaysLeft: { image: rotate90(upright, 3), turns: 1, move: (x, y) => [y, W - x] },
  upsideDown: { image: rotate90(upright, 2), turns: 2, move: (x, y) => [W - x, H - y] },
  skewed3deg: {
    image: deskew(upright, -3 * deg), // turns the page 3° clockwise
    turns: 0,
    move: (x, y) => {
      const dx = x - W / 2, dy = y - H / 2, c = Math.cos(3 * deg), s = Math.sin(3 * deg);
      return [W / 2 + dx * c - dy * s, H / 2 + dx * s + dy * c];
    },
  },
  shadowed: { image: shadow(upright), turns: 0, move: (x, y) => [x, y] },
};

const text = (r) => r.words.map((w) => w.text).join(" ");
const reference = await readPage(recognise, upright);
const anchor = reference.words.find((w) => w.text === "4471");
console.log(`      upright reads: "${text(reference).slice(0, 70)}…"`);

// Both engines against the same anchor: Tesseract's reading of the upright page.
for (const [engineName, read, slack] of [["Tesseract", recognise, 8], ["PaddleOCR", paddle.paddlePage, 10]]) {
  for (const [name, v] of Object.entries(variants)) {
    await test(`${engineName}: ${name}`, async () => {
      const r = await readPage(read, v.image);
      eq(r.words.length >= 7, true, `words read (got ${r.words.length})`);
      eq(/invoice 4471/i.test(text(r)), true, `text found (got "${text(r).slice(0, 50)}")`);
      eq(r.turns, v.turns, "turns to upright");
      // The word's baseline start lands where the same word is on this variant.
      const found = r.words.find((w) => w.text === "4471");
      const [ex, ey] = v.move(...anchor.corners[0]);
      const [gx, gy] = found.corners[0];
      const off = Math.hypot(gx - ex, gy - ey);
      if (off > slack) throw new Error(`"4471" placed ${off.toFixed(1)} px from where it is`);
      console.log(`      ${r.words.length} words, confidence ${r.confidence.toFixed(0)}, turns ${r.turns}, skew ${(r.skew / deg).toFixed(1)}°, position off by ${off.toFixed(1)} px`);
    });
  }
}

// ── The whole tool, on one-page PDFs of each variant

globalThis.document ??= { createElement: () => createCanvas(1, 1) };
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
engine.create = async () => ({ recognise, stop: async () => {} });

async function scanPdf(image) {
  const doc = await PDFDocument.create();
  const png = await doc.embedPng(grayPng(image));
  // At 96 dpi, so the tool's 96 dpi render matches the scan pixel for pixel.
  doc.addPage([image.w * 0.75, image.h * 0.75]).drawImage(png, { x: 0, y: 0, width: image.w * 0.75, height: image.h * 0.75 });
  return doc.save();
}

// Where "4471" is on the page as a viewer shows it (after /Rotate), and its angle there.
async function located(image) {
  const [out] = await ocr(new File([await scanPdf(image)], "scan.pdf"), { ocrLang: "eng", dpi: "96" });
  const page = await (await openPdf(new Uint8Array(await out.blob.arrayBuffer()))).getPage(1);
  const view = page.getViewport({ scale: 1 });
  const item = (await page.getTextContent()).items.find((t) => t.str === "4471");
  if (!item) throw new Error("no 4471 in the text layer");
  const m = Util.transform(view.transform, item.transform);
  return { rotate: page.rotate, x: m[4], y: m[5], angle: (Math.atan2(m[1], m[0]) * 180) / Math.PI };
}

const upright96 = await located(upright);
for (const [name, v] of Object.entries(variants)) {
  if (!v.turns) continue; // the quarter turns; skew and shadow are covered above
  await test(`output PDF: ${name}`, async () => {
    const r = await located(v.image);
    eq(r.rotate, v.turns * 90, "page turned upright");
    const off = Math.hypot(r.x - upright96.x, r.y - upright96.y);
    if (off > 10) throw new Error(`"4471" ${off.toFixed(1)} pt from where it is upright`);
    if (Math.abs(r.angle - upright96.angle) > 4) throw new Error(`"4471" at ${r.angle.toFixed(1)}°, upright is ${upright96.angle.toFixed(1)}°`);
    console.log(`      /Rotate ${r.rotate}, "4471" ${off.toFixed(1)} pt from upright, ${r.angle.toFixed(1)}°`);
  });
}

await scheduler.terminate();
process.exit(results.failed ? 1 : 0);
