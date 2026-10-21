// Compress to a size, and the exam-form photo kit. Builds a scan-like PDF
// (ten pages of 200 dpi greyish paper with a hidden text layer, as OCR'd
// scans have) and a photo-heavy one, then asks for 100, 200 and 500 KB. Each
// must land at or under the target and within 15% of it, or say plainly that
// the target can't be reached. Every result must open in pdf.js with its text.
//
//   node tests/targetsize.mjs
import { PDFDocument, StandardFonts, TextRenderingMode, rgb, setTextRenderingMode } from "pdf-lib";
import { join } from "node:path";
import { createRequire } from "node:module";
import { load, openPdf, check, eq, root } from "./lib/load.mjs";

const { compressToSize } = await load("targetsize");
const { fitImage, EXAM_PRESETS } = await load("examkit");
const { jpegFrame, decodeJpeg } = await load("jpeg");
const sharp = createRequire(join(root, "package.json"))("sharp");
const results = { failed: 0 };
const test = check(results);
const ok = (cond, what) => { if (!cond) throw new Error(what); };
const KB = 1024;

let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

// A scanned A4 page: warm off-white paper with grain, and rows of dark
// "words" with soft edges, saved the way a scanner would (colour JPEG, q70).
async function scanPage(w, h) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    // Uneven lighting, and the odd speck of dust.
    const g = 234 + 4 * Math.sin((i % w) / 90) * Math.cos(i / w / 130) - (rnd() < 0.0005 ? 60 : 0);
    data[i * 3] = g + 6;
    data[i * 3 + 1] = g + 2;
    data[i * 3 + 2] = g - 8;
  }
  const line = Math.round(h / 40);
  for (let y = Math.round(h * 0.08); y < h * 0.92; y += line) {
    let x = Math.round(w * 0.1);
    while (x < w * 0.88) {
      const word = Math.round(w * (0.02 + rnd() * 0.07));
      for (let yy = y; yy < y + line * 0.45; yy++)
        for (let xx = x; xx < Math.min(x + word, w * 0.9); xx++) {
          if ((xx - x) % 12 < 5) continue; // strokes, not solid blocks
          const v = 60;
          data.set([v, v, v + 4], (yy * w + xx) * 3);
        }
      x += word + Math.round(w * 0.012);
    }
  }
  return new Uint8Array(await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 70 }).toBuffer());
}

// Smooth colour fields with fine noise: compresses like a photo.
async function photo(w, h) {
  const data = new Uint8Array(w * h * 3);
  const f = 40 + rnd() * 80;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = (rnd() - 0.5) * 30;
      data.set([
        128 + 90 * Math.sin(x / f) * Math.cos(y / (f * 0.7)) + n,
        120 + 80 * Math.sin((x + y) / (f * 1.4)) + n,
        110 + 70 * Math.cos(x / (f * 0.6) - y / f) + n,
      ].map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 3);
    }
  return new Uint8Array(await sharp(Buffer.from(data), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer());
}

const WORDS = (n) => `Scanned page ${n} reference NOP-${1000 + n}`;

async function scanPdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 10; n++) {
    const img = await d.embedJpg(await scanPage(1654, 2339));
    const page = d.addPage([595, 842]);
    page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
    // The invisible OCR text layer (rendering mode 3), as OCR tools write it.
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    page.drawText(WORDS(n), { x: 60, y: 760, size: 14, font });
  }
  return d.save();
}

async function photoPdf() {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 4; n++) {
    const page = d.addPage([595, 842]);
    page.drawText(`Photo report ${n}`, { x: 50, y: 790, size: 20, font, color: rgb(0.1, 0.1, 0.1) });
    page.drawImage(await d.embedJpg(await photo(1800, 1200)), { x: 50, y: 420, width: 495, height: 330 });
    page.drawImage(await d.embedJpg(await photo(1500, 1000)), { x: 50, y: 60, width: 495, height: 330 });
  }
  return d.save();
}

const scan = await scanPdf();
const photos = await photoPdf();
console.log(`      scan.pdf ${(scan.length / KB).toFixed(0)} KB, photos.pdf ${(photos.length / KB).toFixed(0)} KB`);

async function textOf(bytes) {
  const doc = await openPdf(bytes);
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    out.push((await page.getTextContent()).items.map((x) => x.str).join(" "));
    // Every image must decode: render the page's operator list.
    await page.getOperatorList();
  }
  return out;
}

