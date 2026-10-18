"use client";

import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFRef, PDFArray, PDFDict, PDFHexString, decodePDFRawStream, type PDFObject } from "pdf-lib";
import { zlibSync } from "fflate";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, pdfBlob, pdfjs, renderPage, type Output, type Progress } from "./common";
import { loadPdf } from "./organize";
import { prepareQpdf, runQpdf } from "./qpdf";
import { PdfError } from "./errors";
import { decodeJpeg, encodeJpeg, jpegComponents, prepareJpeg } from "./jpeg";
import { asGray, palette, predictPng, resample, unpredictPng, type Pixels } from "./pixels";
import { placements } from "./placements";

// ── Compress
// Images are downsampled to a target resolution on the page (like
// Ghostscript's /ebook and /screen settings), re-encoded with MozJPEG, or kept
// lossless when they have few colours. Identical streams are stored once, and
// qpdf packs everything into compressed object streams.
const LEVELS = {
  extreme: { dpi: 72, quality: 50, maxSide: 1100 },
  recommended: { dpi: 150, quality: 70, maxSide: 1700 },
  light: { dpi: 220, quality: 82, maxSide: 2600 },
} as const;

function num(d: PDFDict, key: string) {
  const v = d.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function filterNames(d: PDFDict) {
  const f = d.lookup(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.asString()];
  if (f instanceof PDFArray) return f.asArray().map((x) => String(x));
  return [];
}

// Decoded samples of the images Compress understands: 8-bit grey or RGB,
// JPEG or Flate (with or without PNG predictors).
async function readImage(stream: PDFRawStream, w: number, h: number, ch: 1 | 3): Promise<Pixels | null> {
  const d = stream.dict;
  const filters = filterNames(d);
  if (num(d, "BitsPerComponent") !== 8 && !(filters.length === 1 && filters[0] === "/DCTDecode")) return null;
  if (filters.length === 1 && filters[0] === "/DCTDecode") {
    const comps = jpegComponents(stream.contents);
    if (comps !== ch) return null; // CMYK and odd JPEGs stay as they are
    const p = await decodeJpeg(stream.contents);
    return p.w === w && p.h === h ? { ...p, ch } : null;
  }
  if (!filters.every((f) => f === "/FlateDecode")) return null;
  const parms = d.lookup(PDFName.of("DecodeParms"));
  const predictor = parms instanceof PDFDict ? num(parms, "Predictor") ?? 1 : 1;
  // Decode without the predictor; pdf-lib doesn't undo it.
  const raw = decodePDFRawStream(stream).decode();
  let data: Uint8Array | null = raw;
  if (predictor >= 10) data = unpredictPng(raw, w * ch, ch, h);
  else if (predictor !== 1) return null;
  if (!data || data.length < w * h * ch) return null;
  return { w, h, ch, data: data.subarray(0, w * h * ch) };
}

// Points identical streams (fonts, images, colour profiles embedded more than once,
// as merged files often do) at one copy.
async function dedupe(doc: PDFDocument) {
  const ctx = doc.context;
  const byHash = new Map<string, PDFRef>();
  const replace = new Map<string, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 64) continue;
    const dict = [...obj.dict.entries()].filter(([k]) => k !== PDFName.of("Length")).map(([k, v]) => `${k} ${v}`).sort().join(" ");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", obj.contents.slice().buffer));
    const key = `${dict}|${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const first = byHash.get(key);
    if (first) replace.set(ref.toString(), first);
    else byHash.set(key, ref);
  }
  if (!replace.size) return 0;
  const swap = (o: PDFObject): PDFObject => (o instanceof PDFRef ? replace.get(o.toString()) ?? o : o);
  const visit = (o: PDFObject | undefined) => {
    if (o instanceof PDFDict) for (const [k, v] of o.entries()) { o.set(k, swap(v)); visit(v); }
    else if (o instanceof PDFArray) o.asArray().forEach((v, i) => { o.set(i, swap(v)); visit(v); });
    else if (o instanceof PDFRawStream) visit(o.dict);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);
  for (const ref of replace.keys()) ctx.delete(PDFRef.of(Number(ref.split(" ")[0]), Number(ref.split(" ")[1])));
  return replace.size;
}

export async function compress(file: File, o: { level: string }, progress?: Progress): Promise<Output[]> {
  const original = await bytesOf(file);
  const doc = await loadPdf(file, file.name);
  const { dpi, quality, maxSide } = LEVELS[o.level as keyof typeof LEVELS] ?? LEVELS.recommended;
  const ctx = doc.context;

  await dedupe(doc);
  const placed = placements(doc);

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
      !obj.dict.get(PDFName.of("Decode")) &&
      // A colour-key mask matches exact colours, which re-encoding would break.
      !(obj.dict.lookup(PDFName.of("Mask")) instanceof PDFArray),
  ) as [PDFRef, PDFRawStream][];

  let done = 0;
  for (const [ref, stream] of images) {
    progress?.(++done, images.length);
    const d = stream.dict;
    const w = num(d, "Width");
    const h = num(d, "Height");
    if (!w || !h || w * h < 64 * 64) continue;
    const cs = d.lookup(PDFName.of("ColorSpace"));
    const csName = cs instanceof PDFName ? cs.asString() : cs instanceof PDFArray ? String(cs.get(0)) : "";
    const icc = cs instanceof PDFArray && csName === "/ICCBased" ? ctx.lookup(cs.get(1)) : undefined;
    const iccN = icc instanceof PDFRawStream ? num(icc.dict, "N") : undefined;
    const ch = csName === "/DeviceRGB" || iccN === 3 ? 3 : csName === "/DeviceGray" || iccN === 1 ? 1 : 0;
    if (!ch) continue; // CMYK, Indexed, Lab, Separation: leave untouched

    let px: Pixels | null;
    try {
      px = await readImage(stream, w, h, ch);
    } catch {
      px = null;
    }
    if (!px) continue;

    // Target size from the resolution it's drawn at; images never drawn on a page fall back to a pixel cap.
    const place = placed.get(ref.toString());
    const s = place && place.w > 0 && place.h > 0
      ? Math.min(1, Math.max((place.w / 72) * dpi / w, (place.h / 72) * dpi / h))
      : Math.min(1, maxSide / Math.max(w, h));
    // Shrinking by less than a fifth costs sharpness for little gain.
    if (s < 0.8) px = resample(px, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    const gray = asGray(px);
    if (gray) px = gray;

    const wasJpeg = filterNames(d).includes("/DCTDecode");
    // Keep the ICC profile when the channel count still matches it.
    const space = iccN === px.ch ? cs! : PDFName.of(px.ch === 1 ? "DeviceGray" : "DeviceRGB");
    const candidates: { bytes: Uint8Array; set: (nd: PDFDict) => void }[] = [];

    const jpg = await encodeJpeg(px, quality);
    candidates.push({ bytes: jpg, set: (nd) => {
      nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      nd.set(PDFName.of("ColorSpace"), space);
      nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    } });

    if (!wasJpeg) {
      // Lossless options for images that were lossless: a palette, or predicted Flate.
      const pal = palette(px);
      const lossless = pal
        ? { bytes: zlibSync(predictPng(pal.data, pal.data.length / px.h, 1, px.h), { level: 9 }), bits: pal.bits, colors: px.ch, rowBytes: pal.data.length / px.h }
        : { bytes: zlibSync(predictPng(px.data, px.w * px.ch, px.ch, px.h), { level: 9 }), bits: 8, colors: px.ch, rowBytes: px.w * px.ch };
      const set = (nd: PDFDict) => {
        nd.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
        nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(lossless.bits));
        nd.set(PDFName.of("DecodeParms"), ctx.obj({ Predictor: 15, Colors: pal ? 1 : px!.ch, BitsPerComponent: lossless.bits, Columns: px!.w }));
        nd.set(PDFName.of("ColorSpace"), pal
          ? ctx.obj([PDFName.of("Indexed"), space, pal.colors.length / px!.ch - 1, PDFHexString.of([...pal.colors].map((b) => b.toString(16).padStart(2, "0")).join(""))])
          : space);
      };
      // Photos go to JPEG; graphics and text stay sharp unless JPEG is far smaller.
      if (pal || jpg.length > lossless.bytes.length * 0.5) candidates.unshift({ bytes: lossless.bytes, set });
    }

    const best = candidates[0];
    if (best.bytes.length >= stream.contents.length) continue;
    const nd = d.clone(ctx);
    nd.delete(PDFName.of("DecodeParms"));
    nd.delete(PDFName.of("Length"));
    nd.set(PDFName.of("Width"), PDFNumber.of(px.w));
    nd.set(PDFName.of("Height"), PDFNumber.of(px.h));
    best.set(nd);
    ctx.assign(ref, PDFRawStream.of(nd, best.bytes));
  }

  // Recompress plain Flate streams (fonts, page content) at the highest level.
  // qpdf's --recompress-flate would do this too but drops PNG predictors on the way.
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || obj.contents.length < 256) continue;
    const f = filterNames(obj.dict);
    if (f.length !== 1 || f[0] !== "/FlateDecode" || obj.dict.get(PDFName.of("DecodeParms"))) continue;
    try {
      const packed = zlibSync(decodePDFRawStream(obj).decode(), { level: 9 });
      if (packed.length < obj.contents.length) ctx.assign(ref, PDFRawStream.of(obj.dict, packed));
    } catch {
      /* leave streams pdf-lib can't decode */
    }
  }

  // Drop data viewers never show.
  doc.catalog.delete(PDFName.of("PieceInfo"));
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of("PieceInfo"));
    page.node.delete(PDFName.of("Thumb"));
  }
  let out = await doc.save({ useObjectStreams: true });
  // qpdf drops unreferenced objects and packs the rest into compressed object streams.
  try {
    const packed = (await runQpdf(out, (i, o) => ["--object-streams=generate", "--compression-level=9", i, o])).output;
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
    if (!out.getPageCount()) throw new PdfError("unrecoverable", file.name);
    return [{ name: `${stem}-repaired.pdf`, blob: pdfBlob(await out.save()), note: "rebuilt" }];
  }
}

// ── OCR (in ./ocr.ts)
export { ocr } from "./ocr";

// Loads the code compress and repair load as they run (src/lib/offline.ts).
export const prepare = () => Promise.all([pdfjs(), prepareJpeg(), prepareQpdf()]);
