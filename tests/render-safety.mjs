// Render safety and image export (P1-09): pages and pictures too big for a
// canvas are drawn at a lower resolution instead of failing the job, one bad
// page or file doesn't lose the others, and PDF to JPG's options (range,
// format, custom dpi, transparency) and image extraction (ICC, Indexed,
// predictors, soft masks) give what they say.
//
//   node tests/render-safety.mjs
import { PDFDocument, StandardFonts, PDFName, PDFRawStream, PDFHexString, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from "pdf-lib";
import { createRequire } from "node:module";
import { join } from "node:path";
import zlib from "node:zlib";
import { load, check, eq, nodeCanvas, root } from "./lib/load.mjs";

const { pdfToImages, extractImages } = await load("convert");
const { renderPage, openPdf } = await load("common");
const { runTool } = await load("run");
const napi = createRequire(join(root, "package.json"))("@napi-rs/canvas");
nodeCanvas();
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const results = { failed: 0 };
const test = check(results);
const ok = (cond, what) => { if (!cond) throw new Error(what); };
const peakMb = () => process.resourceUsage().maxRSS / 1024;
const size = async (blob) => {
  const img = await napi.loadImage(Buffer.from(await blob.arrayBuffer()));
  return { w: img.width, h: img.height, img };
};
// Browsers outside iOS: 64 Mpx a page, 16,384 px a side.
const MAX_PX = 64e6, MAX_SIDE = 16384;

// Deflated zeros, streamed so the test never holds them inflated.
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

// One page drawing one image over most of it.
async function imagePage(dict, data, { page = [612, 792] } = {}) {
  const d = await PDFDocument.create();
  const p = d.addPage(page);
  const img = d.context.register(PDFRawStream.of(d.context.obj({ Type: "XObject", Subtype: "Image", ...dict }), data));
  p.node.setXObject(PDFName.of("Im1"), img);
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(page[0] - 72, 0, 0, page[1] - 72, 36, 36), drawObject("Im1"), popGraphicsState());
  p.drawText("IMAGEPAGE", { x: 40, y: 20, size: 10, font: await d.embedFont(StandardFonts.Helvetica) });
  return d.save({ useObjectStreams: false });
}

// ── Oversized pages and pictures, first, while peak memory is still low.

await test("a 200 x 200 inch page renders at a clamped size", async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([14400, 14400]).drawText("HUGEPAGE", { x: 400, y: 13000, size: 400, font });
  const doc = await openPdf(await d.save());
  const page = await doc.getPage(1);
  const canvas = await renderPage(page, 150 / 72);
  ok(canvas.width <= MAX_SIDE && canvas.height <= MAX_SIDE, `canvas ${canvas.width} x ${canvas.height}`);
  ok(canvas.width * canvas.height <= MAX_PX, `canvas ${canvas.width * canvas.height} px`);
  ok(canvas.width > 7500, `canvas shrank further than it had to (${canvas.width} px)`);
  canvas.width = canvas.height = 0;
  await doc.loadingTask.destroy();
});

await test("PDF to JPG on a 200 x 200 inch page gives one JPEG and a lower-dpi note", async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([14400, 14400]).drawText("HUGEPAGE", { x: 400, y: 13000, size: 400, font });
  const before = peakMb();
  const out = await pdfToImages(new File([await d.save()], "huge.pdf"), { dpi: "150", format: "jpg" });
  eq(out.length, 1, "images");
  const { w, h } = await size(out[0].blob);
  ok(w <= MAX_SIDE && w * h <= MAX_PX, `JPEG ${w} x ${h}`);
  const m = /^lowerDpi:(\d+)$/.exec(out[0].note ?? "");
  ok(m, `note ${JSON.stringify(out[0].note)}`);
  ok(Number(m[1]) < 150 && Math.abs(Number(m[1]) - (w / 200) * 1) < 2, `note says ${m[1]} dpi for ${w} px over 200 in`);
  console.log(`      ${w} x ${h} px at ${m[1]} dpi, peak +${(peakMb() - before).toFixed(0)} MB`);
});

await test("a page drawn 50,000 px wide is clamped to the canvas limit", async () => {
  const d = await PDFDocument.create();
  d.addPage([612, 792]).drawText("WIDE", { x: 40, y: 700, size: 40 });
  const doc = await openPdf(await d.save());
  const page = await doc.getPage(1);
  const canvas = await renderPage(page, 50000 / 612);
  ok(canvas.width <= MAX_SIDE && canvas.height <= MAX_SIDE && canvas.width * canvas.height <= MAX_PX, `canvas ${canvas.width} x ${canvas.height}`);
  canvas.width = canvas.height = 0;
  await doc.loadingTask.destroy();
});

