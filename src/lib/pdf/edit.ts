"use client";

import {
  PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, degrees, BlendMode, PDFArray, PDFName,
  PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFTextField, PDFOptionList, PDFSignature, PDFString,
  PDFHexString, PDFOperator, PDFOperatorNames as Ops, PDFRawStream, decodePDFRawStream,
} from "pdf-lib";
import { baseName, hexToRgb, isWinAnsi, normaliseImage, pageSet, pdfBlob, textToPng, type Output } from "./common";
import { loadPdf } from "./organize";
import { PdfError } from "./errors";
import { FAMILIES, fontCovering, layoutText, type Family, type LaidOut } from "./fonts";
import { addField } from "./forms";
import { dateFormatOf, isFieldKind, type DateFormat, type FieldKind } from "./formsmeta";

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

// ── Previews (P2-12, StampPreview.tsx). `onto` makes a stamping tool draw into
// a document it is given, on one page only, instead of opening the file.
export type Onto = { doc: PDFDocument; only: number };

// The marks alone, as the tool would draw them on page `index` (0-based) of
// a `total`-page file whose pages are shown at w × h points: blank pages
// carrying only the watermark, number or header. Drawn with the same code as
// the real output, so the preview's geometry is the output's.
export async function markLayer(
  tool: "watermark" | "pageNumbers" | "headerFooter", file: File, o: Record<string, unknown>,
  page: { w: number; h: number; index: number; total: number },
  labels?: { page: string; pageOf: string; nOf: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Every page is there (numbering counts them), but only one is drawn on.
  for (let i = 0; i < page.total; i++) doc.addPage([page.w, page.h]);
  const onto = { doc, only: page.index };
  const s = (v: unknown) => String(v ?? ""), n = (v: unknown) => Number(v) || 0;
  if (tool === "watermark") {
    await watermark(file, {
      markType: s(o.markType), markText: s(o.markText), markImage: o.markImage as File | undefined, fontSize: n(o.fontSize), color: s(o.color),
      imageScale: n(o.imageScale), position: s(o.position), mosaic: !!o.mosaic, opacity: 100, rotation: n(o.rotation), layer: "over",
      pageRange: s(o.pageRange), font: s(o.font), markBox: !!o.markBox, tileSpacing: n(o.tileSpacing) || 100,
    }, onto);
  } else if (tool === "pageNumbers") {
    await pageNumbers(file, {
      position: s(o.position), numberFormat: s(o.numberFormat), startAt: n(o.startAt) || 1, pageRange: s(o.pageRange),
      skipFirst: n(o.skipFirstPages), skipLast: n(o.skipLastPages), fontSize: n(o.fontSize), color: s(o.color), facing: !!o.facing,
      template: s(o.template), numberStyle: s(o.numberStyle) || "1", margin: s(o.margin), font: s(o.font),
      batesPrefix: s(o.batesPrefix), batesDigits: n(o.batesDigits), counter: { next: n(o.startAt) || 1 }, labels,
    }, onto);
  } else {
    await headerFooter(file, {
      header: s(o.hfHeader), footer: s(o.hfFooter), align: s(o.hfAlign), font: s(o.font), fontSize: n(o.fontSize), color: s(o.color),
      margin: s(o.margin), pageRange: s(o.pageRange), skipFirst: n(o.hfSkipFirst),
    }, onto);
  }
  // Only the page drawn on is kept, so the layer is small and renders as page 1.
  for (let i = page.total - 1; i >= 0; i--) if (i !== page.index) doc.removePage(i);
  return doc.save({ addDefaultPage: false });
}

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
  onto?: Onto,
): Promise<Output[]> {
  const doc = onto?.doc ?? (await loadPdf(file, file.name));
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
    if (onto && i !== onto.only) continue;
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
  if (onto) return [];
  return [{ name: `${baseName(file.name)}-numbered.pdf`, blob: await save(doc) }];
}

