// OCR tests: reads the scanned fixture as it is, turned sideways, upside
// down, skewed and in shadow, and checks the words come back and land where
// they are on the page. Uses real Tesseract (the vendored English model).
//
//   node tests/ocr.mjs
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, createScheduler } from "tesseract.js";
import { root, vendorDir, load, check, eq } from "./lib/load.mjs";

const { readPage } = await load("ocr");
const { rotate90, deskew } = await load("ocrprep");
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

for (const [name, v] of Object.entries(variants)) {
  await test(name, async () => {
    const r = await readPage(recognise, v.image);
    eq(/invoice 4471/i.test(text(r)), true, `text found (got "${text(r).slice(0, 50)}")`);
    eq(r.turns, v.turns, "turns to upright");
    // The word's baseline start lands where the same word is on this variant.
    const found = r.words.find((w) => w.text === "4471");
    const [ex, ey] = v.move(...anchor.corners[0]);
    const [gx, gy] = found.corners[0];
    const off = Math.hypot(gx - ex, gy - ey);
    if (off > 8) throw new Error(`"4471" placed ${off.toFixed(1)} px from where it is`);
    console.log(`      ${r.words.length} words, confidence ${r.confidence.toFixed(0)}, turns ${r.turns}, skew ${(r.skew / deg).toFixed(1)}°, position off by ${off.toFixed(1)} px`);
  });
}

await scheduler.terminate();
process.exit(results.failed ? 1 : 0);
