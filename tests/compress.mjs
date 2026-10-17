// Compress tests: builds PDFs with known images and checks what Compress does
// to each one: resolution-based downsampling, MozJPEG, lossless palettes for
// graphics, greyscale detection, duplicate removal and kept transparency.
//
//   node tests/compress.mjs
import {
  PDFDocument, PDFName, PDFRawStream, PDFArray, PDFDict, PDFRef, decodePDFRawStream,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject,
} from "pdf-lib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, openPdf, check, eq } from "./lib/load.mjs";

const { compress } = await load("optimize");
const { encodeJpeg, jpegComponents } = await load("jpeg");
const { unpredictPng } = await load("pixels");
const results = { failed: 0 };
const test = check(results);

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

await test("images with transparency keep their soft mask", async () => {
  const d = await PDFDocument.create();
  const w = 600, h = 400;
  const rgb = d.context.flateStream(photo(w, h).data, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
  const alpha = new Uint8Array(w * h).map((_, i) => ((i % w) < w / 2 ? 255 : 0));
  const mask = d.context.register(d.context.flateStream(alpha, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceGray", BitsPerComponent: 8 }));
  rgb.dict.set(PDFName.of("SMask"), mask);
  const ref = d.context.register(rgb);
  const page = d.addPage([595, 842]);
  page.node.setXObject(PDFName.of("I1"), ref);
  const [res] = await compress(new File([await d.save()], "a.pdf"), { level: "extreme" });
  const after = await PDFDocument.load(await res.blob.arrayBuffer());
  const imgs = after.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"));
  const main = imgs.find(([, o]) => o.dict.get(PDFName.of("SMask")));
  eq(Boolean(main), true, "image still has its mask");
  eq(main[1].dict.get(PDFName.of("SMask")) instanceof PDFRef, true, "mask is a reference");
});

await test("extreme is smaller than recommended, light is larger", async () => {
  const sizes = {};
  for (const level of ["extreme", "recommended", "light"]) {
    const [r] = await compress(new File([bytes], "images.pdf"), { level });
    sizes[level] = r.blob.size;
  }
  console.log("      sizes:", Object.entries(sizes).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)} KB`).join(", "));
  eq(sizes.extreme < sizes.recommended && sizes.recommended < sizes.light, true, "ordering");
});

process.exit(results.failed ? 1 : 0);
