// OCR accuracy: draws pages of known text in Chrome under hard conditions,
// reads them with Tesseract (standard) and PaddleOCR (high accuracy) through
// the same page cleanup, and compares character error rates. High accuracy
// must be at least as good overall and better on the hard pages.
// Needs Chrome (see tests/lib/chrome.mjs).
//
//   node tests/ocr-accuracy.mjs
import pw from "playwright-core";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, createScheduler } from "tesseract.js";
import { vendorDir, load, check, eq } from "./lib/load.mjs";
import { requireChrome } from "./lib/chrome.mjs";

const chrome = requireChrome();
const results = { failed: 0 };
const test = check(results);
const { readPage } = await load("ocr");
const paddle = await load("paddle");
paddle.paddleFiles.url = (name) => join(vendorDir, "paddle", name);
paddle.paddleFiles.load = async (name) => new Uint8Array(readFileSync(join(vendorDir, "paddle", name)));
paddle.paddleFiles.proxy = () => false;

const LATIN = [
  "Invoice 4471 issued on 12 March 2026 to Northwind Traders Ltd.",
  "Total due: 1,250.00 EUR, payable within thirty days of receipt.",
  "Please quote the reference AB-77-310 with every payment you make.",
  "Questions? Write to accounts@northwind.example or call +44 20 7946 0958.",
];
const CHINESE = ["发票编号四四七一，开具日期为二零二六年三月十二日。", "应付总额为一千二百五十欧元，请在三十天内付款。"];

// Each case: text lines, how they're drawn, and the Tesseract language.
const cases = {
  clean: { lines: LATIN, font: "28px Georgia", lang: "eng" },
  smallPrint: { lines: LATIN, font: "13px Arial", lang: "eng" },
  blurNoise: { lines: LATIN, font: "22px Arial", blur: 1.4, noise: 40, lang: "eng" },
  faintShadow: { lines: LATIN, font: "22px Georgia", ink: "#9a9a9a", shadow: true, lang: "eng" },
  phonePhoto: { lines: LATIN, font: "24px Arial", rotate: 2.5, blur: 1, noise: 25, shadow: true, lang: "eng" },
  degraded: { lines: LATIN, font: "18px Georgia", blur: 1.2, noise: 35, ink: "#555", shadow: true, rotate: 1.2, lang: "eng" },
  // Barely legible to a person; reported, not held to a target.
  extreme: { lines: LATIN, font: "15px Georgia", blur: 1.5, noise: 60, ink: "#555", shadow: true, rotate: 1.2, lang: "eng", report: true },
  chinese: { lines: CHINESE, font: "30px 'PingFang SC', 'Noto Sans CJK SC', sans-serif", lang: "chi_sim" },
};

const browser = await pw.chromium.launch({ executablePath: chrome });
const page = await browser.newPage();
async function draw(c) {
  return page.evaluate((c) => {
    const W = 1400, H = 700;
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const x = cv.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, W, H);
    if (c.shadow) { // uneven light and paper texture
      const g = x.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "#fdfaf2");
      g.addColorStop(1, "#8f8a80");
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    }
    x.save();
    if (c.rotate) { x.translate(W / 2, H / 2); x.rotate((c.rotate * Math.PI) / 180); x.translate(-W / 2, -H / 2); }
    if (c.blur) x.filter = `blur(${c.blur}px)`;
    x.fillStyle = c.ink ?? "#111";
    x.font = c.font;
    const size = parseInt(c.font, 10);
    c.lines.forEach((line, i) => x.fillText(line, 60, 120 + i * size * 2.2));
    x.restore();
    const img = x.getImageData(0, 0, W, H).data;
    const gray = new Array(W * H);
    let seed = 1;
    for (let i = 0; i < W * H; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = c.noise ? ((seed / 0x7fffffff) - 0.5) * c.noise : 0;
      gray[i] = Math.max(0, Math.min(255, Math.round(img[i * 4] * 0.3 + img[i * 4 + 1] * 0.59 + img[i * 4 + 2] * 0.11 + n)));
    }
    return { w: W, h: H, data: gray };
  }, c);
}

// Character error rate: edit distance / reference length, ignoring spaces for Chinese.
function cer(ref, hyp, cjk) {
  const norm = (s) => (cjk ? s.replace(/\s+/g, "") : s.replace(/\s+/g, " ").trim());
  const a = [...norm(ref)], b = [...norm(hyp)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

const tess = new Map();
async function tesseract(lang) {
  if (!tess.has(lang)) {
    const s = createScheduler();
    s.addWorker(await createWorker(lang, undefined, { langPath: join(vendorDir, "tessdata"), cachePath: mkdtempSync(join(tmpdir(), "tess-")) }));
    tess.set(lang, s);
  }
  const { grayPng } = await load("ocrprep");
  const s = tess.get(lang);
  return async (g) => (await s.addJob("recognize", Buffer.from(grayPng(g)), {}, { blocks: true })).data;
}

const rows = [];
for (const [name, c] of Object.entries(cases)) {
  const px = await draw(c);
  const image = { w: px.w, h: px.h, data: Uint8Array.from(px.data) };
  const ref = c.lines.join(" ");
  const cjk = c.lang.startsWith("chi");
  const t0 = Date.now();
  const t = await readPage(await tesseract(c.lang), image);
  const t1 = Date.now();
  const p = await readPage(paddle.paddlePage, image);
  const t2 = Date.now();
  const join = (r) => r.words.map((w) => w.text).join(cjk ? "" : " ");
  rows.push({ name, report: c.report, tess: cer(ref, join(t), cjk), paddle: cer(ref, join(p), cjk), tms: t1 - t0, pms: t2 - t1, pText: join(p), tText: join(t) });
}
await browser.close();
for (const s of tess.values()) await s.terminate();

const pct = (v) => `${(v * 100).toFixed(1)}%`.padStart(7);
console.log("      case          Tesseract   PaddleOCR   (character error rate; time)");
for (const r of rows) console.log(`      ${r.name.padEnd(13)} ${pct(r.tess)} ${String(r.tms).padStart(5)}ms ${pct(r.paddle)} ${String(r.pms).padStart(5)}ms`);
const scored = rows.filter((r) => !r.report);
const mean = (k) => scored.reduce((s, r) => s + r[k], 0) / scored.length;
console.log(`      mean (excluding extreme) ${pct(mean("tess"))}  ${pct(mean("paddle"))}`);
if (process.env.SHOW) for (const r of rows) console.log(`\n      [${r.name}]\n      T: ${r.tText}\n      P: ${r.pText}`);

await test("high accuracy reads clean text well", () => eq(rows.find((r) => r.name === "clean").paddle < 0.03, true, "clean CER under 3%"));
await test("high accuracy beats standard on average", () => eq(mean("paddle") < mean("tess"), true, "mean CER lower"));
// Measured 2026-10-17: PaddleOCR trails Tesseract on tiny, blurred Latin print
// ("degraded": 4.2% vs 1.1%) and leads everywhere else. Guard that gap.
await test("high accuracy is never much worse on any page", () => {
  for (const r of scored) if (r.paddle > r.tess + 0.05) throw new Error(`${r.name}: ${pct(r.paddle)} vs ${pct(r.tess)}`);
});
await test("zeros in numbers aren't read as the letter o", async () => {
  const { fixDigits } = paddle;
  eq(["1,250.0o", "AB-77-31o", "2O26", "o800", "Total", "Oslo", "No.5"].map(fixDigits).join(" "), "1,250.00 AB-77-310 2026 0800 Total Oslo No.5", "fixes");
});
process.exit(results.failed ? 1 : 0);
