// Cancel stops the work (P1-10): a long OCR, Compress and Office (LibreOffice)
// job is started, Cancel is pressed a few seconds in, and then
//   - within 3 s the page's renderer is idle (under 20% of a core),
//   - no worker the job started is left (Tesseract, LibreOffice, pdf.js),
//   - the renderer's memory is back near where it was before the job (within
//     a minute: a terminated LibreOffice gives its memory back in steps),
//   - and a new run in the same tool works.
// OCR runs twice: with Tesseract, and with PaddleOCR (high accuracy).
// Chromium only: CPU and memory are read over the DevTools protocol and ps.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3830 &
//   BASE_URL=http://localhost:3830 node tests/e2e/cancel.mjs chromium
//
// CHROME_PATH runs it in an installed Chrome.
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, fixtures, open, root, suite } from "./kit.mjs";

const t = dict("en");
const dir = mkdtempSync(join(tmpdir(), "e2e-cancel-"));
const sharp = createRequire(join(root, "package.json"))("sharp");

// 160 scanned pages: about a minute of OCR on four workers.
const scans = join(dir, "scans-160.pdf");
{
  const src = await PDFDocument.load(readFileSync(join(fixtures, "scanned.pdf")));
  const d = await PDFDocument.create();
  for (const p of await d.copyPages(src, Array(160).fill(0))) d.addPage(p);
  writeFileSync(scans, await d.save());
}
// Forty pages of noisy photos: every one is decoded, resampled and re-encoded.
const photos = join(dir, "photos-40.pdf");
{
  const d = await PDFDocument.create();
  for (let i = 0; i < 40; i++) {
    const jpg = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 120, g: 90 + i, b: 60 }, noise: { type: "gaussian", mean: 128, sigma: 40 } } }).jpeg({ quality: 90 }).toBuffer();
    const img = await d.embedJpg(jpg);
    d.addPage([612, 459]).drawImage(img, { x: 0, y: 0, width: 612, height: 459 });
  }
  writeFileSync(photos, await d.save());
}
const step = (...a) => process.env.CANCEL_DEBUG && console.error(new Date().toISOString().slice(11, 19), ...a);
// A long Word document: hundreds of pages of paragraphs and tables for LibreOffice to lay out.
const longDocx = join(dir, "long.docx");
{
  const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const cell = (text) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`;
  const body = [];
  for (let i = 0; i < 12000; i++) {
    body.push(p(`Paragraph ${i}: ${"The quick brown fox jumps over the lazy dog. ".repeat(12)}`));
    if (i % 5 === 0) body.push(`<w:tbl><w:tblPr><w:tblBorders><w:insideH w:val="single" w:sz="4"/></w:tblBorders></w:tblPr>${Array.from({ length: 6 }, (_, r) => `<w:tr>${[1, 2, 3, 4].map((c) => cell(`R${r}C${c} ${i}`)).join("")}</w:tr>`).join("")}</w:tbl>`);
  }
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}</w:body></w:document>`);
  writeFileSync(longDocx, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}
const at = (f) => (f.startsWith("/") ? f : join(fixtures, f));

