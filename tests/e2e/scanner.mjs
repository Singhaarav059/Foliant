// Scan to PDF end to end with a fake camera: Chrome plays a generated video
// of an A4 page seen at an angle on a textured table. The scanner must find
// the page's corners live, let them be dragged, flatten the page and build a
// PDF whose pages have A4's shape (within 3%) and show paper, not table, in
// their corners. Also checks the camera layout at a 375 px phone width.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3850 &
//   BASE_URL=http://localhost:3850 CHROME_PATH=... node tests/e2e/scanner.mjs
//
// Chromium only: the fake camera is a Chrome switch.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pw from "playwright-core";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { createCanvas } from "@napi-rs/canvas";
import { base, dict, open } from "./kit.mjs";
import { PH, PW, photo, project } from "../lib/scan-scene.mjs";

const t = dict("en");
const dir = mkdtempSync(join(tmpdir(), "e2e-scanner-"));
const W = 1280, H = 720;
const corners = project({ tilt: 22, yaw: 8, roll: 7, at: [30, 0, 560] }, W, H);

// A 4:2:0 Y4M file Chrome loops as the camera.
function y4m(img, frames = 3) {
  const { width: w, height: h, data } = img;
  const y = Buffer.alloc(w * h), u = Buffer.alloc((w / 2) * (h / 2)), v = Buffer.alloc((w / 2) * (h / 2));
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4;
      y[j * w + i] = Math.round(0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2]);
    }
  }
  for (let j = 0; j < h / 2; j++) {
    for (let i = 0; i < w / 2; i++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const k = ((j * 2 + dy) * w + i * 2 + dx) * 4;
        r += data[k] / 4; g += data[k + 1] / 4; b += data[k + 2] / 4;
      }
      u[j * (w / 2) + i] = Math.max(0, Math.min(255, Math.round(-0.1687 * r - 0.3313 * g + 0.5 * b + 128)));
      v[j * (w / 2) + i] = Math.max(0, Math.min(255, Math.round(0.5 * r - 0.4187 * g - 0.0813 * b + 128)));
    }
  }
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, u, v]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420jpeg\n`), ...Array(frames).fill(frame)]);
}
const video = join(dir, "page.y4m");
writeFileSync(video, y4m(photo({ w: W, h: H, corners, noise: 6, clutter: 6, seed: 11 })));

const browser = await pw.chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-video-capture=${video}`],
});

const results = [];
async function test(label, fn) {
  const t0 = Date.now();
  try {
    results.push({ label, ok: true, detail: (await fn()) ?? "" });
  } catch (e) {
    results.push({ label, ok: false, detail: e.message.split("\n").slice(0, 8).join(" | ").slice(0, 900) });
  }
  results.at(-1).ms = Date.now() - t0;
}

// The corner handles' centres, in camera-frame pixels, all read at once.
async function handles(page) {
  const labels = ["tl", "tr", "br", "bl"].map((k) => t[`ws.corner.${k}`]);
  return page.evaluate(({ photo, labels, W, H }) => {
    const img = document.querySelector(`img[alt="${photo}"]`).getBoundingClientRect();
    return labels.map((l) => {
      const b = document.querySelector(`button[aria-label="${l}"]`).getBoundingClientRect();
      return { x: ((b.x + b.width / 2 - img.x) / img.width) * W, y: ((b.y + b.height / 2 - img.y) / img.height) * H, box: { x: b.x, y: b.y, width: b.width, height: b.height } };
    });
  }, { photo: t["ws.scanPhoto"], labels, W, H });
}

async function captureAndKeep(page) {
  await page.getByRole("status").filter({ hasText: t["ws.scanFound"] }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: t["ws.capture"], exact: true }).click();
  await page.getByRole("button", { name: t["ws.scanKeep"], exact: true }).waitFor({ timeout: 20000 });
  const found = await handles(page);
  const diag = Math.hypot(W, H);
  const err = Math.max(...found.map((p, i) => Math.hypot(p.x - corners[i].x, p.y - corners[i].y))) / diag;
  if (err > 0.02) throw new Error(`corner handles are ${(err * 100).toFixed(1)}% of the diagonal off: ${JSON.stringify(found.map((p) => [Math.round(p.x), Math.round(p.y)]))}`);
  await page.getByRole("button", { name: t["ws.scanKeep"], exact: true }).click();
  return err;
}

