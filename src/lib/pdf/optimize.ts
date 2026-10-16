"use client";

import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFRef, PDFArray, PDFDict, decodePDFRawStream } from "pdf-lib";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, pdfBlob, renderPage, type Output, type Progress } from "./common";
import { loadPdf } from "./organize";
import { runQpdf } from "./qpdf";
import { VENDOR, VENDOR_VERSION } from "../vendor";
import { addInvisibleText, viewportBoxToWord, type Word } from "./textlayer";

// ── Compress: re-encode images at a sensible resolution and quality, pack objects.
const LEVELS = {
  extreme: { maxSide: 1100, quality: 0.42 },
  recommended: { maxSide: 1700, quality: 0.62 },
  light: { maxSide: 2600, quality: 0.8 },
} as const;

function num(d: PDFDict, key: string) {
  const v = d.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function filterNames(d: PDFDict) {
  const f = d.get(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.asString()];
  if (f instanceof PDFArray) return f.asArray().map((x) => String(x));
  return [];
}

export async function compress(file: File, o: { level: string }, progress?: Progress): Promise<Output[]> {
  const original = await bytesOf(file);
  const doc = await loadPdf(file, file.name);
  const { maxSide, quality } = LEVELS[o.level as keyof typeof LEVELS] ?? LEVELS.recommended;
  const ctx = doc.context;

  // Soft masks are alpha channels; JPEG artefacts there show as fringes, so leave them.
  const masks = new Set<string>();
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const m = obj.dict.get(PDFName.of("SMask"));
      if (m instanceof PDFRef) masks.add(m.toString());
    }
  }
  const images = ctx.enumerateIndirectObjects().filter(
    ([ref, obj]) =>
      obj instanceof PDFRawStream &&
      obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image") &&
      !masks.has(ref.toString()) &&
      !obj.dict.get(PDFName.of("ImageMask")) &&
      !obj.dict.get(PDFName.of("Decode")),
  ) as [PDFRef, PDFRawStream][];

  let done = 0;
  for (const [ref, stream] of images) {
    done++;
    progress?.(done, images.length);
    const d = stream.dict;
    const w = num(d, "Width");
    const h = num(d, "Height");
    const bpc = num(d, "BitsPerComponent");
    if (!w || !h || w * h < 200 * 200) continue;
    const filters = filterNames(d);
    const cs = d.get(PDFName.of("ColorSpace"));
    const csName = cs instanceof PDFName ? cs.asString() : cs instanceof PDFArray ? String(cs.get(0)) : "";
    const icc = cs instanceof PDFArray && String(cs.get(0)) === "/ICCBased" ? ctx.lookup(cs.get(1)) : undefined;
    const iccN = icc instanceof PDFRawStream ? num(icc.dict, "N") : undefined;
    const rgb = csName === "/DeviceRGB" || iccN === 3;
    const gray = csName === "/DeviceGray" || iccN === 1;
    if (!rgb && !gray) continue; // CMYK, Indexed, Lab: leave untouched

    let bitmap: ImageBitmap | null = null;
    try {
      if (filters.length === 1 && filters[0] === "/DCTDecode") {
        bitmap = await createImageBitmap(new Blob([stream.contents as BlobPart], { type: "image/jpeg" }));
      } else if (filters.every((f) => f === "/FlateDecode") && bpc === 8 && !d.get(PDFName.of("DecodeParms"))) {
        const raw = decodePDFRawStream(stream).decode();
        const ch = rgb ? 3 : 1;
        if (raw.length < w * h * ch) continue;
        const img = new ImageData(w, h);
        for (let p = 0, q = 0; p < w * h; p++, q += ch) {
          img.data[p * 4] = raw[q];
          img.data[p * 4 + 1] = raw[q + (ch === 3 ? 1 : 0)];
          img.data[p * 4 + 2] = raw[q + (ch === 3 ? 2 : 0)];
          img.data[p * 4 + 3] = 255;
        }
        bitmap = await createImageBitmap(img);
      } else continue;
    } catch {
      continue;
    }
    const s = Math.min(1, maxSide / Math.max(w, h));
    const nw = Math.max(1, Math.round(w * s));
    const nh = Math.max(1, Math.round(h * s));
    const canvas = document.createElement("canvas");
    canvas.width = nw;
    canvas.height = nh;
    const c2 = canvas.getContext("2d")!;
    c2.imageSmoothingQuality = "high";
    c2.drawImage(bitmap, 0, 0, nw, nh);
    bitmap.close();
    // Browsers only encode RGB JPEGs, so greyscale images become RGB-tagged JPEGs.
    const jpg = await bytesOf(await canvasToBlob(canvas, "image/jpeg", quality));
    canvas.width = canvas.height = 0;
    if (jpg.length >= stream.contents.length) continue;
    const nd = d.clone(ctx);
    nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
    nd.delete(PDFName.of("DecodeParms"));
    nd.set(PDFName.of("Width"), PDFNumber.of(nw));
    nd.set(PDFName.of("Height"), PDFNumber.of(nh));
    nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    nd.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB"));
    ctx.assign(ref, PDFRawStream.of(nd, jpg));
  }

  // Drop metadata bloat that viewers never show.
  doc.catalog.delete(PDFName.of("PieceInfo"));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("PieceInfo"));
    page.node.delete(PDFName.of("Thumb"));
  }
  let out = await doc.save({ useObjectStreams: true });
  // qpdf's object stream generation and stream recompression usually shaves a bit more.
  try {
    const packed = (await runQpdf(out, (i, o) => ["--object-streams=generate", "--recompress-flate", "--compression-level=9", i, o])).output;
    if (packed.length < out.length) out = packed;
  } catch {
    /* keep pdf-lib output */
  }
  const stem = baseName(file.name);
  if (out.length >= original.length) {
    return [{ name: `${stem}-compressed.pdf`, blob: pdfBlob(original), note: "notSmaller" }];
  }
  return [{ name: `${stem}-compressed.pdf`, blob: pdfBlob(out), note: `saved:${original.length}:${out.length}` }];
}

