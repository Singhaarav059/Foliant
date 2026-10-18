"use client";

import { PDFDocument, PDFName, PDFRawStream, PDFStream, PDFNumber, PDFRef, PDFArray, PDFDict, PDFHexString, PDFString, decodePDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import { Unzlib, zlibSync } from "fflate";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, pdfBlob, pdfjs, renderPage, type Output, type Progress } from "./common";
import { loadPdf } from "./organize";
import { prepareQpdf, runQpdf } from "./qpdf";
import { PdfError } from "./errors";
import { decodeJpeg, decodeJpegCmyk, encodeJpeg, jpegFrame, prepareJpeg } from "./jpeg";
import { asGray, cmykToRgb, expandPalette, invert, palette, predictPng, resample, unpack, unpredictPng, type Pixels } from "./pixels";
import { placements } from "./placements";

// ── Compress
// Images are downsampled to a target resolution on the page (like
// Ghostscript's /ebook and /screen settings), re-encoded with MozJPEG, or kept
// lossless when they have few colours. CMYK becomes sRGB except at "light".
// Identical streams are stored once, and qpdf packs everything into
// compressed object streams.
const LEVELS = {
  extreme: { dpi: 72, quality: 50, maxSide: 1100, keepCmyk: false },
  recommended: { dpi: 150, quality: 70, maxSide: 1700, keepCmyk: false },
  light: { dpi: 220, quality: 82, maxSide: 2600, keepCmyk: true },
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

// Compress never inflates more than this: an image's decoded samples, and
// any other stream it re-packs. Larger ones stay as they are, so a small file
// can't expand into gigabytes of memory.
const MAX_IMAGE_BYTES = 192 << 20;
const MAX_STREAM_BYTES = 64 << 20;

// A stream's bytes with its Flate filter undone (predictors left in place),
// or null past `limit` bytes. Unfiltered streams come back as they are.
function inflate(stream: PDFRawStream, limit: number): Uint8Array | null {
  const filters = filterNames(stream.dict);
  const bytes = stream.contents;
  if (!filters.length) return bytes.length <= limit ? bytes : null;
  if (filters.length !== 1 || filters[0] !== "/FlateDecode") return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    const z = new Unzlib((chunk) => {
      total += chunk.length;
      if (total <= limit) parts.push(chunk);
    });
    // Small steps: one step can expand at most about 1000-fold.
    const step = 1 << 14;
    for (let i = 0; i < bytes.length && total <= limit; i += step) z.push(bytes.subarray(i, i + step), i + step >= bytes.length);
  } catch {
    // Damaged or oddly wrapped data (no Adler-32 trailer, a cut-off end):
    // pdf-lib's decoder is more forgiving. Read it a step at a time, so its
    // buffer never grows much past the limit (or past what the data holds).
    const s = decodePDFRawStream(stream);
    const step = 1 << 20;
    let got = 0;
    for (let n = step; n === step; got += n) {
      n = s.getBytes(step).length;
      if (got + n > limit) return null;
    }
    s.reset();
    const v = s.getBytes(got);
    return new Uint8Array(v.buffer, v.byteOffset, v.length);
  }
  if (total > limit) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// The colour spaces Compress re-encodes: device grey, RGB and CMYK, ICC
// profiles with 1, 3 or 4 components, and palettes over any of those.
// `space` is what to write back while the channel count still matches.
type Colour = { n: 1 | 3 | 4; space: PDFObject; palette?: { hival: number; lookup: Uint8Array } };

function colourOf(ctx: PDFContext, cs: PDFObject | undefined, nested = false): Colour | null {
  if (cs instanceof PDFRef) cs = ctx.lookup(cs);
  if (cs instanceof PDFName) {
    const n = ({ "/DeviceGray": 1, "/DeviceRGB": 3, "/DeviceCMYK": 4 } as const)[cs.asString()];
    return n ? { n, space: cs } : null;
  }
  if (!(cs instanceof PDFArray)) return null;
  const kind = String(cs.get(0));
  if (kind === "/ICCBased") {
    const icc = ctx.lookup(cs.get(1));
    const n = icc instanceof PDFRawStream ? num(icc.dict, "N") : undefined;
    return n === 1 || n === 3 || n === 4 ? { n, space: cs } : null;
  }
  if (kind === "/Indexed" && !nested) {
    const base = colourOf(ctx, cs.get(1), true);
    const hival = cs.lookup(2);
    let table: PDFObject | undefined = cs.get(3);
    if (table instanceof PDFRef) table = ctx.lookup(table);
    const lookup = table instanceof PDFString || table instanceof PDFHexString ? table.asBytes()
      : table instanceof PDFRawStream ? inflate(table, 4096) : null;
    if (!base || !(hival instanceof PDFNumber) || !lookup) return null;
    return { n: base.n, space: base.space, palette: { hival: hival.asNumber(), lookup } };
  }
  return null;
}

// Decoded 8-bit samples of an image, in its base colour space (palettes
// expanded, 16-bit cut to 8, an inverted /Decode applied), or null for
// anything Compress leaves alone.
async function readImage(stream: PDFRawStream, w: number, h: number, colour: Colour): Promise<Pixels | null> {
  const d = stream.dict;
  const filters = filterNames(d);
  const bpc = num(d, "BitsPerComponent");
  const comps = colour.palette ? 1 : colour.n;

  // /Decode: the default range, or every range flipped (stored inverted).
  const decode = d.lookup(PDFName.of("Decode"));
  let inverted = false;
  if (decode instanceof PDFArray) {
    const v = decode.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : NaN));
    const top = colour.palette ? (1 << (bpc ?? 8)) - 1 : 1;
    if (v.length !== comps * 2) return null;
    const pairs = Array.from({ length: comps }, (_, i) => [v[i * 2], v[i * 2 + 1]]);
    if (pairs.every(([a, b]) => a === top && b === 0) && !colour.palette) inverted = true;
    else if (!pairs.every(([a, b]) => a === 0 && b === top)) return null;
  }

  let px: Pixels | null = null;
  if (filters.length === 1 && filters[0] === "/DCTDecode") {
    if (colour.palette || w * h * comps > MAX_IMAGE_BYTES) return null;
    // Checked before decoding: the frame, not the dictionary, sets the memory used.
    const frame = jpegFrame(stream.contents);
    if (!frame || frame.n !== comps || frame.w !== w || frame.h !== h) return null;
    const n = frame.n;
    px = n === 4 ? await decodeJpegCmyk(stream.contents) : await decodeJpeg(stream.contents);
    if (!px || px.w !== w || px.h !== h) return null;
    if (n === 1 || n === 3) px = { ...px, ch: n };
  } else {
    // 8- and 16-bit samples; palettes also at 1, 2 and 4 bits.
    if (!bpc || !(colour.palette ? [1, 2, 4, 8] : [8, 16]).includes(bpc)) return null;
    const rowBytes = Math.ceil((w * comps * bpc) / 8);
    if (rowBytes * h > MAX_IMAGE_BYTES) return null;
    const parms = d.lookup(PDFName.of("DecodeParms"));
    const predictor = parms instanceof PDFDict ? num(parms, "Predictor") ?? 1 : 1;
    // PNG predictors add a filter byte to each row; some writers pad the end.
    const raw = inflate(stream, (rowBytes + 1) * h + 4096);
    if (!raw) return null;
    const data = predictor >= 10 ? unpredictPng(raw, rowBytes, Math.max(1, Math.ceil((comps * bpc) / 8)), h) : predictor === 1 ? raw : null;
    const samples = data && unpack(data, w, h, comps, bpc, Boolean(colour.palette));
    if (!samples) return null;
    px = colour.palette ? expandPalette(samples, w, h, colour.palette.lookup, colour.n) : { w, h, ch: colour.n, data: samples };
  }
  return inverted ? invert(px) : px;
}