for (const [name, bytes, pages, words] of [["scan.pdf", scan, 10, WORDS], ["photos.pdf", photos, 4, (n) => `Photo report ${n}`]]) {
  for (const kb of [100, 200, 500]) {
    await test(`${name} to ${kb} KB lands under it and within 15%, or says it can't`, async () => {
      const t0 = Date.now();
      const [res] = await compressToSize(new File([bytes], name), { targetBytes: kb * KB, gray: true });
      const size = res.blob.size;
      console.log(`      ${(size / KB).toFixed(1)} KB, ${res.note}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      if (res.note.startsWith("targetMissed:")) {
        const [, target, , got] = res.note.split(":").map(Number);
        eq(target, kb * KB, "target in the note");
        eq(got, size, "size in the note");
        ok(size > kb * KB, "reported missed but fits");
      } else {
        ok(res.note.startsWith("target:"), `note ${res.note}`);
        ok(size <= kb * KB, `${size} bytes is over ${kb * KB}`);
        ok(size >= kb * KB * 0.85, `${size} bytes is more than 15% under ${kb * KB}`);
      }
      const text = await textOf(new Uint8Array(await res.blob.arrayBuffer()));
      eq(text.length, pages, "pages");
      for (let n = 1; n <= pages; n++) ok(text[n - 1].includes(words(n)), `page ${n} lost its text: ${text[n - 1].slice(0, 80)}`);
    });
  }
}

await test("a 3 MB, 10-page scan reaches 200 KB (204,800 bytes)", async () => {
  ok(scan.length > 2.5 * KB * KB, `fixture is only ${scan.length} bytes`);
  const [res] = await compressToSize(new File([scan], "scan.pdf"), { targetBytes: 200 * KB, gray: true });
  ok(res.note.startsWith("target:"), `note ${res.note}`);
  ok(res.blob.size <= 204800, `${res.blob.size} bytes`);
});

await test("a file already under the target comes back unchanged", async () => {
  const d = await PDFDocument.create();
  d.addPage([200, 200]).drawText("small", { x: 20, y: 100 });
  const small = await d.save();
  const [res] = await compressToSize(new File([small], "small.pdf"), { targetBytes: 50 * KB, gray: false });
  eq(res.note, `underTarget:${50 * KB}:${small.length}`, "note");
  const back = new Uint8Array(await res.blob.arrayBuffer());
  ok(back.length === small.length && back.every((b, i) => b === small[i]), "bytes changed");
});

await test("an unreachable target is reported with the smallest result", async () => {
  // Text only, with a big embedded font: there are no images to shrink.
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Courier);
  for (let i = 0; i < 40; i++) d.addPage([595, 842]).drawText(`Page ${i} `.repeat(200), { x: 20, y: 400, size: 6, font, maxWidth: 560 });
  const bytes = await d.save({ useObjectStreams: false });
  const [res] = await compressToSize(new File([bytes], "text.pdf"), { targetBytes: 2 * KB, gray: true });
  ok(res.note.startsWith("targetMissed:"), `note ${res.note}`);
  ok(res.blob.size > 2 * KB, "it fits after all");
  ok(res.blob.size <= bytes.length, "bigger than the input");
});

await test("without greyscale allowed, colour images stay colour", async () => {
  const [res] = await compressToSize(new File([photos], "photos.pdf"), { targetBytes: 200 * KB, gray: false });
  const doc = await PDFDocument.load(await res.blob.arrayBuffer());
  const spaces = doc.context.enumerateIndirectObjects()
    .filter(([, o]) => o.dict?.get?.(doc.context.obj("Subtype")) === doc.context.obj("Image"))
    .map(([, o]) => String(o.dict.get(doc.context.obj("ColorSpace"))));
  ok(spaces.length && spaces.every((s) => s !== "/DeviceGray"), `colour spaces ${spaces.join(" ")}`);
});

// ── Exam kit

async function rgbPixels(w, h) {
  const jpg = await photo(w, h);
  return decodeJpeg(jpg);
}

await test("exam photo preset: 200x230 px, at most 50 KB", async () => {
  const spec = EXAM_PRESETS.photo;
  eq(`${spec.w}x${spec.h}`, "200x230", "preset size");
  const r = await fitImage(await rgbPixels(1200, 1600), { ...spec, fit: "crop", gray: false });
  const f = jpegFrame(r.bytes);
  eq(`${f.w}x${f.h}`, "200x230", "output size");
  ok(r.bytes.length <= spec.maxKb * KB, `${r.bytes.length} bytes`);
  ok(r.bytes.length >= spec.minKb * KB, `${r.bytes.length} bytes is under ${spec.minKb} KB`);
  ok(["fits", "padded"].includes(r.note), `note ${r.note}`);
});

await test("exam signature preset meets its KB range, padding if it must", async () => {
  const spec = EXAM_PRESETS.signature;
  // A dark scribble on white: very little to encode.
  const w = 900, h = 400, data = new Uint8Array(w * h * 3).fill(255);
  for (let x = 50; x < 850; x++) {
    const y = Math.round(200 + 120 * Math.sin(x / 40));
    for (let t = -4; t <= 4; t++) data.fill(20, ((y + t) * w + x) * 3, ((y + t) * w + x) * 3 + 3);
  }
  const r = await fitImage({ w, h, ch: 3, data }, { ...spec, fit: "pad", gray: true });
  const f = jpegFrame(r.bytes);
  eq(`${f.w}x${f.h}`, `${spec.w}x${spec.h}`, "output size");
  eq(f.n, 1, "components");
  ok(r.bytes.length <= spec.maxKb * KB && r.bytes.length >= spec.minKb * KB, `${r.bytes.length} bytes`);
  ok(["fits", "padded"].includes(r.note), `note ${r.note}`);
  // Still a JPEG the decoder reads.
  const px = await decodeJpeg(r.bytes);
  eq(`${px.w}x${px.h}`, `${spec.w}x${spec.h}`, "decoded size");
});

await test("an exam size that can't be met is reported, not faked", async () => {
  const r = await fitImage(await rgbPixels(800, 800), { w: 800, h: 800, minKb: 0, maxKb: 1, fit: "crop", gray: false });
  eq(r.note, "tooBig", "note");
  ok(r.bytes.length > KB, "fits after all");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