// ── Header and footer: a line of text at the top and/or bottom of each
// page, with {page}, {pages}, {filename} and {date} filled in.
export async function headerFooter(
  file: File,
  o: { header: string; footer: string; align: string; font?: string; fontSize: number; color: string; margin?: string; pageRange: string; skipFirst: number },
  onto?: Onto,
): Promise<Output[]> {
  const doc = onto?.doc ?? (await loadPdf(file, file.name));
  const family = fontChoice(o.font);
  const pages = doc.getPages();
  const total = pages.length;
  const chosen = pageSet(o.pageRange, total);
  const [mMin, mFrac] = MARGINS[o.margin ?? "normal"] ?? MARGINS.normal;
  const anchor = o.align === "left" ? "left" : o.align === "right" ? "right" : "center";
  const header = fillVariables(o.header.trim(), file), footer = fillVariables(o.footer.trim(), file);
  for (let i = 0; i < total; i++) {
    if (!chosen.has(i) || i < Math.max(0, o.skipFirst || 0) || (onto && i !== onto.only)) continue;
    const page = pages[i];
    const { vw, vh } = visualFrame(page);
    const margin = Math.min(Math.max(mMin, Math.min(vw, vh) * mFrac), Math.min(vw, vh) * 0.1);
    const size = Math.min(o.fontSize, (vh - 2 * margin) * 0.4);
    const vx = anchor === "left" ? margin : anchor === "right" ? vw - margin : vw / 2;
    const fill = (t: string) => t.replaceAll("{page}", String(i + 1)).replaceAll("{pages}", String(total));
    const draw = (text: string, vy: number) => drawLabel(doc, page, family, fill(text), { vx, vy, size, color: o.color, anchor, maxWidth: vw - 2 * margin });
    if (header) await draw(header, vh - margin - size * 0.75);
    if (footer) await draw(footer, margin);
  }
  if (onto) return [];
  return [{ name: `${baseName(file.name)}-header-footer.pdf`, blob: await save(doc) }];
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
  onto?: Onto,
): Promise<Output[]> {
  const doc = onto?.doc ?? (await loadPdf(file, file.name));
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
    if (!chosen.has(i) || (onto && i !== onto.only)) continue;
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
  if (onto) return [];
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
  kind: "text" | "image" | "rect" | "ellipse" | "line" | "path" | "highlight" | "whiteout" | "textEdit" | FieldKind;
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
  // Form fields (see forms.ts).
  name?: string;
  options?: string[];
  required?: boolean;
  multiple?: boolean;
  multiline?: boolean;
  dateFormat?: DateFormat;
  tooltip?: string;
  // textEdit: the page's own text object it changes (see listText), and where
  // its box was, so x and y say how far it moved. `text` "" deletes it.
  source?: { index: number; was: string; x: number; y: number; font?: string; angle?: number };
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
  const form = items.some((i) => isFieldKind(i.kind)) ? doc.getForm() : null;
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
      default:
        if (isFieldKind(it.kind)) await addField(doc, form!, page, f, { ...it, kind: it.kind }, { vx, vy: vyTop - h, w, h });
    }
  }
}

// Changes to the page's own text go first (PDFium), then what was added on top (pdf-lib).
export async function editPdf(file: File, items: EditorItem[], suffix: string): Promise<Output[]> {
  const edits = items.filter((i) => i.kind === "textEdit" && i.source);
  const added = items.filter((i) => i.kind !== "textEdit");
  const name = `${baseName(file.name)}-${suffix}.pdf`;
  if (!edits.length) {
    const doc = await loadPdf(file, file.name);
    await applyItems(doc, added);
    return [{ name, blob: await save(doc) }];
  }
  const { bytes, note } = await applyTextEdits(file, edits);
  if (!added.length) return [{ name, blob: pdfBlob(bytes), note }];
  const doc = await loadPdf(new File([bytes as BlobPart], file.name, { type: "application/pdf" }), file.name);
  await applyItems(doc, added);
  return [{ name, blob: await save(doc), note }];
}

export { moveLayer } from "./layers";

// ── The page's own text (PDFium text objects)

// A text object as the editor shows it: box in visual fractions (top-left
// origin), size in points as seen, angle in degrees counter-clockwise on screen.
export type TextBox = { index: number; text: string; font: string; size: number; box: FracRect; angle: number; color: string; bold: boolean; italic: boolean };

type PageGeom = import("./pdfium").PageGeom;

// visualFrame for a page PDFium read, and its inverse.
function frameOf(g: PageGeom) {
  const rect = (b: PageGeom["media"]) => ({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 });
  const media = rect(g.media);
  const crop = g.crop ? rect(g.crop) : media;
  const f = visualFrame({ getMediaBox: () => media, getCropBox: () => crop, getRotation: () => ({ angle: g.rotate }) } as unknown as PDFPage);
  const [ox, oy] = f.map(0, 0);
  const [ax, ay] = f.map(1, 0);
  const [bx, by] = f.map(0, 1);
  const u = [ax - ox, ay - oy], v = [bx - ox, by - oy];
  const det = u[0] * v[1] - u[1] * v[0];
  // User-space vector → visual vector.
  const back = (x: number, y: number): [number, number] => [(x * v[1] - y * v[0]) / det, (u[0] * y - u[1] * x) / det];
  return { ...f, u, v, toVisual: (x: number, y: number) => back(x - ox, y - oy), back };
}

