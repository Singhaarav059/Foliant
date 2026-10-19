"use client";

import {
  PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, degrees, BlendMode, PDFArray, PDFName,
  PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFTextField, PDFOptionList,
  PDFHexString, PDFOperator, PDFOperatorNames as Ops, PDFRawStream, decodePDFRawStream,
} from "pdf-lib";
import { baseName, hexToRgb, isWinAnsi, normaliseImage, pageSet, pdfBlob, textToPng, type Output } from "./common";
import { loadPdf } from "./organize";
import { PdfError } from "./errors";
import { FAMILIES, fontCovering, layoutText, type Family, type LaidOut } from "./fonts";

// ── Visual ↔ user space
// Users place things on the page as they see it. A page may carry /Rotate and
// a CropBox that doesn't start at 0,0, so every placement goes through here.

// The part of the page that is seen, built the way pdf.js builds its view (and
// so the editor's): each box normalised, since a rectangle may name any two
// opposite corners; the CropBox clipped to the MediaBox; the MediaBox alone
// when they don't overlap, and US Letter when the MediaBox is empty.
export function viewBox(page: PDFPage) {
  const norm = (r: { x: number; y: number; width: number; height: number }) => ({
    x0: Math.min(r.x, r.x + r.width), y0: Math.min(r.y, r.y + r.height),
    x1: Math.max(r.x, r.x + r.width), y1: Math.max(r.y, r.y + r.height),
  });
  let media = norm(page.getMediaBox());
  if (media.x1 - media.x0 <= 0 || media.y1 - media.y0 <= 0) media = { x0: 0, y0: 0, x1: 612, y1: 792 };
  const crop = norm(page.getCropBox());
  const x0 = Math.max(crop.x0, media.x0), y0 = Math.max(crop.y0, media.y0);
  const x1 = Math.min(crop.x1, media.x1), y1 = Math.min(crop.y1, media.y1);
  const b = x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : media;
  return { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 };
}

export function visualFrame(page: PDFPage) {
  const box = viewBox(page);
  // Like pdf.js, a /Rotate that isn't a multiple of 90 counts as none.
  const angle = page.getRotation().angle;
  const r = angle % 90 ? 0 : ((angle % 360) + 360) % 360;
  const swap = r === 90 || r === 270;
  const vw = swap ? box.height : box.width;
  const vh = swap ? box.width : box.height;
  // (vx, vy) is in points from the visual bottom-left.
  const map = (vx: number, vy: number): [number, number] => {
    switch (r) {
      case 90: return [box.x + box.width - vy, box.y + vx];
      case 180: return [box.x + box.width - vx, box.y + box.height - vy];
      case 270: return [box.x + vy, box.y + box.height - vx];
      default: return [box.x + vx, box.y + vy];
    }
  };
  return { vw, vh, map, rot: r };
}

// pdf-lib appends drawing after the page's own content without restoring the
// graphics state, so a page that leaves a transform open would shift whatever
// we draw. Wrap the original content in q…Q once before drawing on it.
// Content that stops inside an inline image's data (BI … ID with no EI) would
// swallow everything after it, so that image is closed first.
const isolated = new WeakSet<PDFPage>();
export function isolate(page: PDFPage) {
  if (isolated.has(page)) return;
  isolated.add(page);
  const ctx = page.doc.context;
  const close = endsInInlineImage(page) ? "\nEI\nQ" : "Q";
  // A lone content stream becomes an array first; only an array can be wrapped.
  page.node.normalize();
  page.node.wrapContentStreams(ctx.register(ctx.stream("q")), ctx.register(ctx.stream(close)));
}

// The page's content, decoded and joined the way readers join it. A stream
// that can't be decoded is left out: readers draw nothing from it either.
function endsInInlineImage(page: PDFPage) {
  const c = page.node.Contents();
  const refs = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
  const parts: Uint8Array[] = [];
  for (const ref of refs) {
    const s = page.doc.context.lookup(ref);
    if (!(s instanceof PDFRawStream)) continue;
    try {
      parts.push(decodePDFRawStream(s).decode(), new Uint8Array([10]));
    } catch {
      // Unreadable.
    }
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) all.set(p, (at += p.length) - p.length);
  return unterminatedInlineImage(all);
}

