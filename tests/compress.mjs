// Compress tests: builds PDFs with known images and checks what Compress does
// to each one: resolution-based downsampling (also through forms, rotations
// and inherited resources), MozJPEG at each level's quality, lossless
// palettes and Flate for graphics, greyscale detection, duplicate removal,
// untouched soft masks, CMYK, 16-bit and Indexed images, and decompression
// bombs that must not be inflated.
//
//   node tests/compress.mjs
import {
  PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, PDFRef, PDFHexString, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "pdf-lib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { load, openPdf, check, eq, nodeCanvas, root } from "./lib/load.mjs";

const { compress } = await load("optimize");
const { encodeJpeg, jpegComponents } = await load("jpeg");
const { unpredictPng } = await load("pixels");
const { renderPage } = await load("common");
const sharp = createRequire(join(root, "package.json"))("sharp");
nodeCanvas();
const results = { failed: 0 };
const test = check(results);
const ok = (cond, what) => { if (!cond) throw new Error(what); };

// ── Decompression bombs first, while this process's peak memory is still low.

// Deflated zeros, streamed so the test itself never holds them inflated.
const deflateZeros = (total) => new Promise((resolve, reject) => {
  const z = zlib.createDeflate({ level: 9 });
  const chunks = [];
  z.on("data", (c) => chunks.push(c));
  z.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  z.on("error", reject);
  const block = Buffer.alloc(16 << 20);
  let left = total;
  const pump = () => {
    while (left > 0) {
      const n = Math.min(left, block.length);
      left -= n;
      if (!z.write(n === block.length ? block : block.subarray(0, n))) return z.once("drain", pump);
    }
    z.end();
  };
  pump();
});
const GiB = await deflateZeros(1 << 30);

await test("streams nothing uses are dropped without inflating them", async () => {
  const d = await PDFDocument.create();
  d.addPage([200, 200]).drawText("ORPHAN", { x: 20, y: 100 });
  // One 1 GiB bomb, and 24 distinct 60 MB ones that each fit the per-stream limit.
  d.context.register(d.context.stream(GiB, { Filter: "FlateDecode" }));
  const z60 = zlib.deflateSync(Buffer.alloc(60 << 20), { level: 9 });
  for (let i = 0; i < 24; i++) d.context.register(d.context.stream(z60, { Filter: "FlateDecode", Index: i }));
  const bytes = await d.save({ useObjectStreams: false });
  const before = process.resourceUsage().maxRSS / 1024;
  const t0 = Date.now();
  const [res] = await compress(new File([bytes], "orphan.pdf"), { level: "recommended" });
  const ms = Date.now() - t0;
  const grew = process.resourceUsage().maxRSS / 1024 - before;
  console.log(`      ${ms} ms, peak memory +${grew.toFixed(0)} MB`);
  ok(grew < 300, `peak memory grew by ${grew.toFixed(0)} MB (limit 300)`);
  ok(ms < 2000, `took ${ms} ms (limit 2000)`);
  const after = await PDFDocument.load(await res.blob.arrayBuffer());
  ok(res.blob.size < bytes.length / 4, `output ${res.blob.size} bytes still carries the stream`);
  eq(after.getPageCount(), 1, "pages");
});

await test("streams that inflate far past any sane size are left as they are", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([200, 200]);
  // An image that claims 300x300 grey but inflates to 1 GiB, and a 1 GiB stream the catalog points at.
  const img = d.context.register(d.context.stream(GiB, { Type: "XObject", Subtype: "Image", Width: 300, Height: 300, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" }));
  page.node.setXObject(PDFName.of("Im1"), img);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, 0, 0), drawObject("Im1"), popGraphicsState());
  d.catalog.set(PDFName.of("Junk"), d.context.register(d.context.stream(GiB, { Filter: "FlateDecode" })));
  const bytes = await d.save({ useObjectStreams: false });
  const before = process.resourceUsage().maxRSS / 1024;
  const t0 = Date.now();
  await compress(new File([bytes], "bombs.pdf"), { level: "extreme" });
  const ms = Date.now() - t0;
  const grew = process.resourceUsage().maxRSS / 1024 - before;
  console.log(`      ${ms} ms, peak memory +${grew.toFixed(0)} MB`);
  ok(grew < 300, `peak memory grew by ${grew.toFixed(0)} MB (limit 300)`);
});

// ── Pictures

// Smooth colour fields with fine noise: compresses like a photo.
function photo(w, h, gray = false) {
  const data = new Uint8Array(w * h * 3);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = (rnd() - 0.5) * 18;
      const r = 128 + 90 * Math.sin(x / 97) * Math.cos(y / 61) + n;
      const g = gray ? r : 120 + 80 * Math.sin((x + y) / 140) + n;
      const b = gray ? r : 110 + 70 * Math.cos(x / 53 - y / 89) + n;
      data.set([r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * w + x) * 3);
    }
  return { w, h, ch: 3, data };
}