// Fractions of the page moved on screen → points moved in user space.
function moveDelta(g: PageGeom, [fx, fy]: [number, number]): [number, number] {
  const f = frameOf(g);
  const dvx = fx * f.vw, dvy = -fy * f.vh;
  return [dvx * f.u[0] + dvy * f.v[0], dvx * f.u[1] + dvy * f.v[1]];
}

const fileBytes = async (file: File) => new Uint8Array(await file.arrayBuffer());

export async function listText(file: File, page: number): Promise<TextBox[]> {
  const { textObjects } = await import("./pdfium");
  const { geom, objects } = await textObjects(await fileBytes(file), page);
  const f = frameOf(geom);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return objects.map((o) => {
    const b = o.bounds;
    const corners = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => f.toVisual(x, y));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const [a, bb] = o.matrix;
    const dir = f.back(a, bb);
    return {
      index: o.index, text: o.text, font: o.font, bold: o.bold, italic: o.italic,
      size: o.size * Math.hypot(a, bb),
      box: { x: Math.min(...xs) / f.vw, y: 1 - Math.max(...ys) / f.vh, w: (Math.max(...xs) - Math.min(...xs)) / f.vw, h: (Math.max(...ys) - Math.min(...ys)) / f.vh },
      angle: (Math.atan2(dir[1], dir[0]) * 180) / Math.PI,
      color: `#${hex(o.fill[0])}${hex(o.fill[1])}${hex(o.fill[2])}`,
    };
  });
}

// Bundled fonts for new text an object's own font can't show: the
// metric-compatible stand-in for the font (Arimo, Tinos, Cousine, Carlito,
// Caladea) where it has the glyph, else a Noto slice (CJK, and scripts the
// stand-in lacks).
type Kit = { hasGlyphForCodePoint(cp: number): boolean };
const fallbackFaces = new Map<string, Promise<{ sfnt: Uint8Array; kit: Kit } | null>>();
const STAND_INS = { arimo: "Arimo", tinos: "Tinos", cousine: "Cousine", carlito: "Carlito", caladea: "Caladea" } as const;
const NOTO = { jp: "Noto Sans JP", kr: "Noto Sans KR", sc: "Noto Sans SC", tc: "Noto Sans TC", arabic: "Noto Sans Arabic", thai: "Noto Sans Thai", devanagari: "Noto Sans Devanagari" } as const;
const notoName = (file: string) => {
  const key = Object.keys(NOTO).find((k) => file.startsWith(`noto-sans-${k}-`)) as keyof typeof NOTO | undefined;
  return key ? NOTO[key] : "Noto Sans";
};

function fallbackFace(key: string, woff: () => Promise<Uint8Array | null>) {
  let p = fallbackFaces.get(key);
  if (!p) {
    p = (async () => {
      const [{ woffToSfnt }, { default: fontkit }] = await Promise.all([import("./pdfa"), import("@pdf-lib/fontkit")]);
      const w = await woff();
      if (!w) return null;
      const sfnt = woffToSfnt(w);
      return { sfnt, kit: fontkit.create(sfnt) as unknown as Kit };
    })();
    p.catch(() => fallbackFaces.delete(key));
    fallbackFaces.set(key, p);
  }
  return p;
}