// Tokenises content just enough to skip strings, names, comments and inline
// image data; true when the last inline image has no EI.
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...Array.from("()<>[]{}/%")].map((c) => c.charCodeAt(0)));
export function unterminatedInlineImage(b: Uint8Array) {
  const n = b.length;
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && b[i] !== 10 && b[i] !== 13) i++; continue; } // %
    if (c === 0x28) { // ( string ), nested, with escapes
      let depth = 0;
      for (; i < n; i++) {
        if (b[i] === 0x5c) i++;
        else if (b[i] === 0x28) depth++;
        else if (b[i] === 0x29 && --depth === 0) { i++; break; }
      }
      continue;
    }
    if (c === 0x3c && b[i + 1] === 0x3c) { i += 2; continue; } // <<
    if (c === 0x3c) { while (i < n && b[i] !== 0x3e) i++; i++; continue; } // <hex>
    if (DELIM.has(c)) { i++; if (c === 0x2f) while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++; continue; }
    const start = i;
    while (i < n && !WS.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i - start === 2 && b[start] === 0x49 && b[start + 1] === 0x44) { // ID
      // Data starts after one white-space byte and ends at white space, "EI", then white space or the end.
      let j = i + 1;
      for (; j + 1 < n; j++) {
        if (b[j] === 0x45 && b[j + 1] === 0x49 && WS.has(b[j - 1]) && (j + 2 === n || WS.has(b[j + 2]) || DELIM.has(b[j + 2]))) break;
      }
      if (j + 1 >= n) return true;
      i = j + 2;
    }
  }
  return false;
}

