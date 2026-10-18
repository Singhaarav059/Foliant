"use client";

// OCR: makes scanned pages searchable. Pages are rendered, cleaned up
// (ocrprep.ts), and read by a pool of Tesseract workers in parallel; the words
// go back onto the original page as invisible text, rotated to match the scan.

import { PDFDocument, degrees } from "pdf-lib";
import type { PageViewport } from "pdfjs-dist";
import { baseName, bytesOf, closePdf, openPdf, pdfBlob, pdfjs, renderPage, type Output, type Progress } from "./common";
import { VENDOR, VENDOR_VERSION } from "../vendor";
import { addInvisibleText, type Word } from "./textlayer";
import { PADDLE_LANGS, paddlePage } from "./paddle";
import { OCR_LANGS } from "../tools";
import { ocrLangs } from "../ocr-langs";
import { deskew, estimateSkew, flattenBackground, grayOf, grayPng, looksSideways, median3, noiseLevel, rotate90, unmapper, type Gray, type Unmap } from "./ocrprep";

// Noise level (grey levels, Immerkær) above which a page gets a median filter.
const NOISY = 4;

type Box = { x0: number; y0: number; x1: number; y1: number };
type TessWord = { text: string; confidence: number; bbox: Box };
type TessLine = { words: TessWord[]; baseline?: Box & { has_baseline?: boolean } };
// `found`: the text lines PaddleOCR detected, read or not (Tesseract doesn't say).
type TessPage = { confidence: number; blocks: { paragraphs: { lines: TessLine[] }[] }[] | null; found?: number };
export type Recognise = (image: Gray) => Promise<TessPage>;

// Tests replace this with workers that read language data from disk.
export const engine = {
  async create(lang: string, count: number): Promise<{ recognise: Recognise; stop: () => Promise<void> }> {
    const { createWorker, createScheduler } = await import("tesseract.js");
    // Engine and language data are served from /vendor (scripts/vendor.mjs),
    // never from the tesseract.js CDN defaults. Absolute URLs: the worker
    // resolves them against its own script URL.
    const vendor = new URL(VENDOR, location.origin).href;
    const scheduler = createScheduler();
    const workers = await Promise.all(Array.from({ length: count }, () => createWorker(lang, undefined, {
      workerPath: `${vendor}tesseract/worker.min.js`,
      workerBlobURL: false,
      corePath: `${vendor}tesseract/`,
      langPath: `${vendor}tessdata`,
      // tesseract.js caches language data in IndexedDB by this path; a new
      // vendor version mustn't reuse data cached for an old one.
      cachePath: `tessdata-${VENDOR_VERSION}`,
    })));
    for (const w of workers) scheduler.addWorker(w);
    return {
      recognise: async (image) =>
        (await scheduler.addJob("recognize", new Blob([grayPng(image) as BlobPart], { type: "image/png" }), {}, { blocks: true })).data as unknown as TessPage,
      stop: () => scheduler.terminate(),
    };
  },
};

// Mean word confidence weighted by length: one guess per page orientation.
function score(page: TessPage) {
  let sum = 0, n = 0;
  for (const b of page.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
    const len = w.text.trim().length;
    sum += w.confidence * len;
    n += len;
  }
  return n ? sum / n : 0;
}

const wordCount = (page: TessPage) =>
  (page.blocks ?? []).reduce((n, b) => n + b.paragraphs.reduce((m, p) => m + p.lines.reduce((k, l) => k + l.words.length, 0), 0), 0);

// Reads one rendered page. Returns words as corner points in the original
// image (baseline start, baseline end, top of the start), the clockwise
// quarter turns that make the page upright, and whether the reading is doubtful.
export async function readPage(recognise: Recognise, image: Gray) {
  // Speckle (phone photos, fax-grade scans) first, before flattening the background amplifies it.
  const clean = flattenBackground(noiseLevel(image) > NOISY ? median3(image) : image);
  const thin = (0.3 * Math.PI) / 180; // below a third of a degree, resampling costs more than it gains
  // Try the likeliest orientation first; upside-down or sideways text reads as
  // low-confidence noise, so keep turning until a reading is confident.
  const first = looksSideways(clean) ? 1 : 0;
  let best: { page: TessPage; score: number; turns: number; skew: number } | null = null;
  for (const turns of [first, first + 2, 1 - first, 3 - first]) {
    let g = rotate90(clean, turns);
    const found = estimateSkew(g);
    const skew = Math.abs(found) > thin ? found : 0;
    if (skew) g = deskew(g, skew);
    const page = await recognise(g);
    const s = score(page);
    const n = wordCount(page);
    if (!best || s > best.score) best = { page, score: s, turns: turns % 4, skew };
    // Confident, or almost nothing to read (a photo, a blank page): stop turning.
    // Lines PaddleOCR finds but can't read at all are text on its side: keep turning.
    if (s >= 60 || (n < 3 && !(n === 0 && page.found))) break;
  }
  const { page, turns, skew } = best!;
  const unmap: Unmap = unmapper(image, turns, skew);
  // A doubtful page (a poor scan, a photo) keeps only the words read with confidence.
  const doubtful = best!.score < 45;
  const floor = doubtful ? 70 : 25;

  const words: { text: string; corners: [number, number][] }[] = [];
  for (const block of page.blocks ?? [])
    for (const para of block.paragraphs)
      for (const line of para.lines) {
        const b = line.baseline;
        const base = (x: number, fallback: number) =>
          b && b.has_baseline !== false && b.x1 !== b.x0 ? b.y0 + ((b.y1 - b.y0) * (x - b.x0)) / (b.x1 - b.x0) : fallback;
        for (const w of line.words) {
          if (!w.text.trim() || w.confidence < floor) continue;
          const { x0, y0, x1, y1 } = w.bbox;
          words.push({ text: w.text, corners: [unmap(x0, base(x0, y1)), unmap(x1, base(x1, y1)), unmap(x0, y0)] });
        }
      }
  return { words, turns, skew, confidence: best!.score, doubtful: doubtful && words.length > 0 };
}

