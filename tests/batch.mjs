// No caps and batches (P2-03): the device-memory budget that only warns,
// crop with one box on several files, redaction searches run on every file of
// a batch, and the per-file states a batch reports while it runs.
//
//   node tests/batch.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { load, loadLib, openPdf, check, eq } from "./lib/load.mjs";

// pdf.js runs its worker in-process here.
globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const results = { failed: 0 };
const test = check(results);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const MB = 1024 * 1024;

async function pdf(lines, size = [400, 300]) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of lines) doc.addPage(size).drawText(text, { x: 40, y: 200, size: 14, font });
  return new File([await doc.save()], `${lines[0].replace(/\W+/g, "-")}.pdf`, { type: "application/pdf" });
}
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
const textOf = async (blob) => {
  const doc = await openPdf(await bytes(blob));
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(" "));
  return out.join(" | ");
};

const { memoryBudget, overBudget } = await loadLib("budget");
const { LIMITS, toolById } = await loadLib("tools");

await test("the budget follows the device's memory and only flags what is over it", () => {
  eq(memoryBudget({ deviceMemory: 8 }), 2048 * MB, "8 GB device");
  eq(memoryBudget({ deviceMemory: 0.5 }), 256 * MB, "at least 256 MB");
  eq(memoryBudget({}), 2048 * MB, "desktop without the hint");
  eq(memoryBudget({ mobile: true }), 512 * MB, "phone without the hint");
  // Two 300 MB PDFs (the acceptance case) on a desktop are no problem at all.
  eq(overBudget([{ size: 300 * MB }, { size: 300 * MB }], { deviceMemory: 8 }), null, "600 MB on 8 GB");
  eq(overBudget([{ size: 300 * MB }, { size: 300 * MB }], { mobile: true }), 600 * MB, "600 MB on a phone");
});

await test("crop, redact and OCR take several files; the server keeps its caps", () => {
  for (const id of ["crop", "redact", "ocr", "compress", "pdfToMarkdown"]) ok(toolById(id).multiple, `${id} takes several files`);
  eq(LIMITS.mb, 200, "server size cap");
});

const edit = await load("edit");
await test("crop with one box on 5 files gives 5 outputs with identical CropBoxes", async () => {
  const box = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
  const files = await Promise.all([1, 2, 3, 4, 5].map((n) => pdf([`File ${n} page 1`, `File ${n} page 2`])));
  const outs = (await Promise.all(files.map((f) => edit.crop(f, box)))).flat();
  eq(outs.length, 5, "outputs");
  const boxes = new Set();
  for (const o of outs) {
    const d = await PDFDocument.load(await bytes(o.blob));
    for (const p of d.getPages()) {
      const c = p.getCropBox();
      boxes.add([c.x, c.y, c.width, c.height].map((v) => v.toFixed(2)).join(","));
    }
  }
  eq(boxes.size, 1, "one CropBox across every page of every file");
  eq([...boxes][0], "40.00,120.00,200.00,120.00", "the box, in points");
});

const security = await load("security");
await test("a batch's searches redact every file, and the matched text is gone", async () => {
  const other = await pdf(["Write to anna@example.com today", "No address here"]);
  const out = await security.redactSearches(other, [security.PRESETS.emails, security.searchPattern("today")], { redactDpi: "150" });
  eq(out.length, 1, "one output");
  const text = await textOf(out[0].blob);
  ok(!text.includes("anna@example.com"), `email gone: ${text}`);
  ok(!/today/i.test(text), `typed search gone: ${text}`);
  ok(text.includes("Write to") && text.includes("No address here"), `the rest stays: ${text}`);
});

await test("a batch file with no match comes back unchanged in text", async () => {
  const plain = await pdf(["Nothing to hide"]);
  const out = await security.redactSearches(plain, [security.PRESETS.emails], { redactDpi: "150" });
  ok((await textOf(out[0].blob)).includes("Nothing to hide"), "text kept");
});

const { runTool } = await load("run");
await test("a batch reports each file working, done or failed, in order", async () => {
  const files = [await pdf(["One"]), new File([new Uint8Array([1, 2, 3])], "broken.pdf"), await pdf(["Three"])];
  const seen = [];
  const out = await runTool("rotate", files, { angle: "90" }, undefined, undefined, undefined, (i, state) => seen.push(`${i}:${state}`));
  eq(out.length, 2, "two outputs");
  eq(seen.join(" "), "0:work 0:done 1:work 1:fail 2:work 2:done", "states");
  eq(out[0].skipped?.[0]?.file, "broken.pdf", "the failed file is listed");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