// Flat colours and hard edges, like a screenshot or chart: 5 colours.
function graphic(w, h) {
  const colors = [[255, 255, 255], [33, 33, 33], [30, 110, 220], [230, 80, 40], [240, 240, 240]];
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let c = y < 40 ? 4 : 0;
      if (y > 60 && (x % 120) < 80 && (y % 24) < 3) c = 1; // lines of "text"
      if (x > w * 0.6 && y > 120 && y < 120 + ((x * 7) % 200)) c = (x >> 4) % 2 ? 2 : 3; // bars
      data.set(colors[c], (y * w + x) * 3);
    }
  return { w, h, ch: 3, data };
}

const PHOTO = photo(2400, 1600);
const GRAPHIC = graphic(800, 500);
const GRAY = photo(1000, 1000, true);

async function build() {
  const doc = await PDFDocument.create();
  const photoJpg = await encodeJpeg(PHOTO, 92);
  const grayJpg = await encodeJpeg(GRAY, 92); // grey content stored as an RGB JPEG
  // 1. Photo drawn 4×2.67 in: 600 dpi, far more than the screen needs.
  const p1 = doc.addPage([595, 842]);
  p1.drawImage(await doc.embedJpg(photoJpg), { x: 50, y: 500, width: 288, height: 192 });
  // 2. The same photo embedded again as its own object (merged files do this).
  const p2 = doc.addPage([595, 842]);
  p2.drawImage(await doc.embedJpg(photoJpg), { x: 50, y: 500, width: 288, height: 192 });
  // 3. A graphic stored losslessly, drawn at 144 dpi.
  const p3 = doc.addPage([595, 842]);
  const raw = doc.context.flateStream(GRAPHIC.data, { Type: "XObject", Subtype: "Image", Width: GRAPHIC.w, Height: GRAPHIC.h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
  const gref = doc.context.register(raw);
  p3.node.setXObject(PDFName.of("G1"), gref);
  p3.pushOperators(pushGraphicsState(), concatTransformationMatrix(400, 0, 0, 250, 50, 500), drawObject("G1"), popGraphicsState());
  // 4. Grey picture in an RGB JPEG, drawn at 300 dpi.
  const p4 = doc.addPage([595, 842]);
  p4.drawImage(await doc.embedJpg(grayJpg), { x: 50, y: 400, width: 240, height: 240 });
  return { bytes: await doc.save(), gref: gref.toString() };
}

const { bytes } = await build();
if (process.env.SAVE) writeFileSync(join(process.env.SAVE, "images.pdf"), bytes);
const [out] = await compress(new File([bytes], "images.pdf"), { level: "recommended" });
const packed = new Uint8Array(await out.blob.arrayBuffer());
if (process.env.SAVE) writeFileSync(join(process.env.SAVE, "images-compressed.pdf"), packed);
const doc = await PDFDocument.load(packed);
console.log(`      ${(bytes.length / 1024).toFixed(0)} KB → ${(packed.length / 1024).toFixed(0)} KB (${out.note})`);

// The image each page draws.
const imageOf = (pageIndex) => {
  const res = doc.getPages()[pageIndex].node.Resources();
  const xo = res.lookup(PDFName.of("XObject"), PDFDict);
  const [, ref] = [...xo.entries()][0];
  return { ref: ref.toString(), stream: doc.context.lookup(ref) };
};
const n = (d, k) => d.lookup(PDFName.of(k)).asNumber();
const filter = (d) => String(d.lookup(PDFName.of("Filter")));

await test("photo downsampled to 150 dpi and re-encoded", () => {
  const { stream } = imageOf(0);
  eq(`${n(stream.dict, "Width")}x${n(stream.dict, "Height")}`, "600x400", "size");
  eq(filter(stream.dict), "/DCTDecode", "filter");
});

await test("duplicate photo stored once", () => {
  eq(imageOf(0).ref, imageOf(1).ref, "same object");
});

await test("graphic kept lossless as a palette", () => {
  const { stream } = imageOf(2);
  const d = stream.dict;
  eq(filter(d), "/FlateDecode", "filter");
  const cs = d.lookup(PDFName.of("ColorSpace"), PDFArray);
  eq(String(cs.get(0)), "/Indexed", "colour space");
  eq(n(d, "BitsPerComponent"), 4, "bits");
  eq(n(d.lookup(PDFName.of("DecodeParms"), PDFDict), "Predictor"), 15, "PNG predictor kept");
  // Unpack and compare every pixel with the original.
  const bits = 4;
  const rowBytes = Math.ceil((GRAPHIC.w * bits) / 8);
  const idx = unpredictPng(decodePDFRawStream(stream).decode(), rowBytes, 1, GRAPHIC.h);
  const lookup = cs.lookup(3).asBytes();
  let diff = 0;
  for (let y = 0; y < GRAPHIC.h; y++)
    for (let x = 0; x < GRAPHIC.w; x++) {
      const k = (idx[y * rowBytes + (x >> 1)] >> (x % 2 ? 0 : 4)) & 15;
      for (let c = 0; c < 3; c++) if (lookup[k * 3 + c] !== GRAPHIC.data[(y * GRAPHIC.w + x) * 3 + c]) diff++;
    }
  eq(diff, 0, "pixels that changed");
});

await test("grey picture stored as a one-channel JPEG", () => {
  const { stream } = imageOf(3);
  eq(String(stream.dict.lookup(PDFName.of("ColorSpace"))), "/DeviceGray", "colour space");
  eq(jpegComponents(stream.contents), 1, "JPEG components");
  eq(n(stream.dict, "Width"), 500, "downsampled from 1000 px at 300 dpi to 150 dpi");
});

await test("pdf.js opens every page of the result", async () => {
  const pdf = await openPdf(packed.slice());
  for (let i = 1; i <= pdf.numPages; i++) await (await pdf.getPage(i)).getOperatorList();
});

// ── Transparency and levels

await test("soft masks stay exact DeviceGray samples", async () => {
  const d = await PDFDocument.create();
  const w = 600, h = 400;
  const rgb = d.context.flateStream(photo(w, h).data, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
  const alpha = new Uint8Array(w * h).map((_, i) => ((i % w) < w / 2 ? 255 : 0));
  const mask = d.context.register(d.context.flateStream(alpha, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  rgb.dict.set(PDFName.of("SMask"), mask);
  const ref = d.context.register(rgb);
  const page = d.addPage([595, 842]);
  page.node.setXObject(PDFName.of("I1"), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(288, 0, 0, 192, 50, 500), drawObject("I1"), popGraphicsState());
  const [res] = await compress(new File([await d.save()], "a.pdf"), { level: "extreme" });
  const after = await PDFDocument.load(await res.blob.arrayBuffer());
  const imgs = after.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const main = imgs.find(([, o]) => o.dict.get(PDFName.of("SMask")));
  eq(Boolean(main), true, "image still has its mask");
  eq(main[1].dict.get(PDFName.of("SMask")) instanceof PDFRef, true, "mask is a reference");
  eq(n(main[1].dict, "Width") < w, true, "the image itself was downsampled");
  const m = after.context.lookup(main[1].dict.get(PDFName.of("SMask")));
  eq(String(m.dict.lookup(PDFName.of("ColorSpace"))), "/DeviceGray", "mask colour space");
  eq(n(m.dict, "BitsPerComponent"), 8, "mask bits");
  const samples = decodePDFRawStream(m).decode();
  eq(samples.length, alpha.length, "mask sample count");
  eq(samples.every((v, i) => v === alpha[i]), true, "mask samples unchanged");
});

await test("each level meets its size budget on images.pdf", async () => {
  const sizes = {};
  for (const level of ["extreme", "recommended", "light"]) {
    const [r] = await compress(new File([bytes], "images.pdf"), { level });
    sizes[level] = r.blob.size;
  }
  console.log("      sizes:", Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)} KB`).join(", "));
  eq(sizes.extreme < sizes.recommended && sizes.recommended < sizes.light, true, "ordering");
  ok(sizes.extreme <= 12 * 1024, `extreme ${sizes.extreme} > 12 KB`);
  ok(sizes.recommended <= 30 * 1024, `recommended ${sizes.recommended} > 30 KB`);
  ok(sizes.light <= 90 * 1024, `light ${sizes.light} > 90 KB`);
});

// ── Where images are drawn: forms, rotations, inherited resources.
// A 2400x1600 photo drawn 4x2.67 in comes out 600x400 at 150 dpi; an image
// whose placement is missed falls back to the 1700 px cap instead.

const SMALL_PHOTO = await encodeJpeg(PHOTO, 92);
async function placed(draw) {
  const d = await PDFDocument.create();
  const page = d.addPage([595, 842]);
  const img = (await d.embedJpg(SMALL_PHOTO)).ref;
  await draw(d, page, img);
  const [res] = await compress(new File([await d.save()], "p.pdf"), { level: "recommended" });
  const after = await PDFDocument.load(await res.blob.arrayBuffer());
  const imgs = after.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(imgs.length, 1, "images");
  return `${n(imgs[0][1].dict, "Width")}x${n(imgs[0][1].dict, "Height")}`;
}

await test("an image inside a form XObject is sized by where the form draws it", async () => {
  eq(await placed((d, page, img) => {
    const form = d.context.register(d.context.stream("q 288 0 0 192 0 0 cm /Im1 Do Q", {
      Type: "XObject", Subtype: "Form", BBox: [0, 0, 288, 192], Resources: { XObject: { Im1: img } },
    }));
    page.node.setXObject(PDFName.of("Fm1"), form);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 50, 500), drawObject("Fm1"), popGraphicsState());
  }), "600x400", "size");
});

await test("a rotated placement counts the drawn size, not the matrix diagonal", async () => {
  eq(await placed((d, page, img) => {
    page.node.setXObject(PDFName.of("Im1"), img);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(0, 288, -192, 0, 300, 400), drawObject("Im1"), popGraphicsState());
  }), "600x400", "size");
});

await test("resources inherited from the page tree are followed", async () => {
  eq(await placed((d, page, img) => {
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(288, 0, 0, 192, 50, 500), drawObject("Im1"), popGraphicsState());
    page.node.delete(PDFName.of("Resources"));
    d.catalog.Pages().set(PDFName.of("Resources"), d.context.obj({ XObject: { Im1: img } }));
  }), "600x400", "size");
});

// ── Lossless choice for graphics with too many colours for a palette.

await test("an unfiltered 400-colour screenshot stays lossless Flate", async () => {
  const w = 600, h = 400;
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = Math.floor(y / 20) * 20 + Math.floor(x / 30); // 20x20 blocks of flat colour
      const edge = x % 30 === 0 || y % 20 === 0;
      data.set(edge ? [20, 20, 20] : [(k * 37) & 255, (k * 91) & 255, 40 + (k % 7) * 30], (y * w + x) * 3);
    }
  const d = await PDFDocument.create();
  const ref = d.context.register(d.context.stream(data, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
  const page = d.addPage([w, h]);
  page.node.setXObject(PDFName.of("Im1"), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject("Im1"), popGraphicsState());
  const [res] = await compress(new File([await d.save()], "shot.pdf"), { level: "recommended" });
  const after = await PDFDocument.load(await res.blob.arrayBuffer());
  const [[, img]] = after.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  eq(filter(img.dict), "/FlateDecode", "filter");
  const parms = img.dict.lookup(PDFName.of("DecodeParms"), PDFDict);
  const px = unpredictPng(decodePDFRawStream(img).decode(), w * 3, 3, h);
  eq(n(parms, "Predictor"), 15, "predictor");
  eq(px.every((v, i) => v === data[i]), true, "pixels unchanged");
});

// ── Colour spaces and bit depths that used to be skipped.

const W = 1200, H = 900;
const RGB = photo(W, H).data;
const pdfPage = async (bytes) => (await openPdf(new Uint8Array(bytes))).getPage(1);
// Mean difference per channel between two renderings of page 1, at 36 dpi.
async function looksAlike(a, b) {
  const [ca, cb] = [await renderPage(await pdfPage(a), 0.5), await renderPage(await pdfPage(b), 0.5)];
  const da = ca.getContext("2d").getImageData(0, 0, ca.width, ca.height).data;
  const db = cb.getContext("2d").getImageData(0, 0, cb.width, cb.height).data;
  let sum = 0;
  for (let i = 0; i < da.length; i++) if (i % 4 !== 3) sum += Math.abs(da[i] - db[i]);
  return sum / (da.length * 0.75);
}
async function onePage(dict, data) {
  const d = await PDFDocument.create();
  const ref = d.context.register(d.context.stream(data, { Type: "XObject", Subtype: "Image", Width: W, Height: H, ...(typeof dict === "function" ? dict(d.context) : dict) }));
  const page = d.addPage([612, 792]);
  page.node.setXObject(PDFName.of("Im1"), ref);
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(540, 0, 0, 405, 36, 300), drawObject("Im1"), popGraphicsState());
  return d.save();
}
async function squeeze(bytes, level) {
  const [res] = await compress(new File([bytes], "in.pdf"), { level });
  const out = new Uint8Array(await res.blob.arrayBuffer());
  const after = await PDFDocument.load(out);
  const [[, img]] = after.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  return { out, img, ratio: out.length / bytes.length, diff: await looksAlike(bytes, out) };
}
const cs = (img) => { const c = img.dict.lookup(PDFName.of("ColorSpace")); return c instanceof PDFArray ? String(c.get(0)) : String(c); };

const CMYK = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) CMYK.set([255 - RGB[i * 3], 255 - RGB[i * 3 + 1], 255 - RGB[i * 3 + 2], 20], i * 4);
const cmykFlate = await onePage({ ColorSpace: "DeviceCMYK", BitsPerComponent: 8, Filter: "FlateDecode" }, zlib.deflateSync(CMYK));

await test("CMYK Flate image: downsampled and turned sRGB at extreme", async () => {
  const r = await squeeze(cmykFlate, "extreme");
  console.log(`      ratio ${r.ratio.toFixed(3)}, mean difference ${r.diff.toFixed(2)}`);
  ok(r.ratio < 0.1, `ratio ${r.ratio.toFixed(3)} (limit 0.1)`);
  eq(cs(r.img), "/DeviceRGB", "colour space");
  eq(n(r.img.dict, "Width"), 540, "width at 72 dpi");
  ok(r.diff < 6, `looks different: ${r.diff.toFixed(2)}`);
});

await test("CMYK Flate image: kept CMYK at light", async () => {
  const r = await squeeze(cmykFlate, "light");
  console.log(`      ratio ${r.ratio.toFixed(3)}, mean difference ${r.diff.toFixed(2)}`);
  eq(cs(r.img), "/DeviceCMYK", "colour space");
  ok(r.ratio < 0.9, `ratio ${r.ratio.toFixed(3)} (limit 0.9)`);
  ok(r.diff < 3, `looks different: ${r.diff.toFixed(2)}`);
});

await test("CMYK JPEG with an inverted (Adobe) /Decode keeps its colours", async () => {
  const jpg = await sharp(Buffer.from(RGB), { raw: { width: W, height: H, channels: 3 } }).toColourspace("cmyk").jpeg({ quality: 90 }).toBuffer();
  eq(jpegComponents(jpg), 4, "fixture is a CMYK JPEG");
  const bytes = await onePage({ ColorSpace: "DeviceCMYK", BitsPerComponent: 8, Filter: "DCTDecode", Decode: [1, 0, 1, 0, 1, 0, 1, 0] }, jpg);
  const r = await squeeze(bytes, "extreme");
  console.log(`      ratio ${r.ratio.toFixed(3)}, mean difference ${r.diff.toFixed(2)}`);
  ok(r.ratio < 0.5, `ratio ${r.ratio.toFixed(3)} (limit 0.5)`);
  eq(n(r.img.dict, "Width"), 540, "width at 72 dpi");
  eq(r.img.dict.get(PDFName.of("Decode")), undefined, "Decode dropped with the inversion applied");
  ok(r.diff < 6, `looks different: ${r.diff.toFixed(2)}`);
});

await test("16-bit RGB image: down to 8 bits and downsampled", async () => {
  const d16 = Buffer.alloc(W * H * 6);
  for (let i = 0; i < W * H * 3; i++) d16.writeUInt16BE(RGB[i] * 256 + ((i * 7919) & 255), i * 2); // a low byte unlike the high one
  const bytes = await onePage({ ColorSpace: "DeviceRGB", BitsPerComponent: 16, Filter: "FlateDecode" }, zlib.deflateSync(d16));
  const r = await squeeze(bytes, "extreme");
  console.log(`      ratio ${r.ratio.toFixed(3)}, mean difference ${r.diff.toFixed(2)}`);
  ok(r.ratio < 0.1, `ratio ${r.ratio.toFixed(3)} (limit 0.1)`);
  eq(n(r.img.dict, "BitsPerComponent"), 8, "bits");
  ok(r.diff < 6, `looks different: ${r.diff.toFixed(2)}`);
});

await test("Indexed 4-bit image: palette expanded, then downsampled", async () => {
  const pal = [];
  for (let k = 0; k < 16; k++) pal.push(k * 17, 255 - k * 12, 60 + k * 8);
  const rowBytes = W / 2;
  const idx = new Uint8Array(rowBytes * H);
  // A dithered photo: 16 levels of its red channel with noise, so Flate can't shrink it much.
  let seed = 3;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = Math.min(15, Math.max(0, Math.floor(RGB[(y * W + x) * 3] / 16 + ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5)));
      idx[y * rowBytes + (x >> 1)] |= v << (x % 2 ? 0 : 4);
    }
  const bytes = await onePage((ctx) => ({ ColorSpace: ctx.obj([PDFName.of("Indexed"), PDFName.of("DeviceRGB"), 15, PDFHexString.of(Buffer.from(pal).toString("hex"))]), BitsPerComponent: 4, Filter: "FlateDecode" }), zlib.deflateSync(idx));
  const r = await squeeze(bytes, "extreme");
  console.log(`      ratio ${r.ratio.toFixed(3)}, mean difference ${r.diff.toFixed(2)}`);
  ok(r.ratio < 0.2, `ratio ${r.ratio.toFixed(3)} (limit 0.2)`);
  eq(n(r.img.dict, "Width"), 540, "width at 72 dpi");
  ok(r.diff < 6, `looks different: ${r.diff.toFixed(2)}`);
});

process.exit(results.failed ? 1 : 0);
