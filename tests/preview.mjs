// Live previews (P2-12): the marks layer a stamping tool's preview shows sits
// where the real output puts them, within 2 points: page numbers in every
// position, a watermark, a header and footer, on upright and turned pages.
//
//   node tests/preview.mjs
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import { load, openPdf, check } from "./lib/load.mjs";

globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const results = { failed: 0 };
const test = check(results);
const { markLayer, pageNumbers, watermark, headerFooter } = await load("edit");
const asFile = (bytes, name = "report.pdf") => new File([bytes], name, { type: "application/pdf" });
const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());

// Three pages; the second turned a quarter, the third landscape.
async function source() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [i, size] of [[595, 842], [595, 842], [842, 595]].entries()) {
    const p = doc.addPage(size);
    p.drawText(`Body ${i + 1}`, { x: 200, y: 300, size: 12, font });
    if (i === 1) p.setRotation(degrees(90));
  }
  return doc.save();
}

// Each text item's position as shown on the page (top-left origin, points),
// leaving out the page's own body text.
async function shown(bytes, pageIndex) {
  const pdf = await openPdf(bytes.slice());
  const page = await pdf.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const items = (await page.getTextContent()).items.filter((t) => t.str.trim() && !/^Body/.test(t.str));
  return items.map((t) => ({ str: t.str, at: vp.convertToViewportPoint(t.transform[4], t.transform[5]) }));
}

async function compare(tool, run, o, index) {
  const src = await source();
  const out = await run(asFile(src));
  const real = await shown(await bytesOf(out[0].blob), index);
  const pdf = await openPdf(src.slice());
  const view = (await pdf.getPage(index + 1)).getViewport({ scale: 1 });
  const layer = await shown(await markLayer(tool, asFile(src), o, { w: view.width, h: view.height, index, total: 3 }), 0);
  if (!real.length) throw new Error("the output has no marks on that page");
  if (real.length !== layer.length) throw new Error(`${real.length} marks in the output, ${layer.length} in the preview`);
  for (const [k, r] of real.entries()) {
    const p = layer[k];
    const d = Math.hypot(r.at[0] - p.at[0], r.at[1] - p.at[1]);
    if (r.str !== p.str || d > 2) throw new Error(`"${r.str}" at ${r.at.map(Math.round)}, preview "${p.str}" at ${p.at.map(Math.round)} (${d.toFixed(1)} pt)`);
  }
}

const numbers = (position, extra = {}) => ({
  position, numberFormat: "pageNOfTotal", startAt: 1, pageRange: "", skipFirstPages: 0, skipLastPages: 0, fontSize: 11, color: "#000000",
  facing: false, numberStyle: "1", margin: "normal", font: "helvetica", ...extra,
});
const runNumbers = (o) => (f) => pageNumbers(f, { ...o, skipFirst: o.skipFirstPages, skipLast: o.skipLastPages, labels: undefined });

for (const position of ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]) {
  for (const index of [0, 1, 2]) {
    await test(`page numbers ${position}, page ${index + 1}: preview within 2 pt of the output`, () => compare("pageNumbers", runNumbers(numbers(position)), numbers(position), index));
  }
}
await test("page numbers, facing pages and a custom template", () => {
  const o = numbers("bottom-right", { facing: true, numberFormat: "custom", template: "{page} / {pages}" });
  return compare("pageNumbers", runNumbers(o), o, 1);
});

const wm = { markType: "text", markText: "DRAFT", fontSize: 60, color: "#cc0000", imageScale: 50, position: "middle-center", mosaic: false, opacity: 100, rotation: 45, layer: "over", pageRange: "", font: "helvetica", markBox: false, tileSpacing: 100 };
for (const [position, index] of [["middle-center", 0], ["top-left", 1], ["bottom-right", 2]]) {
  await test(`watermark ${position}, page ${index + 1}: preview within 2 pt of the output`, () => {
    const o = { ...wm, position };
    return compare("watermark", (f) => watermark(f, o), o, index);
  });
}

const hf = { hfHeader: "Board pack {filename}", hfFooter: "{page} / {pages}", hfAlign: "right", pageRange: "", hfSkipFirst: 0, font: "helvetica", fontSize: 10, color: "#000000", margin: "normal" };
for (const index of [0, 1, 2]) {
  await test(`header and footer, page ${index + 1}: preview within 2 pt of the output`, () =>
    compare("headerFooter", (f) => headerFooter(f, { header: hf.hfHeader, footer: hf.hfFooter, align: hf.hfAlign, font: hf.font, fontSize: hf.fontSize, color: hf.color, margin: hf.margin, pageRange: "", skipFirst: 0 }), hf, index));
}

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