async function save(doc: PDFDocument) {
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

// ── Text helpers. Helvetica (not embedded) when it can encode the text, or
// the chosen bundled family; Noto for other scripts; and an image of the text
// as a last resort (no bundled glyph, or the fonts couldn't be fetched).
export type FontChoice = "helvetica" | Family | "noto";
const fontChoice = (v: unknown): FontChoice =>
  v === "noto" || FAMILIES.includes(v as Family) ? (v as FontChoice) : "helvetica";

const standard = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();
function standardFont(doc: PDFDocument, name: StandardFonts) {
  let m = standard.get(doc);
  if (!m) standard.set(doc, (m = new Map()));
  let p = m.get(name);
  if (!p) m.set(name, (p = doc.embedFont(name)));
  return p;
}

// The standard font closest to each family, for when its file can't be fetched.
const FALLBACK: Record<FontChoice, [StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  arimo: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  noto: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  tinos: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  cousine: [StandardFonts.Courier, StandardFonts.CourierBold],
};

async function textLine(doc: PDFDocument, family: FontChoice, text: string, size: number, bold = false): Promise<LaidOut | null> {
  const plain = async () => {
    const font = await standardFont(doc, FALLBACK[family][bold ? 1 : 0]);
    return { width: font.widthOfTextAtSize(text, size), runs: [{ font, text, x: 0 }] };
  };
  if (family === "helvetica" && isWinAnsi(text)) return plain();
  if (text.includes("\n")) return null;
  const laid = await layoutText(doc, text, size, bold, family === "helvetica" || family === "noto" ? undefined : family).catch(() => null);
  return laid ?? (isWinAnsi(text) ? plain() : null);
}

// Text drawn in pieces (a run per font, or an image) is wrapped in a span
// whose /ActualText is the whole string, so readers that honour it extract
// and search it as one word.
function asOneString(page: PDFPage, text: string, pieces: number, draw: () => void) {
  if (pieces < 2 && !/[^\x20-\x7e]/.test(text)) return draw();
  page.pushOperators(PDFOperator.of(Ops.BeginMarkedContentSequence, [PDFName.of("Span"), `<< /ActualText ${PDFHexString.fromText(text).toString()} >>`]));
  draw();
  page.pushOperators(PDFOperator.of(Ops.EndMarkedContent));
}

async function drawLabel(
  doc: PDFDocument, page: PDFPage, family: FontChoice, text: string,
  o: {
    vx: number; vy: number; size: number; color: string; anchor: "left" | "center" | "right"; opacity?: number; angle?: number; bold?: boolean;
    // Wider text is drawn smaller to fit.
    maxWidth?: number;
  },
) {
  isolate(page);
  const f = visualFrame(page);
  const c = hexToRgb(o.color);
  const extra = o.angle ?? 0;
  const a = (extra * Math.PI) / 180;
  const fit = (width: number) => (o.maxWidth && width > o.maxWidth ? o.maxWidth / width : 1);
  const line = await textLine(doc, family, text, o.size, o.bold);
  if (line) {
    const k = fit(line.width);
    const size = o.size * k, width = line.width * k;
    const dx = o.anchor === "center" ? -width / 2 : o.anchor === "right" ? -width : 0;
    // Offset along the rotated baseline so rotated labels stay anchored.
    asOneString(page, text, line.runs.length, () => {
      for (const run of line.runs) {
        const [x, y] = f.map(o.vx + (dx + run.x * k) * Math.cos(a), o.vy + (dx + run.x * k) * Math.sin(a));
        page.drawText(run.text, { x, y, size, font: run.font, color: rgb(c.r, c.g, c.b), opacity: o.opacity ?? 1, rotate: degrees(f.rot + extra) });
      }
    });
    return { width, height: size };
  }
  const img = await textToPng(text, o.size, o.color, `${o.bold ? 700 : 500} {s}px system-ui, sans-serif`);
  const png = await doc.embedPng(img.png);
  const k = fit(img.width);
  const w = img.width * k, h = img.height * k;
  const dx = o.anchor === "center" ? -w / 2 : o.anchor === "right" ? -w : 0;
  const [x, y] = f.map(o.vx + dx * Math.cos(a) + h * 0.2 * Math.sin(a), o.vy + dx * Math.sin(a) - h * 0.2 * Math.cos(a));
  asOneString(page, text, 1, () => page.drawImage(png, { x, y, width: w, height: h, opacity: o.opacity ?? 1, rotate: degrees(f.rot + extra) }));
  return { width: w, height: h };
}

// ── Numbers in a style: 1, i, I, a, A. Roman numerals stop at 3999 and
// letters at 0; beyond those the number is written in digits.
export function formatNumber(n: number, style: string) {
  if ((style === "i" || style === "I") && n >= 1 && n < 4000) {
    const parts: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
    let out = "";
    for (const [v, s] of parts) while (n >= v) { out += s; n -= v; }
    return style === "i" ? out.toLowerCase() : out;
  }
  if ((style === "a" || style === "A") && n >= 1) {
    // a…z, aa…az, ba…
    let out = "";
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
    return style === "A" ? out.toUpperCase() : out;
  }
  return String(n);
}

// {filename} and {date} in user text; {date} is the local date as YYYY-MM-DD.
function fillVariables(text: string, file: File) {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return text.replaceAll("{filename}", baseName(file.name)).replaceAll("{date}", date);
}

const MARGINS: Record<string, [number, number]> = { small: [9, 0.025], normal: [18, 0.045], large: [36, 0.08] };

// ── Page numbers
export async function pageNumbers(
  file: File,
  o: {
    position: string; numberFormat: string; startAt: number; pageRange: string;
    // Pages left unnumbered at each end (true means 1, as the old toggle did).
    skipFirst: number | boolean; skipLast?: number;
    fontSize: number; color: string; facing: boolean;
    // Custom: {page} and {pages}, plus {filename} and {date}.
    template?: string; numberStyle?: string; margin?: string; font?: string;
    // Bates: prefix and a zero-padded counter. Pass the same counter to every
    // file of a batch so the numbers run on.
    batesPrefix?: string; batesDigits?: number; counter?: { next: number };
    // Translated templates: "Page {n}", "Page {n} of {total}", "{n} of {total}".
    labels?: { page: string; pageOf: string; nOf: string };
  },
): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const family = fontChoice(o.font);
  const pages = doc.getPages();
  const total = pages.length;
  const chosen = pageSet(o.pageRange, total);
  const skipFirst = o.skipFirst === true ? 1 : Math.max(0, Number(o.skipFirst) || 0);
  const skipLast = Math.max(0, Number(o.skipLast) || 0);
  const numbered = [...chosen].filter((i) => i >= skipFirst && i < total - skipLast).sort((a, b) => a - b);
  const count = numbered.length;
  const labels = o.labels ?? { page: "Page {n}", pageOf: "Page {n} of {total}", nOf: "{n} of {total}" };
  const style = o.numberStyle ?? "1";
  const fill = (tpl: string, n: number, total: number) =>
    tpl.replace("{n}", formatNumber(n, style)).replace("{total}", formatNumber(total, style));
  const digits = Math.min(12, Math.max(1, Math.round(o.batesDigits ?? 6)));
  const [mMin, mFrac] = MARGINS[o.margin ?? "normal"] ?? MARGINS.normal;
  const [vert, horiz] = o.position.split("-");
  for (let k = 0; k < numbered.length; k++) {
    const i = numbered[k];
    const page = pages[i];
    const n = o.numberFormat === "bates" && o.counter ? o.counter.next++ : o.startAt + k;
    const last = o.startAt + count - 1;
    const text =
      o.numberFormat === "bates" ? `${o.batesPrefix ?? ""}${String(n).padStart(digits, "0")}`
      : o.numberFormat === "custom" ? fillVariables(o.template ?? "{page}", file).replaceAll("{page}", formatNumber(n, style)).replaceAll("{pages}", formatNumber(last, style))
      : o.numberFormat === "pageN" ? fill(labels.page, n, last)
      : o.numberFormat === "nOfTotal" ? fill(labels.nOf, n, last)
      : o.numberFormat === "pageNOfTotal" ? fill(labels.pageOf, n, last)
      : formatNumber(n, style);
    const { vw, vh } = visualFrame(page);
    // On a very small page the margin and the text shrink so the label stays on it.
    const margin = Math.min(Math.max(mMin, Math.min(vw, vh) * mFrac), Math.min(vw, vh) * 0.1);
    const size = Math.min(o.fontSize, (vh - 2 * margin) * 0.8);
    let h = horiz;
    // Facing pages: outer edge alternates.
    if (o.facing && h !== "center" && (n % 2 === 0)) h = h === "left" ? "right" : "left";
    const vx = h === "left" ? margin : h === "right" ? vw - margin : vw / 2;
    const vy = vert === "top" ? vh - margin - size * 0.75 : margin;
    await drawLabel(doc, page, family, text, {
      vx, vy, size, color: o.color, anchor: h === "left" ? "left" : h === "right" ? "right" : "center", maxWidth: vw - 2 * margin,
    });
  }
  return [{ name: `${baseName(file.name)}-numbered.pdf`, blob: await save(doc) }];
}