await test("a 50,000 x 50,000 px picture renders without a crash or gigabytes of memory", async () => {
  const z = await deflateZeros(50000 * 50000);
  const bytes = await imagePage({ Width: 50000, Height: 50000, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" }, z);
  const before = peakMb();
  const out = await pdfToImages(new File([bytes], "bomb.pdf"), { dpi: "72", format: "jpg" });
  eq(out.length, 1, "images");
  const { w, h } = await size(out[0].blob);
  eq(`${w}x${h}`, "612x792", "image size");
  const grew = peakMb() - before;
  console.log(`      peak +${grew.toFixed(0)} MB`);
  ok(grew < 1500, `peak memory grew by ${grew.toFixed(0)} MB (limit 1500)`);
});

await test("a 50,000 px wide strip picture is drawn, not dropped", async () => {
  const W = 50000, H = 600;
  const px = Buffer.alloc(W * H, 255);
  for (let y = 0; y < H; y++) px.fill(0, y * W, y * W + W / 2); // left half black
  const bytes = await imagePage({ Width: W, Height: H, ColorSpace: "DeviceGray", BitsPerComponent: 8, Filter: "FlateDecode" }, zlib.deflateSync(px), { page: [1000, 200] });
  const out = await pdfToImages(new File([bytes], "strip.pdf"), { dpi: "72", format: "png" });
  const { w, h, img } = await size(out[0].blob);
  eq(`${w}x${h}`, "1000x200", "image size");
  const c = napi.createCanvas(w, h);
  c.getContext("2d").drawImage(img, 0, 0);
  const at = (x, y) => c.getContext("2d").getImageData(x, y, 1, 1).data[0];
  ok(at(200, 100) < 40 && at(800, 100) > 215, `strip drawn as ${at(200, 100)} / ${at(800, 100)}`);
});

// ── Options

const threePages = async () => {
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  for (const [i, s] of [[1, [612, 792]], [2, [595, 842]], [3, [400, 300]]]) d.addPage(s).drawText(`PAGE${i}`, { x: 30, y: 30, size: 24, font });
  return new File([await d.save()], "three.pdf");
};

await test("range 2-3 at a custom 200 dpi as PNG gives two files of points x 200/72", async () => {
  const out = await pdfToImages(await threePages(), { dpi: "custom", customDpi: "200", format: "png", pageRange: "2-3" });
  eq(out.map((o) => o.name).join(","), "three-2.png,three-3.png", "names");
  for (const [o, pts] of [[out[0], [595, 842]], [out[1], [400, 300]]]) {
    const { w, h } = await size(o.blob);
    ok(Math.abs(w - (pts[0] * 200) / 72) <= 1 && Math.abs(h - (pts[1] * 200) / 72) <= 1, `${o.name}: ${w} x ${h}`);
    eq(o.blob.type, "image/png", "type");
  }
});

await test("custom dpi is held to 72-600", async () => {
  const [lo] = await pdfToImages(await threePages(), { dpi: "custom", customDpi: "10", format: "jpg", pageRange: "3" });
  const [hi] = await pdfToImages(await threePages(), { dpi: "custom", customDpi: "5000", format: "jpg", pageRange: "3" });
  eq((await size(lo.blob)).w, 400, "72 dpi width");
  eq((await size(hi.blob)).w, Math.round((400 * 600) / 72), "600 dpi width");
});

await test("transparent PNG leaves the page's background clear", async () => {
  const [o] = await pdfToImages(await threePages(), { dpi: "72", format: "png", transparent: true, pageRange: "3" });
  const { img } = await size(o.blob);
  const c = napi.createCanvas(img.width, img.height);
  c.getContext("2d").drawImage(img, 0, 0);
  eq(c.getContext("2d").getImageData(300, 50, 1, 1).data[3], 0, "alpha off the text");
  const [solid] = await pdfToImages(await threePages(), { dpi: "72", format: "png", pageRange: "3" });
  const s = await size(solid.blob);
  const c2 = napi.createCanvas(s.w, s.h);
  c2.getContext("2d").drawImage(s.img, 0, 0);
  eq(c2.getContext("2d").getImageData(300, 50, 1, 1).data[3], 255, "alpha without the option");
});

await test("a page that fails to export is skipped and named; the others are kept", async () => {
  const make = document.createElement;
  let n = 0;
  document.createElement = (...a) => {
    const c = make(...a);
    // The second page's export fails, as toBlob does over the browser's limit.
    if (++n === 2) c.toBlob = (cb) => cb(null);
    return c;
  };
  try {
    const out = await pdfToImages(await threePages(), { dpi: "72", format: "jpg" });
    eq(out.map((o) => o.name).join(","), "three-1.jpg,three-3.jpg", "names");
    eq(JSON.stringify(out.flatMap((o) => o.skipped ?? [])), JSON.stringify([{ file: "three.pdf", page: 2, code: "page_too_large" }]), "skipped");
  } finally {
    document.createElement = make;
  }
});

await test("one bad file in a batch doesn't lose the others", async () => {
  const good = await threePages();
  const out = await runTool("pdfToJpg", [new File(["not a pdf"], "junk.pdf"), good], { jpgMode: "pages", dpi: "72", format: "jpg", pageRange: "1" });
  eq(out.map((o) => o.name).join(","), "three-1.jpg", "names");
  eq(JSON.stringify(out[0].skipped), JSON.stringify([{ file: "junk.pdf", code: "not_pdf" }]), "skipped");
  let threw = null;
  await runTool("pdfToJpg", [new File(["not a pdf"], "junk.pdf")], { jpgMode: "pages", dpi: "72", format: "jpg" }).catch((e) => (threw = e));
  eq(threw?.code, "not_pdf", "a lone bad file still fails");
});

// ── Images inside the PDF

await test("extract gives ICC, Indexed and RGBA images, once each, alpha kept", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 200]);
  const ctx = d.context;
  const W = 80, H = 80;
  const icc = ctx.register(PDFRawStream.of(ctx.obj({ N: 3 }), new Uint8Array(zlib.deflateSync(Buffer.alloc(128)))));
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) rgb.set([i % W * 3, 100, 200], i * 3);
  // ICC-based RGB, PNG-predicted (Up) Flate.
  const rows = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    rows[y * (W * 3 + 1)] = 2;
    for (let x = 0; x < W * 3; x++) rows[y * (W * 3 + 1) + 1 + x] = (rgb[y * W * 3 + x] - (y ? rgb[(y - 1) * W * 3 + x] : 0)) & 255;
  }
  const im1 = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: W, Height: H, BitsPerComponent: 8, ColorSpace: ctx.obj([PDFName.of("ICCBased"), icc]), Filter: "FlateDecode", DecodeParms: { Predictor: 12, Colors: 3, Columns: W } }), new Uint8Array(zlib.deflateSync(rows))));
  // Indexed, 2 bits a pixel over RGB.
  const idx = Buffer.alloc((W / 4) * H);
  for (let i = 0; i < idx.length; i++) idx[i] = 0b00011011;
  const im2 = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: W, Height: H, BitsPerComponent: 2, ColorSpace: ctx.obj([PDFName.of("Indexed"), PDFName.of("DeviceRGB"), 3, PDFHexString.of("ff0000" + "00ff00" + "0000ff" + "ffffff")]), Filter: "FlateDecode" }), new Uint8Array(zlib.deflateSync(idx))));
  // RGB with a soft mask: left half opaque, right half clear.
  const alpha = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) alpha.fill(255, y * W, y * W + W / 2);
  const mask = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: W, Height: H, BitsPerComponent: 8, ColorSpace: "DeviceGray", Filter: "FlateDecode" }), new Uint8Array(zlib.deflateSync(alpha))));
  const im3 = ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: W, Height: H, BitsPerComponent: 8, ColorSpace: "DeviceRGB", Filter: "FlateDecode", SMask: mask }), new Uint8Array(zlib.deflateSync(rgb))));
  // The ICC image again, as a separate object with the same bytes.
  const dup = ctx.register(PDFRawStream.of(ctx.lookup(im1).dict.clone(ctx), ctx.lookup(im1).contents));
  [im1, im2, im3, dup].forEach((ref, i) => {
    page.node.setXObject(PDFName.of(`Im${i}`), ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(100, 0, 0, 100, 20 + i * 140, 50), drawObject(`Im${i}`), popGraphicsState());
  });
  const out = await extractImages(new File([await d.save({ useObjectStreams: false })], "mix.pdf"));
  eq(out.length, 3, `images (${out.map((o) => o.name).join(", ")})`);
  const pix = [];
  for (const o of out) {
    eq(o.blob.type, "image/png", `${o.name} type`);
    const { img } = await size(o.blob);
    const c = napi.createCanvas(img.width, img.height);
    c.getContext("2d").drawImage(img, 0, 0);
    pix.push((x, y) => [...c.getContext("2d").getImageData(x, y, 1, 1).data]);
  }
  eq(pix[0](10, 10).join(), "30,100,200,255", "ICC image pixel");
  eq(pix[1](0, 0).join(), "255,0,0,255", "Indexed first pixel");
  eq(pix[1](3, 0).join(), "255,255,255,255", "Indexed fourth pixel");
  eq(pix[2](10, 10)[3], 255, "RGBA opaque half");
  eq(pix[2](70, 10)[3], 0, "RGBA clear half");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