async function build(page, look) {
  if (look) {
    // Four looks: Options shows them as a select.
    const filter = page.getByLabel(t["opt.filter"], { exact: true });
    await filter.waitFor({ timeout: 20000 });
    await filter.selectOption(look);
  }
  // A select, or (three choices) a radio group named by the same label.
  const size = page.getByLabel(t["opt.pageSize"], { exact: true });
  if (await size.count() && (await size.evaluate((e) => e.tagName)) === "SELECT") await size.selectOption("fit");
  else await page.getByRole("radio", { name: t["choice.pageSize.fit"] }).click();
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.getByRole("button", { name: t["tool.scan.action"], exact: true }).click(),
  ]);
  const path = join(dir, `${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(path);
  return readFileSync(path);
}

// Brightness near each corner of each page, rendered with pdf.js.
async function cornerLight(bytes) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const viewport = p.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext("2d");
    await p.render({ canvas, canvasContext: ctx, viewport }).promise;
    out.push([[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]].map(([fx, fy]) => {
      const d = ctx.getImageData(Math.floor(fx * viewport.width), Math.floor(fy * viewport.height), 1, 1).data;
      return Math.round((d[0] + d[1] + d[2]) / 3);
    }));
  }
  await doc.loadingTask.destroy();
  return out;
}

// The share of the page image's samples that are neither black nor white.
async function greys(bytes) {
  const doc = await PDFDocument.load(bytes);
  let mid = 0, total = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.dict.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    if (obj.dict.get(PDFName.of("BitsPerComponent"))?.asNumber() !== 8 || obj.dict.has(PDFName.of("DecodeParms"))) continue;
    const isMask = [...doc.context.enumerateIndirectObjects()].some(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("SMask")) && doc.context.lookup(o.dict.get(PDFName.of("SMask"))) === obj);
    if (isMask) continue;
    const data = obj.dict.get(PDFName.of("Filter")) === PDFName.of("FlateDecode") ? inflateSync(obj.contents) : obj.contents;
    for (const v of data) { total++; if (v !== 0 && v !== 255) mid++; }
  }
  if (!total) throw new Error("no uncompressed-pixel image found in the PDF");
  return mid / total;
}

async function checkPdf(bytes, pages) {
  const doc = await PDFDocument.load(bytes);
  if (doc.getPageCount() !== pages) throw new Error(`${doc.getPageCount()} pages, want ${pages}`);
  const notes = [];
  for (const p of doc.getPages()) {
    const { width, height } = p.getSize();
    const off = Math.abs(width / height / (PW / PH) - 1);
    if (off > 0.03) throw new Error(`page is ${width.toFixed(0)} × ${height.toFixed(0)}, ${(off * 100).toFixed(1)}% off A4`);
    notes.push(`${(off * 100).toFixed(1)}% off A4`);
  }
  for (const light of await cornerLight(bytes)) {
    if (light.some((v) => v < 170)) throw new Error(`page corners show the table, brightness ${light}`);
  }
  return notes.join(", ");
}

await test("one capture, B/W look → a 1-page PDF shaped like A4", async () => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  await open(page, "/en/scan-to-pdf");
  await page.getByRole("button", { name: t["ws.camera"], exact: true }).click();
  const err = await captureAndKeep(page);
  const pdf = await build(page, "bw");
  const note = await checkPdf(pdf, 1);
  // The black-and-white look: the page image is pure black and white.
  const grey = await greys(pdf);
  if (grey > 0.02) throw new Error(`${(grey * 100).toFixed(1)}% of the page is grey in the B/W look`);
  await ctx.close();
  return `corners ${(err * 100).toFixed(2)}% off, ${note}`;
});

await test("phone width: camera fits, corners can be dragged, two pages", async () => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true, acceptDownloads: true });
  const page = await ctx.newPage();
  await open(page, "/en/scan-to-pdf");
  await page.getByRole("button", { name: t["ws.camera"], exact: true }).click();
  await page.getByRole("status").filter({ hasText: t["ws.scanFound"] }).waitFor({ timeout: 20000 });
  const overflow = async (where) => {
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    if (sw > 375) throw new Error(`${where}: page is ${sw}px wide at 375`);
  };
  await overflow("camera");
  const shutter = await page.getByRole("button", { name: t["ws.capture"], exact: true }).boundingBox();
  if (shutter.x < 0 || shutter.x + shutter.width > 375 || shutter.width < 44) throw new Error(`capture button at ${JSON.stringify(shutter)}`);

  // First page: drag a corner away, then back onto the page's corner.
  await page.getByRole("button", { name: t["ws.capture"], exact: true }).click();
  await page.getByRole("button", { name: t["ws.scanKeep"], exact: true }).waitFor({ timeout: 20000 });
  await overflow("corners");
  const before = await handles(page);
  for (const h of before) {
    if (h.box.width < 44 || h.box.x < -h.box.width / 2 || h.box.x + h.box.width / 2 > 375) throw new Error(`corner handle at ${JSON.stringify(h.box)}`);
  }
  const keep = await page.getByRole("button", { name: t["ws.scanKeep"], exact: true }).boundingBox();
  if (keep.x < 0 || keep.x + keep.width > 375) throw new Error(`Keep button at ${JSON.stringify(keep)}`);
  const tl = before[0].box;
  const [cx, cy] = [tl.x + tl.width / 2, tl.y + tl.height / 2];
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 30, { steps: 5 });
  await page.mouse.up();
  const moved = (await handles(page))[0];
  if (Math.hypot(moved.x - before[0].x, moved.y - before[0].y) < 20) throw new Error("dragging didn't move the corner");
  // Keyboard: arrows move the focused corner.
  await page.getByRole("button", { name: t["ws.corner.tl"], exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  const nudged = (await handles(page))[0];
  if (!(nudged.x < moved.x)) throw new Error("ArrowLeft didn't move the corner");
  await page.getByRole("button", { name: t["ws.scanAuto"], exact: true }).click();
  const back = (await handles(page))[0];
  if (Math.hypot(back.x - before[0].x, back.y - before[0].y) > 3) throw new Error("Detect again didn't restore the corner");
  await page.getByRole("button", { name: t["ws.scanKeep"], exact: true }).click();

  // Second page: the camera is still on after the first.
  await captureAndKeep(page);
  await page.getByRole("button", { name: t["ws.scanDone"], exact: true }).click();
  await overflow("file board");
  const note = await checkPdf(await build(page), 2);
  await ctx.close();
  return note;
});

await browser.close();
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  chromium  ${r.label.padEnd(58)} ${`${r.ms}ms`.padStart(8)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed (${base})`);
process.exit(failed ? 1 : 0);