// Moves the content stream pdf-lib just added to the front, so it renders under the page.
function sendLastStreamToBack(page: PDFPage, before: number) {
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) return;
  const added: ReturnType<PDFArray["get"]>[] = [];
  while (contents.size() > before) {
    added.unshift(contents.get(contents.size() - 1));
    contents.remove(contents.size() - 1);
  }
  added.reverse().forEach((ref) => contents.insert(0, ref));
}

function contentCount(page: PDFPage) {
  const c = page.node.Contents();
  return c instanceof PDFArray ? c.size() : c ? 1 : 0;
}

// ── Watermark
export async function watermark(
  file: File,
  o: {
    markType: string; markText: string; markImage?: File; fontSize: number; color: string; imageScale: number;
    position: string; mosaic: boolean; opacity: number; rotation: string | number; layer: string; pageRange: string;
    // Font family, a white box behind the mark, and the gap between tiles (100 = default).
    font?: string; markBox?: boolean; tileSpacing?: number;
  },
): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const family = fontChoice(o.font);
  const pages = doc.getPages();
  const chosen = pageSet(o.pageRange, pages.length);
  const opacity = o.opacity / 100;
  const angle = Number(o.rotation) || 0;
  const a = (angle * Math.PI) / 180;
  const spacing = Math.min(4, Math.max(0.5, (o.tileSpacing ?? 100) / 100));
  const markText = fillVariables(o.markText, file);

  let image: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  let line: LaidOut | null = null;
  let textImg: { png: Uint8Array; width: number; height: number } | null = null;
  if (o.markType === "image") {
    if (!o.markImage) throw new PdfError("missing_image");
    const img = await normaliseImage(o.markImage);
    image = img.kind === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
  } else {
    line = await textLine(doc, family, markText, o.fontSize, true);
    if (!line) textImg = await textToPng(markText, o.fontSize, o.color, "700 {s}px system-ui, sans-serif");
  }
  const textImage = textImg ? await doc.embedPng(textImg.png) : null;

  for (let i = 0; i < pages.length; i++) {
    if (!chosen.has(i)) continue;
    const page = pages[i];
    isolate(page);
    const before = contentCount(page);
    const f = visualFrame(page);
    let mw: number, mh: number;
    if (image) {
      const scale = (Math.min(f.vw, f.vh) * (o.imageScale / 100)) / Math.max(image.width, image.height);
      mw = image.width * scale;
      mh = image.height * scale;
    } else if (textImage && textImg) {
      mw = textImg.width;
      mh = textImg.height;
    } else {
      mw = line!.width;
      // About the capital height: Helvetica-Bold's box (0.925 em) × 0.72.
      mh = o.fontSize * 0.666;
    }
    // Text that wouldn't fit on the page, turned as it is, is drawn smaller.
    const k = image ? 1 : Math.min(1,
      (f.vw * 0.9) / (Math.abs(mw * Math.cos(a)) + Math.abs(mh * Math.sin(a))),
      (f.vh * 0.9) / (Math.abs(mw * Math.sin(a)) + Math.abs(mh * Math.cos(a))));
    mw *= k;
    mh *= k;

    const draw = (cx: number, cy: number) => {
      // (cx, cy) is the visual centre of the mark. Rotate the bottom-left corner around it.
      const corner = (dx: number, dy: number) => f.map(
        cx + (dx - mw / 2) * Math.cos(a) - (dy - mh / 2) * Math.sin(a),
        cy + (dx - mw / 2) * Math.sin(a) + (dy - mh / 2) * Math.cos(a),
      );
      const [x, y] = corner(0, 0);
      const rotate = degrees(f.rot + angle);
      if (o.markBox && !image) {
        const pad = Math.max(4, o.fontSize * 0.3) * k;
        const [bx, by] = corner(-pad, -pad);
        page.drawRectangle({ x: bx, y: by, width: mw + 2 * pad, height: mh + 2 * pad, rotate, color: rgb(1, 1, 1), opacity });
      }
      if (image) page.drawImage(image, { x, y, width: mw, height: mh, opacity, rotate });
      else if (textImage) asOneString(page, markText, 1, () => page.drawImage(textImage, { x, y, width: mw, height: mh, opacity, rotate }));
      else {
        const c = hexToRgb(o.color);
        asOneString(page, markText, line!.runs.length, () => {
          for (const run of line!.runs) {
            const [rx, ry] = corner(run.x * k, 0);
            page.drawText(run.text, { x: rx, y: ry, size: o.fontSize * k, font: run.font, color: rgb(c.r, c.g, c.b), opacity, rotate });
          }
        });
      }
    };

    if (o.mosaic) {
      const stepX = (mw * 1.6 + 40) * spacing;
      const stepY = (mh * 3 + 40) * spacing;
      let row = 0;
      for (let cy = stepY / 2; cy < f.vh + stepY; cy += stepY, row++)
        for (let cx = (row % 2 ? stepX / 2 : 0); cx < f.vw + stepX; cx += stepX) draw(cx, cy);
    } else {
      const [vert, horiz] = o.position.split("-");
      const pad = 24 + Math.max(mw, mh) / 2;
      const cx = horiz === "left" ? pad : horiz === "right" ? f.vw - pad : f.vw / 2;
      const cy = vert === "top" ? f.vh - pad : vert === "bottom" ? pad : f.vh / 2;
      draw(cx, cy);
    }
    if (o.layer === "under") sendLastStreamToBack(page, before);
  }
  return [{ name: `${baseName(file.name)}-watermarked.pdf`, blob: await save(doc) }];
}

