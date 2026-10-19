// Compress to a size, the exam photo kit and the "compress PDF to N KB"
// landing pages, in a real browser against the static build:
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3840 &
//   BASE_URL=http://localhost:3840 node tests/e2e/exactsize.mjs chromium
//
// A generated 4-page photo PDF (about 3 MB) must come back at or under the
// target and within 15% of it, open in pdf.js with its text, and the result
// must say the size it reached.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { base, open, root, suite } from "./kit.mjs";

const sharp = createRequire(join(root, "package.json"))("sharp");
const tmp = mkdtempSync(join(tmpdir(), "exactsize-"));

let seed = 5;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
async function photo(w, h) {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const n = (rnd() - 0.5) * 30;
      data[(y * w + x) * 3] = Math.max(0, Math.min(255, 128 + 90 * Math.sin(x / 70) * Math.cos(y / 50) + n));
      data[(y * w + x) * 3 + 1] = Math.max(0, Math.min(255, 120 + 80 * Math.sin((x + y) / 110) + n));
      data[(y * w + x) * 3 + 2] = Math.max(0, Math.min(255, 110 + 70 * Math.cos(x / 45 - y / 80) + n));
    }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 92 }).toBuffer();
}
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 4; n++) {
  const page = doc.addPage([595, 842]);
  page.drawText(`Field report ${n}`, { x: 50, y: 790, size: 20, font });
  page.drawImage(await doc.embedJpg(await photo(1600, 1100)), { x: 50, y: 380, width: 495, height: 340 });
}
const input = join(tmp, "report.pdf");
writeFileSync(input, await doc.save());
writeFileSync(join(tmp, "face.jpg"), await photo(900, 1200));
console.log(`input ${(readFileSync(input).length / 1024).toFixed(0)} KB, ${base}`);

const pdfjs = await import(pathToFileURL(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
async function texts(bytes) {
  const d = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= d.numPages; i++) {
    const p = await d.getPage(i);
    await p.getOperatorList();
    out.push((await p.getTextContent()).items.map((x) => x.str).join(" "));
  }
  return out;
}

const action = (page) => page.locator("main aside.card button.btn-primary").first();
// Runs the tool on `file` (after `set` changes options) and returns the downloaded bytes and the result text.
async function run(page, file, set) {
  await page.locator("input[type=file]").first().setInputFiles(file);
  await page.waitForSelector("main aside.card", { timeout: 30000 });
  await set?.();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 180000 }), action(page).click()]);
  const bytes = readFileSync(await download.path());
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  return { bytes, text, name: download.suggestedFilename() };
}
const within = (size, kb) => {
  if (size > kb * 1024) throw new Error(`${size} bytes, over ${kb} KB`);
  if (size < kb * 1024 * 0.85) throw new Error(`${size} bytes, more than 15% under ${kb} KB`);
};

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await ctx.route((u) => u.origin !== new URL(base).origin && !/^(blob|data):$/.test(u.protocol), (r) => r.abort());

  await test("/en/compress-pdf-to-200kb starts at 200 KB and gets there", async () => {
    const page = await ctx.newPage();
    await open(page, "/en/compress-pdf-to-200kb");
    const h1 = await page.locator("h1").innerText();
    if (h1 !== "Compress PDF to 200 KB") throw new Error(`h1 ${h1}`);
    const r = await run(page, input);
    within(r.bytes.length, 200);
    const t = await texts(r.bytes);
    if (t.length !== 4 || !t.every((x, i) => x.includes(`Field report ${i + 1}`))) throw new Error(`text ${JSON.stringify(t)}`);
    if (!/under your 200\.0 KB target/.test(r.text)) throw new Error(`result says: ${r.text.slice(0, 200)}`);
    await page.close();
    return `${(r.bytes.length / 1024).toFixed(1)} KB, ${r.name}`;
  });

  await test("/en/compress-pdf with a 100 KB target", async () => {
    const page = await ctx.newPage();
    await open(page, "/en/compress-pdf");
    const r = await run(page, input, () => page.locator('main select[id$="-targetKb"]').selectOption("100"));
    within(r.bytes.length, 100);
    if ((await texts(r.bytes)).length !== 4) throw new Error("pages");
    await page.close();
    return `${(r.bytes.length / 1024).toFixed(1)} KB`;
  });

  await test("/en/exam-photo-resizer makes a 200x230 photo of at most 50 KB", async () => {
    const page = await ctx.newPage();
    await open(page, "/en/exam-photo-resizer");
    const r = await run(page, join(tmp, "face.jpg"));
    let size = "none";
    for (let i = 2; i + 9 < r.bytes.length; i += 2 + r.bytes.readUInt16BE(i + 2)) {
      const m = r.bytes[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) { size = `${r.bytes.readUInt16BE(i + 7)}x${r.bytes.readUInt16BE(i + 5)}`; break; }
    }
    if (size !== "200x230") throw new Error(`size ${size}`);
    if (r.bytes.length > 50 * 1024) throw new Error(`${r.bytes.length} bytes`);
    if (!/200 x 230 px/.test(r.text)) throw new Error(`result says: ${r.text.slice(0, 200)}`);
    await page.close();
    return `${(r.bytes.length / 1024).toFixed(1)} KB`;
  });
  await ctx.close();
});