// Drops objects nothing reaches from the trailer (left over from edits, or
// planted as a decompression bomb) before anything is hashed or inflated.
function dropUnreachable(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const todo: (PDFObject | undefined)[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (todo.length) {
    const o = todo.pop();
    if (o instanceof PDFRef) {
      if (seen.has(o.toString())) continue;
      seen.add(o.toString());
      todo.push(ctx.lookup(o));
    } else {
      // One push per entry: spreading a 150k-entry array overflows the stack.
      const kids = o instanceof PDFDict ? o.values() : o instanceof PDFArray ? o.asArray() : o instanceof PDFStream ? o.dict.values() : [];
      for (const k of kids) todo.push(k);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.toString())) ctx.delete(ref);
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
  const { dpi, quality, maxSide, keepCmyk } = LEVELS[o.level as keyof typeof LEVELS] ?? LEVELS.recommended;
  const ctx = doc.context;

  dropUnreachable(doc);
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
    const colour = colourOf(ctx, d.get(PDFName.of("ColorSpace")));
    if (!colour) continue; // Lab, Separation, DeviceN, CalRGB: leave untouched

    let px: Pixels | null;
    try {
      px = await readImage(stream, w, h, colour);
    } catch {
      px = null;
    }
    if (!px) continue;
    if (px.ch === 4 && !keepCmyk) px = cmykToRgb(px);

    // Target size from the resolution it's drawn at; images never drawn on a page fall back to a pixel cap.
    const place = placed.get(ref.toString());
    const s = place && place.w > 0 && place.h > 0
      ? Math.min(1, Math.max((place.w / 72) * dpi / w, (place.h / 72) * dpi / h))
      : Math.min(1, maxSide / Math.max(w, h));
    // Shrinking by less than a fifth costs sharpness for little gain.
    if (s < 0.8) px = resample(px, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    const gray = asGray(px);
    if (gray) px = gray;
    const out: Pixels = px;

    const wasJpeg = filterNames(d).includes("/DCTDecode");
    // Keep the ICC profile (or device space) when the channel count still matches it.
    const space = colour.n === out.ch ? colour.space : PDFName.of(out.ch === 1 ? "DeviceGray" : out.ch === 3 ? "DeviceRGB" : "DeviceCMYK");
    const candidates: { bytes: Uint8Array; set: (nd: PDFDict) => void }[] = [];

    // MozJPEG writes grey and RGB only; CMYK kept at "light" stays lossless.
    const jpg = out.ch === 4 ? null : await encodeJpeg({ ...out, ch: out.ch }, quality);
    if (jpg) candidates.push({ bytes: jpg, set: (nd) => {
      nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      nd.set(PDFName.of("ColorSpace"), space);
      nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
    } });

    if (!wasJpeg) {
      // Lossless options for images that were lossless: a palette, or predicted Flate.
      const pal = palette(out);
      const lossless = pal
        ? { bytes: zlibSync(predictPng(pal.data, pal.data.length / out.h, 1, out.h), { level: 9 }), bits: pal.bits }
        : { bytes: zlibSync(predictPng(out.data, out.w * out.ch, out.ch, out.h), { level: 9 }), bits: 8 };
      const set = (nd: PDFDict) => {
        nd.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
        nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(lossless.bits));
        nd.set(PDFName.of("DecodeParms"), ctx.obj({ Predictor: 15, Colors: pal ? 1 : out.ch, BitsPerComponent: lossless.bits, Columns: out.w }));
        nd.set(PDFName.of("ColorSpace"), pal
          ? ctx.obj([PDFName.of("Indexed"), space, pal.colors.length / out.ch - 1, PDFHexString.of([...pal.colors].map((b) => b.toString(16).padStart(2, "0")).join(""))])
          : space);
      };
      // Photos go to JPEG; graphics and text stay sharp unless JPEG is far smaller.
      if (!jpg || pal || jpg.length > lossless.bytes.length * 0.5) candidates.unshift({ bytes: lossless.bytes, set });
    }

    const best = candidates[0];
    if (!best || best.bytes.length >= stream.contents.length) continue;
    const nd = d.clone(ctx);
    nd.delete(PDFName.of("DecodeParms"));
    nd.delete(PDFName.of("Decode"));
    nd.delete(PDFName.of("Length"));
    nd.set(PDFName.of("Width"), PDFNumber.of(out.w));
    nd.set(PDFName.of("Height"), PDFNumber.of(out.h));
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
      const plain = inflate(obj, MAX_STREAM_BYTES);
      const packed = plain && zlibSync(plain, { level: 9 });
      if (packed && packed.length < obj.contents.length) ctx.assign(ref, PDFRawStream.of(obj.dict, packed));
    } catch {
      /* leave streams that can't be decoded */
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