// ── Crop. Rect is in visual fractions (0–1, top-left origin).
export type FracRect = { x: number; y: number; w: number; h: number };

export async function crop(file: File, rects: Map<number, FracRect> | FracRect): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  doc.getPages().forEach((page, i) => {
    const r = rects instanceof Map ? rects.get(i) : rects;
    if (!r) return;
    const f = visualFrame(page);
    const [x1, y1] = f.map(r.x * f.vw, (1 - r.y - r.h) * f.vh);
    const [x2, y2] = f.map((r.x + r.w) * f.vw, (1 - r.y) * f.vh);
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    page.setCropBox(x, y, w, h);
    page.setMediaBox(x, y, w, h);
    page.setTrimBox(x, y, w, h);
    page.setBleedBox(x, y, w, h);
    page.setArtBox(x, y, w, h);
  });
  return [{ name: `${baseName(file.name)}-cropped.pdf`, blob: await save(doc) }];
}

// ── Editor objects (Edit PDF, Sign PDF)
export type EditorItem = {
  id: string;
  page: number;
  kind: "text" | "image" | "rect" | "ellipse" | "line" | "path" | "highlight" | "whiteout" | "textField" | "checkbox";
  // Visual fractions of the page, top-left origin.
  x: number; y: number; w: number; h: number;
  color?: string;
  fill?: string | null;
  stroke?: number; // points
  fontSize?: number; // points
  bold?: boolean;
  text?: string;
  image?: string; // data URL
  points?: [number, number][]; // fractions, for path and line
  name?: string; // form field name
};