// ── Repair
export async function repair(file: File): Promise<Output[]> {
  const input = await bytesOf(file);
  const stem = baseName(file.name);
  try {
    const { output } = await runQpdf(input, (i, o) => ["--object-streams=generate", i, o]);
    await PDFDocument.load(output, { updateMetadata: false, ignoreEncryption: true });
    return [{ name: `${stem}-repaired.pdf`, blob: pdfBlob(output) }];
  } catch {
    // pdf-lib finds objects by scanning the file rather than trusting the
    // cross-reference table, so a damaged table often still rebuilds with text intact.
  }
  try {
    const doc = await PDFDocument.load(input, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
    if (doc.getPageCount() > 0) {
      const rebuilt = await doc.save({ useObjectStreams: true });
      await openPdf(rebuilt).then(closePdf);
      return [{ name: `${stem}-repaired.pdf`, blob: pdfBlob(rebuilt) }];
    }
  } catch {
    /* fall through */
  }
  {
    // Last resort: pdf.js is very forgiving. Render what it can read into a fresh PDF.
    const src = await openPdf(input);
    const out = await PDFDocument.create();
    for (let i = 1; i <= src.numPages; i++) {
      try {
        const page = await src.getPage(i);
        const v = page.getViewport({ scale: 1 });
        const canvas = await renderPage(page, 2);
        const jpg = await out.embedJpg(await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.9)));
        out.addPage([v.width, v.height]).drawImage(jpg, { x: 0, y: 0, width: v.width, height: v.height });
      } catch {
        /* unreadable page skipped */
      }
    }
    if (!out.getPageCount()) throw new Error("This file is too damaged to recover.");
    return [{ name: `${stem}-repaired.pdf`, blob: pdfBlob(await out.save()), note: "rebuilt" }];
  }
}

// ── OCR
type TessWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
type TessBlock = { paragraphs: { lines: { words: TessWord[] }[] }[] };

export async function ocr(file: File, o: { ocrLang: string; dpi: string }, progress?: Progress): Promise<Output[]> {
  const { createWorker } = await import("tesseract.js");
  const bytes = await bytesOf(file);
  const src = await openPdf(bytes);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  // Engine and language data are served from /vendor (scripts/vendor.mjs),
  // never from the tesseract.js CDN defaults. Absolute URLs: the worker
  // resolves them against its own script URL.
  const vendor = new URL(VENDOR, location.origin).href;
  const worker = await createWorker(o.ocrLang, undefined, {
    workerPath: `${vendor}tesseract/worker.min.js`,
    workerBlobURL: false,
    corePath: `${vendor}tesseract/`,
    langPath: `${vendor}tessdata`,
    // tesseract.js caches language data in IndexedDB by this path; a new
    // vendor version mustn't reuse data cached for an old one.
    cachePath: `tessdata-${VENDOR_VERSION}`,
  });
  const scale = Number(o.dpi) / 72;
  let recognised = 0;
  try {
    for (let i = 1; i <= src.numPages; i++) {
      const page = await src.getPage(i);
      // Pages that already carry real text don't need OCR.
      const existing = await page.getTextContent();
      const chars = existing.items.reduce((s, it) => s + ("str" in it ? it.str.trim().length : 0), 0);
      if (chars > 40) {
        progress?.(i, src.numPages);
        continue;
      }
      const viewport = page.getViewport({ scale });
      const canvas = await renderPage(page, scale);
      const { data } = await worker.recognize(canvas, {}, { blocks: true });
      const words: Word[] = [];
      for (const block of (data.blocks ?? []) as unknown as TessBlock[])
        for (const para of block.paragraphs)
          for (const line of para.lines)
            for (const w of line.words) {
              if (!w.text.trim() || w.confidence < 25) continue;
              words.push(viewportBoxToWord(w.text, w.bbox, (x, y) => viewport.convertToPdfPoint(x, y)));
            }
      if (words.length) recognised++;
      addInvisibleText(doc, pages[i - 1], words);
      canvas.width = canvas.height = 0;
      page.cleanup();
      progress?.(i, src.numPages);
    }
  } finally {
    await worker.terminate();
    await closePdf(src);
  }
  const note = recognised === 0 ? "ocrNone" : undefined;
  return [{ name: `${baseName(file.name)}-ocr.pdf`, blob: pdfBlob(await doc.save({ useObjectStreams: true })), note }];
}