await suite(async ({ browser, test: run }) => {
  // CANCEL_ONLY=office (or ocr, compress) runs one case.
  const test = (label, fn) => (!process.env.CANCEL_ONLY || label.toLowerCase().includes(process.env.CANCEL_ONLY) ? run(label, fn) : null);
  const cdp = await browser.newBrowserCDPSession();
  const renderers = async () => (await cdp.send("SystemInfo.getProcessInfo")).processInfo.filter((p) => p.type === "renderer");
  // Share of one core the renderers used over `ms`.
  const cpu = async (ms) => {
    const a = new Map((await renderers()).map((p) => [p.id, p.cpuTime]));
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    const b = await renderers();
    const used = b.reduce((s, p) => s + p.cpuTime - (a.get(p.id) ?? 0), 0);
    return used / ((Date.now() - t0) / 1000);
  };
  // Memory of the renderers, in MB: on macOS their physical footprint (resident
  // size there keeps pages the system may reclaim at will), elsewhere resident size.
  const MB = { K: 1 / 1024, M: 1, G: 1024 };
  const footprint = (pid) => {
    const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(execFileSync("vmmap", ["--summary", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    return m ? Number(m[1]) * MB[m[2]] : 0;
  };
  const rss = async () => {
    const pids = (await renderers()).map((p) => p.id);
    if (process.platform === "darwin") return pids.reduce((s, pid) => s + footprint(pid), 0);
    return execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" }).trim().split(/\s+/).reduce((s, k) => s + Number(k), 0) / 1024;
  };

  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const session = await ctx.newCDPSession(page);
  // Garbage collection, and a memory-pressure signal so the renderer hands
  // back memory its allocators keep cached: what's left is memory still held.
  const settle = async () => {
    await session.send("HeapProfiler.collectGarbage").catch(() => {});
    await session.send("Memory.simulatePressureNotification", { level: "critical" }).catch((e) => step("pressure", e.message));
    await page.waitForTimeout(500);
  };
  const pick = (files) => page.locator("input[type=file]").first().setInputFiles(files.map(at));
  const removeAll = async () => {
    // The card itself is a role=button named after its contents: take the
    // button inside. dnd-kit marks a card that can't be dragged aria-disabled,
    // which Playwright extends to the button, hence force.
    const remove = page.locator(`button[aria-label^="${t["ws.remove"]} "]`);
    while (await remove.count()) await remove.first().click({ force: true });
  };
  const action = (key) => page.getByRole("button", { name: t[`tool.${key}.action`], exact: true }).first();

  // Runs one tool's long job, cancels it after `ms`, and checks what's left.
  async function cancelled(key, { files, again, ms = 5000, consent = false, timeout = 240000, set }) {
    step(key, "pick");
    await pick(files);
    await set?.();
    await page.waitForTimeout(2000); // file thumbnails and page counts
    await settle();
    const before = { rss: await rss(), workers: page.workers().length };
    step(key, "start", before);
    await action(key).click();
    if (consent) await page.getByRole("button", { name: t["ws.officeConsentYes"], exact: true }).click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(ms);
    // Cancel while it works hard (LibreOffice pauses between its phases now and then).
    let load = await cpu(1000);
    for (let i = 0; i < 10 && load < 0.5; i++) load = await cpu(1000);
    const busy = { cpu: load, rss: await rss(), workers: page.workers().length };
    step(key, "busy", busy);
    if (busy.cpu < 0.5) throw new Error(`the job wasn't running when cancelled (CPU ${(busy.cpu * 100).toFixed(0)}%)`);
    await page.getByRole("button", { name: t["ws.cancel"], exact: true }).click();
    const cancelledAt = Date.now();
    await page.waitForTimeout(2000);
    const idle = await cpu(1000);
    // Memory a terminated worker held goes back to the system in steps, over
    // up to about 20 s for LibreOffice's: wait up to a minute for it.
    const near = (mb) => mb <= before.rss + Math.max(150, (busy.rss - before.rss) * 0.25);
    let after;
    for (let i = 0; i < 60; i++) {
      await settle();
      after = { rss: await rss(), workers: page.workers().length };
      step(key, "settling", i, after.rss.toFixed(0));
      if (near(after.rss) && after.workers <= before.workers) break;
      await page.waitForTimeout(500);
    }
    const heap = (await session.send("Runtime.getHeapUsage")).usedSize / 1e6;
    const report = `CPU ${(busy.cpu * 100).toFixed(0)}% → ${(idle * 100).toFixed(0)}%, workers ${before.workers} → ${busy.workers} → ${after.workers}, ` +
      `memory ${before.rss.toFixed(0)} → ${busy.rss.toFixed(0)} → ${after.rss.toFixed(0)} MB (${((Date.now() - cancelledAt) / 1000).toFixed(0)} s after Cancel; page heap ${heap.toFixed(0)} MB)`;
    const problems = [];
    if (idle >= 0.2) problems.push("still busy after Cancel");
    if (after.workers > before.workers) problems.push("workers left running");
    if (!near(after.rss)) problems.push("memory not freed");
    step(key, report);
    if (problems.length) throw new Error(`${problems.join(", ")}: ${report}`);

    // The tool still works: a new run gives its file.
    step(key, "again", after);
    try {
      if (again) {
        await removeAll();
        await pick(again);
      }
      await action(key).click();
      // The result screen (a file that didn't get smaller isn't downloaded by itself).
      await page.getByRole("heading", { name: new RegExp(`^(${t["res.doneTitle"]}|${t["res.doneTitlePlural"]})$`) }).waitFor({ timeout });
      return `${report}; then a new run worked`;
    } catch (e) {
      await page.screenshot({ path: join(dir, `${key}-again.png`) });
      throw new Error(`the run after Cancel failed (${join(dir, `${key}-again.png`)}): ${e.message.split("\n")[0]}`);
    }
  }

  try {
    await test("OCR: Cancel stops Tesseract", async () => {
      await open(page, "/en/ocr-pdf");
      return cancelled("ocr", { files: [scans], again: ["scanned.pdf"] });
    });
    await test("OCR, high accuracy: Cancel stops PaddleOCR", async () => {
      await open(page, "/en/ocr-pdf");
      const accurate = () => page.locator(`main label[id$="-ocrEngine-label"] + [role=radiogroup] [role=radio]`).nth(1).click();
      return cancelled("ocr", { files: [scans], again: ["scanned.pdf"], set: accurate, ms: 8000 });
    });
    await test("Compress: Cancel stops the image loop", async () => {
      await open(page, "/en/compress-pdf");
      return cancelled("compress", { files: [photos], again: ["report.pdf"] });
    });
    await test("Word to PDF (High): Cancel stops LibreOffice", async () => {
      await open(page, "/en/word-to-pdf");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await open(page, "/en/word-to-pdf");
      if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error("not cross-origin isolated");
      const high = () => page.getByRole("radio", { name: new RegExp(`^${t["choice.fidelity.high"].split(":")[0]}`) }).click();
      return cancelled("wordToPdf", { files: [longDocx], again: ["brief.docx"], set: high, consent: true, ms: 10000, timeout: 300000 });
    });
  } finally {
    await ctx.close();
  }
});