function dataUrlBytes(url: string) {
  const b64 = url.split(",")[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out, png: url.startsWith("data:image/png") };
}

export async function applyItems(doc: PDFDocument, items: EditorItem[]) {
  const pages = doc.getPages();
  const form = items.some((i) => i.kind === "textField" || i.kind === "checkbox") ? doc.getForm() : null;
  for (const it of items) {
    const page = pages[it.page];
    if (!page) continue;
    isolate(page);
    const f = visualFrame(page);
    const vx = it.x * f.vw;
    const vyTop = (1 - it.y) * f.vh;
    const w = it.w * f.vw;
    const h = it.h * f.vh;
    const [x, y] = f.map(vx, vyTop - h); // visual bottom-left of the box
    const rotate = degrees(f.rot);
    const color = hexToRgb(it.color ?? "#111827");
    const c = rgb(color.r, color.g, color.b);
    const fill = it.fill ? (() => { const v = hexToRgb(it.fill!); return rgb(v.r, v.g, v.b); })() : undefined;
    switch (it.kind) {
      case "text": {
        const size = it.fontSize ?? 14;
        const lines = (it.text ?? "").split("\n");
        for (let li = 0; li < lines.length; li++) {
          if (!lines[li]) continue;
          await drawLabel(doc, page, "helvetica", lines[li], {
            vx, vy: vyTop - size * 0.86 - li * size * 1.25, size, color: it.color ?? "#111827", anchor: "left", bold: it.bold,
          });
        }
        break;
      }
      case "image": {
        if (!it.image) break;
        const { bytes, png } = dataUrlBytes(it.image);
        const img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        page.drawImage(img, { x, y, width: w, height: h, rotate });
        break;
      }
      case "rect":
      case "whiteout":
        page.drawRectangle({
          x, y, width: w, height: h, rotate,
          color: it.kind === "whiteout" ? rgb(1, 1, 1) : fill,
          borderColor: it.kind === "whiteout" ? undefined : c,
          borderWidth: it.kind === "whiteout" ? 0 : it.stroke ?? 2,
        });
        break;
      case "highlight":
        page.drawRectangle({ x, y, width: w, height: h, rotate, color: c, opacity: 0.38, blendMode: BlendMode.Multiply });
        break;
      case "ellipse": {
        const [cx, cy] = f.map(vx + w / 2, vyTop - h / 2);
        page.drawEllipse({ x: cx, y: cy, xScale: w / 2, yScale: h / 2, rotate, color: fill, borderColor: c, borderWidth: it.stroke ?? 2 });
        break;
      }
      case "line":
      case "path": {
        const pts = it.points ?? [];
        if (pts.length < 2) break;
        // SVG path in visual points, y down, anchored at the visual top-left.
        const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${(px * f.vw).toFixed(2)} ${(py * f.vh).toFixed(2)}`).join(" ");
        const [ox, oy] = f.map(0, f.vh);
        page.drawSvgPath(d, { x: ox, y: oy, borderColor: c, borderWidth: it.stroke ?? 2, rotate, borderLineCap: 1 });
        break;
      }
      case "textField": {
        const field = form!.createTextField(uniqueName(form!, it.name || "text"));
        field.addToPage(page, { x, y, width: w, height: h, rotate, borderColor: rgb(0.6, 0.64, 0.7), borderWidth: 1 });
        break;
      }
      case "checkbox": {
        const field = form!.createCheckBox(uniqueName(form!, it.name || "check"));
        field.addToPage(page, { x, y, width: w, height: h, rotate, borderColor: rgb(0.4, 0.44, 0.5), borderWidth: 1 });
        break;
      }
    }
  }
}

function uniqueName(form: ReturnType<PDFDocument["getForm"]>, base: string) {
  const names = new Set(form.getFields().map((f) => f.getName()));
  let n = base.replace(/[.\s]+/g, "_");
  let k = 2;
  while (names.has(n)) n = `${base}_${k++}`;
  return n;
}

export async function editPdf(file: File, items: EditorItem[], suffix: string): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  await applyItems(doc, items);
  return [{ name: `${baseName(file.name)}-${suffix}.pdf`, blob: await save(doc) }];
}

// ── Forms
export type FieldInfo = {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "list" | "other";
  value: string | boolean | string[];
  options?: string[];
  multiline?: boolean;
  page: number;
  rect?: { x: number; y: number; w: number; h: number }; // visual fractions
};

export async function readFields(file: File): Promise<FieldInfo[]> {
  const doc = await loadPdf(file, file.name);
  const pages = doc.getPages();
  const form = doc.getForm();
  return form.getFields().map((field) => {
    const widget = field.acroField.getWidgets()[0];
    let page = 0;
    let rect: FieldInfo["rect"];
    if (widget) {
      const pRef = widget.P();
      const idx = pRef ? pages.findIndex((p) => p.ref === pRef) : -1;
      page = idx >= 0 ? idx : pages.findIndex((p) => (p.node.Annots()?.asArray() ?? []).some((a) => a === widget.dict || doc.context.lookup(a) === widget.dict));
      page = Math.max(0, page);
      const r = widget.getRectangle();
      const f = visualFrame(pages[page]);
      const box = viewBox(pages[page]);
      // Approximate for unrotated pages; rotated pages fall back to the side list.
      if (f.rot === 0) rect = { x: (r.x - box.x) / f.vw, y: 1 - (r.y - box.y + r.height) / f.vh, w: r.width / f.vw, h: r.height / f.vh };
    }
    const name = field.getName();
    if (field instanceof PDFTextField) return { name, type: "text", value: field.getText() ?? "", multiline: field.isMultiline(), page, rect };
    if (field instanceof PDFCheckBox) return { name, type: "checkbox", value: field.isChecked(), page, rect };
    if (field instanceof PDFDropdown) return { name, type: "dropdown", value: field.getSelected()[0] ?? "", options: field.getOptions(), page, rect };
    if (field instanceof PDFOptionList) return { name, type: "list", value: field.getSelected(), options: field.getOptions(), page, rect };
    if (field instanceof PDFRadioGroup) return { name, type: "radio", value: field.getSelected() ?? "", options: field.getOptions(), page, rect };
    return { name, type: "other", value: "", page, rect };
  });
}

export async function fillForm(
  file: File, values: Record<string, string | boolean | string[]>, newItems: EditorItem[], flatten: boolean,
): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) field.setText(String(value));
      else if (field instanceof PDFCheckBox) {
        if (value) field.check();
        else field.uncheck();
      }
      else if (field instanceof PDFDropdown && value) field.select(String(value));
      else if (field instanceof PDFOptionList && Array.isArray(value)) field.select(value);
      else if (field instanceof PDFRadioGroup && value) field.select(String(value));
    } catch {
      // A value the field rejects (bad option, too long) is skipped, not fatal.
    }
  }
  await applyItems(doc, newItems);
  // Helvetica can only draw Western European text. Give each field that shows
  // anything else a bundled font that covers all of it.
  for (const field of form.getFields()) {
    const shown = field instanceof PDFTextField ? [field.getText() ?? ""]
      : field instanceof PDFDropdown ? field.getSelected()
      : field instanceof PDFOptionList ? field.getOptions()
      : [];
    const text = shown.join(" ");
    if (isWinAnsi(text) || !field.needsAppearancesUpdate()) continue;
    const covering = await fontCovering(doc, text).catch(() => null);
    if (!covering) continue;
    try {
      (field as PDFTextField | PDFDropdown | PDFOptionList).updateAppearances(covering);
    } catch {
      // Left dirty; handled by the fallback below.
    }
  }
  try {
    form.updateFieldAppearances(font);
  } catch {
    // Non-WinAnsi values keep the viewer-generated appearance (NeedAppearances).
    form.acroForm.dict.set(PDFName.of("NeedAppearances"), doc.context.obj(true));
  }
  if (flatten) form.flatten();
  return [{ name: `${baseName(file.name)}-filled.pdf`, blob: await save(doc) }];
}