const fallbackRuns: import("./pdfium").Fallback = async (text, like) => {
  const [{ pdfaFonts, pickFamily }, faces, { notoFaceFor }] = await Promise.all([import("./pdfa"), import("../office/faces"), import("./fonts")]);
  // The stand-in by name first (a Tinos or Liberation Serif subset), then by pdfa.ts's rules.
  const named = (Object.keys(STAND_INS) as (keyof typeof STAND_INS)[]).find((k) => new RegExp(k, "i").test(like.name));
  const liberation = /liberation.?mono/i.test(like.name) ? "cousine" : /liberation.?serif/i.test(like.name) ? "tinos" : /liberation.?sans/i.test(like.name) ? "arimo" : undefined;
  const family = named ?? liberation ?? (pickFamily(like.name, like.flags) as keyof typeof STAND_INS);
  // CJK forms by the replaced font's name.
  const prefer = /JP|Japan|Mincho|Gothic|Meiryo|Hiragino|YuGo|YuMin|Osaka/i.test(like.name) ? "jp"
    : /KR|Korea|Malgun|Batang|Gulim|Dotum|Gungsuh/i.test(like.name) ? "kr"
    : /TC|Hant|HK|MingLiU|Taiwan/i.test(like.name) ? "tc"
    : /SC|Hans|SimSun|SimHei|YaHei|GB|Song|Kai/i.test(like.name) ? "sc" : undefined;
  type Pick = { key: string; name: string; face: { sfnt: Uint8Array; kit: Kit } };
  const pick = async (cp: number): Promise<Pick | null> => {
    for (const subset of faces.subsetsOf(family)) {
      if (!faces.inSubset(subset, cp)) continue;
      const file = faces.fontFile(family, like.bold, like.italic, subset);
      const face = await fallbackFace(file, () => pdfaFonts.load(file)).catch(() => null);
      if (face?.kit.hasGlyphForCodePoint(cp)) return { key: file, name: STAND_INS[family], face };
    }
    const noto = await notoFaceFor(cp, text, like.bold, prefer).catch(() => null);
    if (!noto) return null;
    const face = await fallbackFace(noto.file, async () => noto.bytes);
    return face?.kit.hasGlyphForCodePoint(cp) ? { key: noto.file, name: notoName(noto.file), face } : null;
  };
  const runs: (Pick & { text: string })[] = [];
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0)!;
    const last = runs[runs.length - 1];
    if (last && last.face.kit.hasGlyphForCodePoint(cp)) {
      last.text += ch;
      continue;
    }
    const p = await pick(cp);
    if (!p) return null;
    if (last && last.key === p.key) last.text += ch;
    else runs.push({ ...p, text: ch });
  }
  return runs.map((r) => ({ text: r.text, key: r.key, name: r.name, font: async () => r.face.sfnt }));
};

// Whether new text for a text object keeps its font, for the editor to say
// before saving. `fallback` names the bundled fonts used instead (null: none can).
export async function textFonts(file: File, page: number, index: number, text: string):
  Promise<{ kept: true; font: string } | { kept: false; font: string; fallback: string | null } | { unsupported: true }> {
  const { textFontCheck } = await import("./pdfium");
  const r = await textFontCheck(await fileBytes(file), page, index, text, fallbackRuns);
  if ("unsupported" in r || r.kept) return r;
  return { kept: false, font: r.font, fallback: r.fallback ? r.fallback.join(", ") : null };
}

async function applyTextEdits(file: File, edits: EditorItem[]) {
  const { editTextObjects } = await import("./pdfium");
  const changes = edits.map((e) => ({
    page: e.page, index: e.source!.index, was: e.source!.was, text: (e.text ?? "").replace(/\s*\n\s*/g, " "),
    move: [e.x - e.source!.x, e.y - e.source!.y] as [number, number],
  }));
  let out;
  try {
    out = await editTextObjects(await fileBytes(file), changes, fallbackRuns, moveDelta);
  } catch (e) {
    throw new PdfError("damaged", file.name, e);
  }
  if (out.results.some((r) => r.error)) throw new PdfError("text_edit_failed", file.name, out.results.filter((r) => r.error));
  const swaps = [...new Set(out.results.filter((r) => r.fallback).map((r) => `${r.font} → ${r.fallback!.join(", ")}`))];
  return { bytes: out.bytes, note: swaps.length ? `textFallback:${swaps.join("; ")}` : undefined };
}

// ── Forms
export type FieldInfo = {
  name: string;
  type: "text" | "checkbox" | "dropdown" | "radio" | "list" | "date" | "signature" | "other";
  value: string | boolean | string[];
  options?: string[];
  multiline?: boolean;
  required?: boolean;
  tooltip?: string;
  dateFormat?: DateFormat;
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
    const tu = field.acroField.dict.lookup(PDFName.of("TU"));
    const tooltip = tu instanceof PDFString || tu instanceof PDFHexString ? tu.decodeText() : undefined;
    const base = { name: field.getName(), page, rect, required: field.isRequired(), tooltip };
    if (field instanceof PDFTextField) {
      const dateFormat = dateFormatOf(tooltip);
      if (dateFormat) return { ...base, type: "date", value: field.getText() ?? "", dateFormat };
      return { ...base, type: "text", value: field.getText() ?? "", multiline: field.isMultiline() };
    }
    if (field instanceof PDFCheckBox) return { ...base, type: "checkbox", value: field.isChecked() };
    if (field instanceof PDFDropdown) return { ...base, type: "dropdown", value: field.getSelected()[0] ?? "", options: field.getOptions() };
    if (field instanceof PDFOptionList) return { ...base, type: "list", value: field.getSelected(), options: field.getOptions() };
    if (field instanceof PDFRadioGroup) return { ...base, type: "radio", value: field.getSelected() ?? "", options: field.getOptions() };
    if (field instanceof PDFSignature) return { ...base, type: "signature", value: "" };
    return { ...base, type: "other", value: "" };
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