export function toWord(text: string, corners: [number, number][], viewport: PageViewport): Word {
  const [[ax, ay], [bx, by], [cx, cy]] = corners.map(([x, y]) => viewport.convertToPdfPoint(x, y));
  return { text, x: ax, y: ay, width: Math.hypot(bx - ax, by - ay), height: Math.hypot(cx - ax, cy - ay), angle: Math.atan2(by - ay, bx - ax) };
}

type OcrOptions = { ocrLang: string; dpi: string; ocrEngine?: string };

export async function ocr(file: File, o: OcrOptions, progress?: Progress): Promise<Output[]> {
  const r = await textLayer(await bytesOf(file), o, false, progress);
  return [{ name: `${baseName(file.name)}-ocr.pdf`, blob: pdfBlob(r.bytes), note: r.note }];
}

// For PDF to Word, Excel, PowerPoint and Markdown: scanned pages get the OCR
// tool's invisible text layer first, so the conversion finds their words.
// Only pages that are pictures of text are read: little or no text (as in
// ocr()) and an image on them. A PDF without such pages comes back as it was,
// and Tesseract isn't loaded. `note` says how the reading went.
export async function autoOcr(file: File, o: { ocrLang: string }, progress?: Progress): Promise<{ file: File; pages: number; note?: string }> {
  const r = await textLayer(await bytesOf(file), { ocrLang: o.ocrLang, dpi: "200" }, true, progress);
  if (!r.pages) return { file, pages: 0 };
  return { file: new File([r.bytes as BlobPart], file.name, { type: "application/pdf" }), pages: r.pages, note: r.note ?? "ocrUsed" };
}

const IMAGE_OPS = ["paintImageXObject", "paintInlineImageXObject", "paintImageXObjectRepeat", "paintInlineImageXObjectGroup", "paintImageMaskXObject"] as const;

async function textLayer(bytes: Uint8Array, o: OcrOptions, scansOnly: boolean, progress?: Progress) {
  const src = await openPdf(bytes);
  const { OPS } = await pdfjs();
  const images = new Set<number>(IMAGE_OPS.map((k) => OPS[k]));

  // Pages that already carry real text don't need OCR.
  const todo: number[] = [];
  for (let i = 1; i <= src.numPages; i++) {
    const page = await src.getPage(i);
    const existing = await page.getTextContent();
    const chars = existing.items.reduce((s, it) => s + ("str" in it ? it.str.trim().length : 0), 0);
    if (chars <= 40 && (!scansOnly || (await page.getOperatorList()).fnArray.some((fn) => images.has(fn)))) todo.push(i);
  }
  if (scansOnly && !todo.length) {
    await closePdf(src);
    return { bytes, pages: 0 };
  }
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const scale = Number(o.dpi) / 72;

  // One worker per two cores, up to four: each holds its own copy of the language model.
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  // One or more languages, "eng+hin", as Tesseract takes them.
  const lang = ocrLangs(o.ocrLang, OCR_LANGS).join("+");
  // High accuracy (PaddleOCR) reads one page at a time; it only covers some languages, one at a time.
  const accurate = o.ocrEngine === "accurate" && PADDLE_LANGS.includes(lang);
  const count = accurate ? 1 : Math.max(1, Math.min(4, Math.floor(cores / 2), todo.length));
  let recognised = 0;
  let doubtfulPages = 0;
  let done = src.numPages - todo.length;
  progress?.(done, src.numPages);
  const ocrEngine = !todo.length ? null : accurate ? { recognise: paddlePage as Recognise, stop: async () => {} } : await engine.create(lang, count);
  try {
    // Render the next page while the workers read the last ones, holding at most count + 1 pages.
    let next = 0;
    await Promise.all(Array.from({ length: count + 1 }, async () => {
      while (next < todo.length) {
        const i = todo[next++];
        const page = await src.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = await renderPage(page, scale);
        const image = grayOf(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height));
        canvas.width = canvas.height = 0;
        page.cleanup();
        const { words, turns, confidence, doubtful } = await readPage(ocrEngine!.recognise, image);
        if (words.length) recognised++;
        if (doubtful) doubtfulPages++;
        addInvisibleText(doc, pages[i - 1], words.map((w) => toWord(w.text, w.corners, viewport)));
        // Scanned sideways or upside down: turn the page so it displays (and reads) upright.
        if (turns && confidence >= 60) pages[i - 1].setRotation(degrees((pages[i - 1].getRotation().angle + turns * 90) % 360));
        progress?.(++done, src.numPages);
      }
    }));
  } finally {
    await ocrEngine?.stop();
    await closePdf(src);
  }
  const note = recognised === 0 ? "ocrNone" : doubtfulPages ? "ocrDoubtful" : undefined;
  return { bytes: await doc.save({ useObjectStreams: true }), pages: todo.length, note };
}
