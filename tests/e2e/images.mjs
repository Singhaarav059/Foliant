// JPG to PDF with every image format it accepts: HEIC (libheif where the
// browser can't decode it), WebP, TIFF (one page per TIFF page), AVIF, EXIF
// orientation, and the page size and margin options.
//
//   node tests/e2e/images.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
//
// Fixtures: tests/fixtures/photo.heic (96 × 64) and tests/fixtures/images/,
// written by tests/make-image-fixtures.mjs.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { createCanvas } from "@napi-rs/canvas";
import { dict, open, pick, root, suite } from "./kit.mjs";

const t = dict("en");
const downloads = mkdtempSync(join(tmpdir(), "e2e-images-"));
const MM = 72 / 25.4;
const QUADRANTS = { tl: [220, 30, 30], tr: [30, 160, 60], bl: [40, 70, 220], br: [240, 200, 20] };

// Picks the files, sets the options and returns the PDF that comes out.
async function convert(page, browser, files, { pageSize = "fit", margin, width, height } = {}) {
  await open(page, "/en/jpg-to-pdf");
  await pick(page, files);
  const size = page.getByLabel(t["opt.pageSize"], { exact: true });
  if (await size.count()) await size.selectOption(pageSize);
  else await page.getByRole("radio", { name: t[`choice.pageSize.${pageSize}`] }).click();
  if (width !== undefined) await page.getByLabel(t["opt.pageWidth"], { exact: true }).fill(String(width));
  if (height !== undefined) await page.getByLabel(t["opt.pageHeight"], { exact: true }).fill(String(height));
  if (margin !== undefined) await page.getByRole("slider", { name: t["opt.margin"] }).fill(String(margin));
  const failed = page.getByRole("alert").filter({ hasText: /\S/ });
  const [dl] = await Promise.race([
    Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: t["tool.jpgToPdf.action"], exact: true }).click()]),
    failed.first().waitFor({ timeout: 60000 }).then(async () => { throw new Error(`alert: ${(await failed.first().innerText()).replace(/\s+/g, " ")}`); }),
  ]);
  const path = join(downloads, `${browser}-${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(path);
  return readFileSync(path);
}

const sizes = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getSize());

// Renders each page with pdf.js and reads the colour at fractions of the page.
async function sample(bytes, points) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const viewport = p.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await p.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
    const ctx = canvas.getContext("2d");
    out.push(points.map(([x, y]) => [...ctx.getImageData(Math.floor(x(viewport.width)), Math.floor(y(viewport.height)), 1, 1).data.slice(0, 3)]));
  }
  await doc.loadingTask.destroy();
  return out;
}
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 40);
const at = (f) => () => (n) => n * f;
const QUAD_POINTS = [[at(0.25)(), at(0.25)()], [at(0.75)(), at(0.25)()], [at(0.25)(), at(0.75)()], [at(0.75)(), at(0.75)()]];
const upright = (colours, label) => {
  const want = [QUADRANTS.tl, QUADRANTS.tr, QUADRANTS.bl, QUADRANTS.br];
  colours.forEach((c, i) => {
    if (!near(c, want[i])) throw new Error(`${label}: quadrant ${i} is ${c}, want ${want[i]}`);
  });
};
const ratio = (s) => s.width / s.height;
const sameRatio = (s, w, h, label) => {
  const off = Math.abs(ratio(s) / (w / h) - 1);
  if (off > 0.01) throw new Error(`${label}: page ${s.width.toFixed(1)} × ${s.height.toFixed(1)} is ${(off * 100).toFixed(1)}% off ${w}:${h}`);
};

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();

  await test("HEIC + WebP + TIFF → 3 pages, each the image's shape", async () => {
    const pdf = await convert(page, name, ["photo.heic", "images/photo.webp", "images/scan.tiff"]);
    const s = await sizes(pdf);
    if (s.length !== 3) throw new Error(`${s.length} pages`);
    sameRatio(s[0], 96, 64, "HEIC");
    sameRatio(s[1], 120, 200, "WebP");
    sameRatio(s[2], 160, 90, "TIFF");
    // Its own resolution, 300 DPI, rather than the 96 DPI other images get.
    if (Math.abs(s[2].width - (160 / 300) * 72) > 0.5) throw new Error(`TIFF page is ${s[2].width} pt wide, not at 300 DPI`);
    const [heic, webp, tiff] = await sample(pdf, QUAD_POINTS);
    // photo.heic isn't the quadrants; it only has to show something.
    if (heic.every((c) => near(c, [255, 255, 255]))) throw new Error("HEIC page is blank");
    upright(webp, "WebP");
    upright(tiff, "TIFF");
    return s.map((x) => `${x.width.toFixed(0)}×${x.height.toFixed(0)}`).join(", ");
  });

  await test("a two-page TIFF gives two pages", async () => {
    const pdf = await convert(page, name, ["images/pages.tiff"]);
    const s = await sizes(pdf);
    if (s.length !== 2) throw new Error(`${s.length} pages`);
    s.forEach((x, i) => sameRatio(x, 100, 140, `page ${i + 1}`));
    const [one, two] = await sample(pdf, QUAD_POINTS);
    upright(one, "page 1");
    upright([two[3], two[2], two[1], two[0]], "page 2 (stored upside down)");
    return "2 pages";
  });

  await test("AVIF converts", async () => {
    const pdf = await convert(page, name, ["images/photo.avif"]);
    const s = await sizes(pdf);
    sameRatio(s[0], 150, 100, "AVIF");
    upright((await sample(pdf, QUAD_POINTS))[0], "AVIF");
    return `${s[0].width.toFixed(0)}×${s[0].height.toFixed(0)}`;
  });

  await test("SVG converts at its own size", async () => {
    const pdf = await convert(page, name, ["images/drawing.svg"]);
    const [s] = await sizes(pdf);
    if (Math.abs(s.width - 150) > 0.5 || Math.abs(s.height - 75) > 0.5) throw new Error(`page ${s.width} × ${s.height}, not 150 × 75`);
    upright((await sample(pdf, QUAD_POINTS))[0], "SVG");
    return "150×75";
  });

  await test("JPEGs in all 8 EXIF orientations come out upright", async () => {
    const files = Array.from({ length: 8 }, (_, i) => `images/orient-${i + 1}.jpg`);
    const pdf = await convert(page, name, files);
    const s = await sizes(pdf);
    if (s.length !== 8) throw new Error(`${s.length} pages`);
    s.forEach((x, i) => sameRatio(x, 120, 200, `orientation ${i + 1}`));
    (await sample(pdf, QUAD_POINTS)).forEach((c, i) => upright(c, `orientation ${i + 1}`));
    // The JPEGs are embedded as they are, less their metadata (EXIF here).
    if (pdf.includes(Buffer.from("Exif\0\0", "latin1"))) throw new Error("EXIF data reached the PDF");
    return "8 upright, no EXIF";
  });

  await test("a TIFF whose pages loop is refused, not left to hang the tab", async () => {
    const msg = await convert(page, name, ["images/loop.tiff"]).then(
      () => { throw new Error("converted"); },
      (e) => e.message,
    );
    if (!msg.startsWith("alert: ")) throw new Error(msg);
    if (!msg.includes("loop.tiff")) throw new Error(`alert doesn't name the file: ${msg}`);
    return msg.slice(7, 90);
  });

  await test("A3, A5 and Legal page sizes", async () => {
    const want = { a3: [297, 420], a5: [148, 210], legal: [215.9, 355.6] };
    const got = [];
    for (const [size, [w, h]] of Object.entries(want)) {
      const [s] = await sizes(await convert(page, name, ["images/photo.webp"], { pageSize: size }));
      if (Math.abs(s.width - w * MM) > 1 || Math.abs(s.height - h * MM) > 1) throw new Error(`${size}: ${s.width} × ${s.height}`);
      got.push(size);
    }
    return got.join(", ");
  });

  await test("custom page size and a 20 mm margin", async () => {
    // 120 × 200 in the 60 × 110 mm inside 20 mm margins: width-bound, so
    // the image is 60 × 100 mm, from 20 mm left and 25 mm down.
    const pdf = await convert(page, name, ["images/photo.webp"], { pageSize: "custom", width: 100, height: 150, margin: 20 });
    const [s] = await sizes(pdf);
    if (Math.abs(s.width - 100 * MM) > 1 || Math.abs(s.height - 150 * MM) > 1) throw new Error(`page ${s.width} × ${s.height}`);
    const y = (mm) => () => (n) => (n * mm) / 150;
    const x = (mm) => () => (n) => (n * mm) / 100;
    const [[above, inside, left, right]] = await sample(pdf, [[x(50)(), y(18)()], [x(50)(), y(28)()], [x(15)(), y(75)()], [x(23)(), y(75)()]]);
    if (!near(above, [255, 255, 255])) throw new Error(`top margin is ${above}`);
    if (near(inside, [255, 255, 255])) throw new Error("no image 28 mm down");
    if (!near(left, [255, 255, 255])) throw new Error(`left of the image is ${left}`);
    if (near(right, [255, 255, 255])) throw new Error("no image 23 mm from the left");
    return "100 × 150 mm";
  });

  await ctx.close();

  await test("HEIC converts offline after one visit", async () => {
    const vendor = readFileSync(join(root, "src/lib/vendor.ts"), "utf8").match(/VENDOR = "([^"]+)"/)[1];
    const offline = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
    try {
      const p = await offline.newPage();
      await open(p, "/en/jpg-to-pdf");
      // The page caches the decoder once a service worker controls it.
      for (const end = Date.now() + 60000; ; await p.waitForTimeout(250)) {
        const done = await p.evaluate(async (urls) => {
          for (const u of urls) if (!(await caches.match(u))) return false;
          return true;
        }, ["worker.js", "libheif.js", "libheif.wasm"].map((f) => `${vendor}heif/${f}`));
        if (done) break;
        if (Date.now() > end) throw new Error("the HEIC decoder was never cached");
      }
      await offline.setOffline(true);
      await p.reload({ waitUntil: "load" });
      await open(p, "/en/jpg-to-pdf").catch(() => {});
      await pick(p, ["photo.heic"]);
      await p.getByRole("button", { name: t["tool.jpgToPdf.action"], exact: true }).click();
      await Promise.race([
        p.getByText(t["res.doneTitle"]).waitFor({ timeout: 30000 }),
        p.getByRole("alert").filter({ hasText: /\S/ }).first().waitFor({ timeout: 30000 }).then(async () => {
          throw new Error(`alert: ${(await p.getByRole("alert").filter({ hasText: /\S/ }).first().innerText()).replace(/\s+/g, " ")}`);
        }),
      ]);
      return "converted offline";
    } finally {
      await offline.close();
    }
  });
});
