// Auto-OCR in PDF to Word, Excel, PowerPoint and Markdown: scanned pages are
// read with OCR before converting, with the tools' default options, so the
// result has their words. Pages with text aren't read again, and OCR set to
// off leaves a scan as it is. Runs the tools as the workspace does (runTool),
// with Tesseract reading the vendored models from disk.
//
//   node tests/auto-ocr.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { createWorker, createScheduler } from "tesseract.js";
import { root, vendorDir, load, openPdf, check, eq, nodeCanvas } from "./lib/load.mjs";

nodeCanvas();
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
// PDF to PowerPoint reads slide pictures with a FileReader, which Node lacks.
globalThis.FileReader ??= class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`;
      this.onload?.();
    }, (e) => { this.error = e; this.onerror?.(); });
  }
};
const results = { failed: 0 };
const test = check(results);
const { TOOLS, defaultOptions, optionVisible } = await load("../tools");
const { runTool } = await load("run");
const { ocr, engine } = await load("ocr");
const { grayPng } = await load("ocrprep");

// Tesseract from disk; `asked` records each language set it was started with.
const cache = mkdtempSync(join(tmpdir(), "tess-"));
const asked = [];
engine.create = async (lang) => {
  asked.push(lang);
  const scheduler = createScheduler();
  scheduler.addWorker(await createWorker(lang, undefined, { langPath: join(vendorDir, "tessdata"), cachePath: cache }));
  return {
    recognise: async (image) => (await scheduler.addJob("recognize", Buffer.from(grayPng(image)), {}, { blocks: true })).data,
    stop: () => scheduler.terminate(),
  };
};

const fixture = (name) => new File([readFileSync(join(root, "tests/fixtures", name))], name);
const SCANNED = "Scanned invoice 4471 Total due: 1,250.00 EUR";
const options = (id, extra = {}) => ({ ...defaultOptions(TOOLS.find((t) => t.id === id)), ...extra });
const run = async (id, file, extra) => (await runTool(id, [file], options(id, extra)))[0];

// The text each format holds.
const unzip = async (blob) => JSZip.loadAsync(await blob.arrayBuffer());
const xmlText = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, "g"))].map((m) => m[1]).join(" ");
const textOf = {
  pdfToWord: async (b) => xmlText(await (await unzip(b)).file("word/document.xml").async("string"), "w:t"),
  pdfToExcel: async (b) => xmlText((await (await unzip(b)).file("xl/sharedStrings.xml")?.async("string")) ?? "", "t"),
  pdfToPpt: async (b) => {
    const zip = await unzip(b);
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    return (await Promise.all(slides.map(async (f) => xmlText(await zip.file(f).async("string"), "a:t")))).join(" ");
  },
  pdfToMarkdown: async (b) => b.text(),
};
const pdfText = async (blob) => {
  const doc = await openPdf(new Uint8Array(await blob.arrayBuffer()));
  return (await (await doc.getPage(1)).getTextContent()).items.map((t) => t.str).join(" ");
};

// Character error rate after folding spaces (and Markdown's table and emphasis marks).
const norm = (s) => s.replace(/[|*#_-]{2,}|[|*#]/g, " ").replace(/\s+/g, " ").trim();
function cer(ref, hyp) {
  const a = [...norm(ref)], b = [...norm(hyp)];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;

const IDS = ["pdfToWord", "pdfToExcel", "pdfToPpt", "pdfToMarkdown"];

await test("each conversion offers OCR, automatic by default, with the language picker", () => {
  for (const id of IDS) {
    const tool = TOOLS.find((t) => t.id === id);
    const o = defaultOptions(tool);
    eq(o.ocr, "auto", `${id} ocr`);
    eq(o.ocrLang, "eng", `${id} ocrLang`);
    const lang = tool.options.find((d) => d.key === "ocrLang");
    eq(lang?.type, "multi", `${id} language picker`);
    eq(optionVisible(lang, { ...o, ocr: "off" }), false, `${id} picker hidden with OCR off`);
  }
});

// The OCR tool's own reading of the scan, the bar the conversions must meet.
const [ocrOut] = await ocr(fixture("scanned.pdf"), { ocrLang: "eng", dpi: "200" });
const toolCer = cer(SCANNED, await pdfText(ocrOut.blob));
console.log(`      OCR tool CER on scanned.pdf: ${pct(toolCer)}`);


for (const id of IDS) {
  await test(`${id}: a scan comes out with its words, as well read as by the OCR tool`, async () => {
    const out = await run(id, fixture("scanned.pdf"));
    const text = await textOf[id](out.blob);
    const c = cer(SCANNED, text);
    console.log(`      ${text.replace(/\s+/g, " ").trim().length} characters, CER ${pct(c)}, note ${out.note}`);
    if (!/4471/.test(text) || !/1,250\.00/.test(text)) throw new Error(`text was "${text.slice(0, 80)}"`);
    if (c > toolCer + 1e-9) throw new Error(`CER ${pct(c)}, OCR tool ${pct(toolCer)}`);
    eq(out.note, "ocrUsed", "note");
  });
}

await test("pdfToWord: a full scanned page gives well over 50 characters", async () => {
  const out = await run("pdfToWord", fixture("mixed-script.pdf"), { ocrLang: "eng+hin" });
  const text = await textOf.pdfToWord(out.blob);
  const chars = text.replace(/\s+/g, "").length;
  if (chars <= 50) throw new Error(`${chars} characters`);
  if (!/ration card/.test(text.replace(/\s+/g, " ")) || !/राशन/.test(text)) throw new Error(`text was "${text.slice(0, 80)}"`);
  console.log(`      ${chars} characters, English and Hindi`);
});

await test("pdfToExcel: shared strings from the scan", async () => {
  const zip = await unzip((await run("pdfToExcel", fixture("scanned.pdf"))).blob);
  const n = Number((await zip.file("xl/sharedStrings.xml")?.async("string"))?.match(/uniqueCount="(\d+)"/)?.[1] ?? 0);
  if (n <= 0) throw new Error(`${n} shared strings`);
  return n;
});

await test("OCR off leaves a scan without text, and starts no OCR", async () => {
  asked.length = 0;
  const out = await run("pdfToWord", fixture("scanned.pdf"), { ocr: "off" });
  eq((await textOf.pdfToWord(out.blob)).trim(), "", "text");
  eq(asked.length, 0, "OCR runs");
  eq(out.note, undefined, "note");
});

await test("a PDF with text isn't read again", async () => {
  asked.length = 0;
  const out = await run("pdfToWord", fixture("report.pdf"));
  eq(asked.length, 0, "OCR runs");
  eq(out.note, undefined, "note");
});

await test("the picked languages are the ones OCR reads in", async () => {
  asked.length = 0;
  await run("pdfToMarkdown", fixture("scanned.pdf"), { ocrLang: "eng+deu" });
  eq(asked.join(), "eng+deu", "languages");
});

process.exit(results.failed ? 1 : 0);
