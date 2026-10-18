"use client";

// Laid-out HTML → a real PDF file, without the print dialog. The browser lays
// the document out (docx-preview for Word, html.ts for PowerPoint and Excel);
// this walks the boxes it made and draws them with pdf-lib:
//   - text, word by word at the position the browser measured, in the
//     metric-compatible fonts the page was laid out with (Carlito for Calibri,
//     Caladea for Cambria, Arimo, Tinos, Cousine), falling back to the Noto
//     slices (fonts.ts) for other scripts, so it stays selectable and searchable;
//   - background colours and borders as rectangles;
//   - images, and SVG drawings as images.
// Phones get a file they can share straight away; on computers LibreOffice
// remains the high-fidelity route (route.ts), and the print dialog is the
// last resort if this fails.

import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument, PDFString, rgb, type PDFFont, type PDFImage, type PDFPage,
  pushGraphicsState, popGraphicsState, rectangle, clip, endPath,
} from "pdf-lib";
import { layoutText } from "../pdf/fonts";
import { fontBase, fontFaces, fontFile, inSubset, subsetsOf, type Family, type Subset } from "./faces";

const PT = 0.75; // CSS px → PDF points

// ── Fonts: the faces the page was laid out with (faces.ts), embedded.
const fontUrl = (file: string) => fontBase() + file;

function familyOf(list: string): Family {
  for (const raw of list.split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (/calibri|carlito|aptos/.test(name)) return "carlito";
    if (/cambria|caladea/.test(name)) return "caladea";
    if (/courier|cousine|mono|consol|typewriter/.test(name)) return "cousine";
    if (/arial|helvetica|arimo|sans|verdana|tahoma|segoe|roboto|liberation sans/.test(name)) return "arimo";
    if (/times|tinos|serif|georgia|garamond|palatino|book|century|minion/.test(name)) return "tinos";
  }
  return "carlito";
}

type Kit = ReturnType<typeof fontkit.create>;
type Face = { font: PDFFont; kit: Kit; ascent: number; descent: number };

// A face that can't be fetched (offline before the fonts were cached) would
// leave every run in it out of the PDF. It stops the drawing instead, so the
// caller falls back to printing with the browser's own fonts.
export class FontUnavailable extends Error {}

class Fonts {
  private faces = new Map<string, Promise<Face>>();
  constructor(private doc: PDFDocument) {
    doc.registerFontkit(fontkit);
  }
  get(family: Family, bold: boolean, italic: boolean, subset: Subset = "latin") {
    const file = fontFile(family, bold, italic, subset);
    let p = this.faces.get(file);
    if (!p) {
      p = (async () => {
        let bytes: Uint8Array;
        try {
          const r = await fetch(fontUrl(file));
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          bytes = new Uint8Array(await r.arrayBuffer());
        } catch (e) {
          throw new FontUnavailable(`Font ${file} unavailable: ${e instanceof Error ? e.message : e}`);
        }
        const kit = fontkit.create(bytes) as Kit;
        // WOFF: only the subsetting embedder re-encodes it as TrueType.
        const font = await this.doc.embedFont(bytes, { subset: true });
        return { font, kit, ascent: kit.ascent / kit.unitsPerEm, descent: -kit.descent / kit.unitsPerEm };
      })();
      this.faces.set(file, p);
    }
    return p;
  }
}

// ── What the browser laid out, in CSS px relative to the viewport.
type Box = { x: number; y: number; w: number; h: number };
type Color = { r: number; g: number; b: number; a: number };
type TextStyle = { family: Family; bold: boolean; italic: boolean; size: number; color: Color; underline: boolean; strike: boolean };
type Item =
  | { kind: "fill"; box: Box; color: Color }
  | { kind: "image"; box: Box; el: HTMLImageElement | SVGSVGElement | HTMLCanvasElement }
  | { kind: "text"; box: Box; text: string; style: TextStyle }
  | { kind: "link"; box: Box; url: string };

function parseColor(v: string): Color | null {
  const m = v.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return a > 0.01 ? { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a } : null;
}

const toBox = (r: DOMRect, k = 1): Box => ({ x: r.left, y: r.top, w: r.width * k, h: r.height * k });

// Symbol and Wingdings bullets live in the Private Use Area.
const symbols = (s: string) => s.replace(/[-]/g, (c) => (c === "" ? "▪" : c === "" ? "✓" : "•"));

function transform(text: string, how: string) {
  if (how === "uppercase") return text.toUpperCase();
  if (how === "lowercase") return text.toLowerCase();
  if (how === "capitalize") return text.replace(/(^|\s)(\p{L})/gu, (_, s, c) => s + c.toUpperCase());
  return text;
}

function collect(root: Element): Item[] {
  const win = root.ownerDocument.defaultView!;
  const items: Item[] = [];
  const range = root.ownerDocument.createRange();
  // Whether the text after `node` starts with a space, for a word at its end.
  const spaceAfter = (node: Text) => {
    const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    walker.currentNode = node;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data) return /^\s/.test((n as Text).data);
    return false;
  };

  const texts = (node: Text, cs: CSSStyleDeclaration, deco: { underline: boolean; strike: boolean }) => {
    const data = node.data;
    if (!/\S/.test(data)) return;
    const style: TextStyle = {
      family: familyOf(cs.fontFamily),
      bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
      italic: cs.fontStyle !== "normal",
      size: parseFloat(cs.fontSize) || 16,
      color: parseColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 },
      ...deco,
    };
    const caps = cs.fontVariantCaps && cs.fontVariantCaps !== "normal" ? "uppercase" : cs.textTransform;
    for (const m of data.matchAll(/\S+/g)) {
      const start = m.index!;
      const end = start + m[0].length;
      range.setStart(node, start);
      range.setEnd(node, end);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      if (!rects.length) continue;
      // A trailing space keeps words apart when the text is copied.
      const space = (end < data.length ? /\s/.test(data[end]) : spaceAfter(node)) ? " " : "";
      if (rects.length === 1) {
        items.push({ kind: "text", box: toBox(rects[0]), text: symbols(transform(m[0], caps)) + space, style });
        continue;
      }
      // A word broken over lines: character by character, grouped by line.
      let line: { box: Box; text: string } | null = null;
      for (let i = start; i < end; ) {
        const cp = data.codePointAt(i)!;
        const len = cp > 0xffff ? 2 : 1;
        range.setStart(node, i);
        range.setEnd(node, i + len);
        const r = range.getBoundingClientRect();
        const ch = symbols(transform(data.slice(i, i + len), caps));
        if (line && Math.abs(r.top - line.box.y) < 1) {
          line.text += ch;
          line.box.w = r.right - line.box.x;
        } else {
          if (line) items.push({ kind: "text", box: line.box, text: line.text, style });
          line = { box: toBox(r), text: ch };
        }
        i += len;
      }
      if (line) items.push({ kind: "text", box: line.box, text: line.text + space, style });
    }
  };

  const visit = (el: Element, deco: { underline: boolean; strike: boolean }) => {
    const cs = win.getComputedStyle(el);
    if (cs.display === "none") return;
    const shown = cs.visibility === "visible" && parseFloat(cs.opacity) > 0;
    const line = cs.textDecorationLine || "";
    const own = { underline: deco.underline || line.includes("underline"), strike: deco.strike || line.includes("line-through") };
    if (shown) {
      const rects = cs.display === "inline" ? [...el.getClientRects()] : [el.getBoundingClientRect()];
      const bg = parseColor(cs.backgroundColor);
      if (bg) for (const r of rects) if (r.width > 0 && r.height > 0) items.push({ kind: "fill", box: toBox(r), color: bg });
      if (cs.display !== "inline") {
        const r = rects[0];
        const side = (s: "Top" | "Right" | "Bottom" | "Left") => {
          const w = parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`));
          const style = cs.getPropertyValue(`border-${s.toLowerCase()}-style`);
          const color = parseColor(cs.getPropertyValue(`border-${s.toLowerCase()}-color`));
          if (!(w > 0) || !color || style === "none" || style === "hidden") return;
          const box = s === "Top" ? { x: r.left, y: r.top, w: r.width, h: w }
            : s === "Bottom" ? { x: r.left, y: r.bottom - w, w: r.width, h: w }
            : s === "Left" ? { x: r.left, y: r.top, w, h: r.height }
            : { x: r.right - w, y: r.top, w, h: r.height };
          items.push({ kind: "fill", box, color });
        };
        if (r && r.width > 0 && r.height > 0) (["Top", "Right", "Bottom", "Left"] as const).forEach(side);
      }
      const tag = el.localName;
      // Web and mail links stay clickable: one annotation per line the link is on.
      if (tag === "a" && /^(https?|mailto):$/.test((el as HTMLAnchorElement).protocol)) {
        const url = (el as HTMLAnchorElement).href;
        for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0) items.push({ kind: "link", box: toBox(r), url });
      }
      if (tag === "img" || tag === "svg" || tag === "canvas") {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) items.push({ kind: "image", box: toBox(r), el: el as HTMLImageElement });
        return;
      }
    }
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        if (shown) texts(child as Text, cs, own);
      } else if (child.nodeType === 1) visit(child as Element, own);
    }
  };
  visit(root, { underline: false, strike: false });
  range.detach();
  return items;
}

// ── Images: PNG and JPEG go in as they are; anything else the browser can
// show (GIF, WebP, SVG, BMP) goes through a canvas as PNG.
async function imageOf(doc: PDFDocument, el: HTMLImageElement | SVGSVGElement | HTMLCanvasElement, cache: Map<string, Promise<PDFImage | null>>) {
  const toPng = async (draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number) => {
    const scale = Math.min(2, 2400 / Math.max(w, h, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d")!;
    draw(ctx, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/png"));
    return blob ? doc.embedPng(new Uint8Array(await blob.arrayBuffer())) : null;
  };
  if (el.localName === "canvas") {
    const c = el as HTMLCanvasElement;
    return toPng((ctx, w, h) => ctx.drawImage(c, 0, 0, w, h), c.width, c.height);
  }
  if (el.localName === "svg") {
    const r = el.getBoundingClientRect();
    const svg = el.cloneNode(true) as SVGSVGElement;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", String(r.width));
    svg.setAttribute("height", String(r.height));
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await img.decode();
    return toPng((ctx, w, h) => ctx.drawImage(img, 0, 0, w, h), r.width, r.height);
  }
  const img = el as HTMLImageElement;
  const src = img.currentSrc || img.src;
  if (!src) return null;
  let p = cache.get(src);
  if (!p) {
    p = (async () => {
      if (!img.complete) await img.decode().catch(() => {});
      if (!img.naturalWidth) return null; // broken, or a format the browser can't show (EMF)
      const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
      if (bytes[0] === 0x89 && bytes[1] === 0x50) return doc.embedPng(bytes).catch(() => null);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return doc.embedJpg(bytes).catch(() => null);
      return null;
    })().then((done) => done ?? toPng((ctx, w, h) => ctx.drawImage(img, 0, 0, w, h), img.naturalWidth, img.naturalHeight));
    cache.set(src, p);
  }
  return p;
}

// ── Pages. A sheet is one PDF page: the part `box` of `root`'s layout, drawn
// at `at` (points, from the top left) on a page of `size` points, scaled by
// `scale` (1 = as laid out).
export type Sheet = { root: Element; box: Box; size: { w: number; h: number }; at?: { x: number; y: number }; scale?: number };

export async function paint(sheets: Sheet[], title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  doc.setCreator("Nopload");
  doc.setProducer("Nopload (pdf-lib)");
  const fonts = new Fonts(doc);
  const images = new Map<string, Promise<PDFImage | null>>();
  const laidOut = new Map<Element, Item[]>();

  for (const sheet of sheets) {
    let items = laidOut.get(sheet.root);
    if (!items) laidOut.set(sheet.root, (items = collect(sheet.root)));
    const page = doc.addPage([sheet.size.w, sheet.size.h]);
    const k = PT * (sheet.scale ?? 1);
    const at = sheet.at ?? { x: 0, y: 0 };
    const { box } = sheet;
    const X = (x: number) => at.x + (x - box.x) * k;
    const Y = (y: number) => sheet.size.h - at.y - (y - box.y) * k;
    // Nothing spills outside the part of the layout this page shows.
    page.pushOperators(pushGraphicsState(), rectangle(at.x, sheet.size.h - at.y - box.h * k, box.w * k, box.h * k), clip(), endPath());
    for (const item of items) {
      const b = item.box;
      // Text belongs to the page its middle is on; boxes are drawn on every page they touch.
      if (item.kind === "text") {
        const mid = b.y + b.h / 2;
        if (mid < box.y || mid >= box.y + box.h) continue;
      } else if (b.y + b.h <= box.y || b.y >= box.y + box.h) continue;
      if (b.x + b.w <= box.x || b.x >= box.x + box.w) continue;
      if (item.kind === "link") {
        // The part of the link on this page, in page space.
        const x0 = Math.max(b.x, box.x), x1 = Math.min(b.x + b.w, box.x + box.w);
        const y0 = Math.max(b.y, box.y), y1 = Math.min(b.y + b.h, box.y + box.h);
        const annot = doc.context.obj({
          Type: "Annot", Subtype: "Link", Rect: [X(x0), Y(y1), X(x1), Y(y0)], Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of(item.url.replace(/[^\x20-\x7e]/g, encodeURIComponent).replace(/[\\()]/g, "\\$&")) },
        });
        page.node.addAnnot(doc.context.register(annot));
        continue;
      }
      try {
        await draw(page, item, X, Y, k, doc, fonts, images);
      } catch (e) {
        // One thing that can't be drawn doesn't cost the whole document; a missing font would cost all its text.
        if (e instanceof FontUnavailable) throw e;
      }
    }
    page.pushOperators(popGraphicsState());
  }
  return doc.save();
}

async function draw(page: PDFPage, item: Exclude<Item, { kind: "link" }>, X: (x: number) => number, Y: (y: number) => number, k: number, doc: PDFDocument, fonts: Fonts, images: Map<string, Promise<PDFImage | null>>) {
  const b = item.box;
  if (item.kind === "fill") {
    page.drawRectangle({ x: X(b.x), y: Y(b.y + b.h), width: b.w * k, height: b.h * k, color: rgb(item.color.r, item.color.g, item.color.b), opacity: item.color.a });
    return;
  }
  if (item.kind === "image") {
    const img = await imageOf(doc, item.el, images);
    if (img) page.drawImage(img, { x: X(b.x), y: Y(b.y + b.h), width: b.w * k, height: b.h * k });
    return;
  }
  const s = item.style;
  const face = await fonts.get(s.family, s.bold, s.italic);
  const pieces = await inFace(item.text, s, fonts);
  const size = s.size * k;
  // The line box of an inline run is the font's ascent + descent; the baseline sits between them.
  const baseline = Y(b.y + (b.h * face.ascent) / (face.ascent + face.descent));
  const x = X(b.x);
  const color = rgb(s.color.r, s.color.g, s.color.b);
  const text = item.text;
  if (pieces) {
    let at = x;
    for (const p of pieces) {
      page.drawText(p.text, { x: at, y: baseline, size, font: p.face.font, color, opacity: s.color.a });
      at += p.face.font.widthOfTextAtSize(p.text, size);
    }
  } else {
    // Without the Noto slices (offline before they were cached), or with a
    // character none of them has, the word would silently drop out of the
    // PDF; printing still has the browser's own fonts.
    const laid = await layoutText(doc, text, size, s.bold).catch((e) => {
      throw new FontUnavailable(`Fonts for "${text}" unavailable: ${e instanceof Error ? e.message : e}`);
    });
    if (!laid) throw new FontUnavailable(`No bundled font has every character of "${text}"`);
    for (const run of laid.runs) page.drawText(run.text, { x: x + run.x, y: baseline, size, font: run.font, color, opacity: s.color.a });
  }
  const width = b.w * k; // the measured box never includes the trailing space
  if (s.underline) page.drawRectangle({ x, y: baseline - size * 0.12, width, height: Math.max(0.5, size * 0.06), color });
  if (s.strike) page.drawRectangle({ x, y: baseline + size * 0.28, width, height: Math.max(0.5, size * 0.06), color });
}

// The word in the document's own font: each character in the subset the
// browser laid it out with (the first whose unicode-range has it), marks
// staying with their letter. Null if some character is in none of them.
async function inFace(text: string, s: TextStyle, fonts: Fonts) {
  const pieces: { face: Face; text: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const last = pieces[pieces.length - 1];
    if (last && /\p{M}/u.test(ch) && last.face.kit.hasGlyphForCodePoint(cp)) { last.text += ch; continue; }
    let face: Face | null = null;
    for (const subset of subsetsOf(s.family)) {
      if (!inSubset(subset, cp)) continue;
      const f = await fonts.get(s.family, s.bold, s.italic, subset);
      if (f.kit.hasGlyphForCodePoint(cp)) { face = f; break; }
    }
    if (!face) return null;
    if (last && last.face === face) last.text += ch;
    else pieces.push({ face, text: ch });
  }
  return pieces;
}

// ── CSS counters (Word's list numbers): docx-preview draws them with
// ::before and counter(), which the DOM can't measure or read back. Their
// values are worked out here, in document order, and each marker becomes a
// real span with the pseudo-element's look.
const STYLE_PROPS = ["font-family", "font-size", "font-weight", "font-style", "color", "display", "width", "min-width", "padding-right", "margin-right", "text-indent", "letter-spacing", "text-transform", "text-decoration-line", "vertical-align"];

function roman(n: number) {
  const map: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let out = "";
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}
function alpha(n: number) {
  let out = "";
  while (n > 0) { n--; out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}
export function formatCounter(n: number, style = "decimal") {
  switch (style.trim()) {
    case "lower-alpha": case "lower-latin": return alpha(n);
    case "upper-alpha": case "upper-latin": return alpha(n).toUpperCase();
    case "lower-roman": return roman(n);
    case "upper-roman": return roman(n).toUpperCase();
    case "decimal-leading-zero": return String(n).padStart(2, "0");
    case "disc": return "•";
    case "circle": return "◦";
    case "square": return "▪";
    case "none": return "";
    default: return String(n);
  }
}

const unescapeCss = (s: string) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));

export function resolveContent(content: string, counters: Map<string, number>) {
  if (content === "none" || content === "normal") return null;
  let out = "";
  for (const m of content.matchAll(/"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|counter\(\s*([^,)\s]+)\s*(?:,\s*([^)]+))?\)/g)) {
    if (m[3]) out += formatCounter(counters.get(m[3]) ?? 0, m[4]);
    else out += unescapeCss(m[1] ?? m[2] ?? "");
  }
  return out;
}

function applyCounters(cs: CSSStyleDeclaration, counters: Map<string, number>) {
  const pairs = (v: string, fallback: number) => {
    if (!v || v === "none") return [];
    const out: [string, number][] = [];
    const parts = v.trim().split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const n = Number(parts[i + 1]);
      if (parts[i + 1] !== undefined && Number.isFinite(n)) { out.push([parts[i], n]); i++; }
      else out.push([parts[i], fallback]);
    }
    return out;
  };
  for (const [name, n] of pairs(cs.counterReset, 0)) counters.set(name, n);
  for (const [name, n] of pairs(cs.counterIncrement, 1)) counters.set(name, (counters.get(name) ?? 0) + n);
  for (const [name, n] of pairs(cs.counterSet, 0)) counters.set(name, n);
}

export function materializeMarkers(root: Element) {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const counters = new Map<string, number>();
  applyCounters(win.getComputedStyle(doc.documentElement), counters);
  const found: { el: Element; text: string; style: CSSStyleDeclaration }[] = [];
  for (const el of root.querySelectorAll("*")) {
    applyCounters(win.getComputedStyle(el), counters);
    const before = win.getComputedStyle(el, "::before");
    if (before.content === "none" || before.content === "normal" || !before.content) continue;
    applyCounters(before, counters);
    const text = resolveContent(before.content, counters);
    if (text && /\S/.test(text)) found.push({ el, text, style: before });
  }
  if (!found.length) return;
  const css = doc.createElement("style");
  css.textContent = ".np-marker::before { content: none !important; }";
  doc.head.append(css);
  for (const { el, text, style } of found) {
    const span = doc.createElement("span");
    for (const p of STYLE_PROPS) span.style.setProperty(p, style.getPropertyValue(p));
    if (span.style.display === "block") span.style.display = "inline-block";
    span.textContent = text;
    el.prepend(span);
    el.classList.add("np-marker");
  }
}

// document.fonts.ready, except that WebKit can leave it pending for good once
// a face fails (seen with Carlito's Greek Extended subset in a sandboxed
// frame), so this also ends when no face is still loading, or after 20 s.
function fontsSettled(doc: Document) {
  return new Promise<void>((done) => {
    const started = Date.now();
    void doc.fonts.ready.then(() => done());
    const poll = () => {
      if (![...doc.fonts].some((f) => f.status === "loading") || Date.now() - started > 20000) done();
      else setTimeout(poll, 50);
    };
    setTimeout(poll, 50);
  });
}

// ── HTML the converters wrote (PowerPoint, Excel), laid out in a hidden
// frame of this origin. Its scripts can't run (sandbox without allow-scripts).
export async function inFrame<T>(html: string, width: number, withDoc: (doc: Document) => Promise<T>): Promise<T> {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${Math.ceil(width)}px;height:1000px;border:0;`;
  const faces = `<style>${fontFaces(fontBase(), html)}</style>`;
  frame.srcdoc = html.replace(/<head[^>]*>/i, (m) => m + faces);
  const loaded = new Promise<void>((ok) => frame.addEventListener("load", () => ok(), { once: true }));
  document.body.append(frame);
  try {
    await loaded;
    const doc = frame.contentDocument!;
    void doc.body.offsetHeight; // lay out, so the fonts it uses start loading
    await fontsSettled(doc);
    await Promise.all([...doc.images].map((i) => (i.complete ? null : i.decode().catch(() => {}))));
    return await withDoc(doc);
  } finally {
    frame.remove();
  }
}

// ── Office files → PDF bytes, by format.
const A4 = { w: 595, h: 842 };
const MARGIN = 28; // pt, as html.ts sheets print

export async function officePdf(data: Uint8Array, ext: string, o: { orientation?: string }, title: string): Promise<Uint8Array> {
  if (ext === "docx") return docxPdf(data, title);
  const office = await import("./html");
  if (ext === "pptx") {
    const html = await office.pptxHtml(data);
    const w = Number(html.match(/\.slide \{[^}]*width: ([\d.]+)pt/)?.[1] ?? 960) / PT;
    return inFrame(html, w, async (doc) => {
      const slides = [...doc.querySelectorAll<HTMLElement>(".slide")].map((root) => {
        const box = toBox(root.getBoundingClientRect());
        return { root, box, size: { w: box.w * PT, h: box.h * PT } };
      });
      return paint(slides, title);
    });
  }
  if (ext === "xlsx" || ext === "csv") {
    const html = await office.sheetHtml(data, ext, o.orientation ?? "auto");
    return inFrame(html, (A4.h - 2 * MARGIN) / PT, async (doc) => {
      const sheets: Sheet[] = [];
      for (const section of doc.querySelectorAll<HTMLElement>("section.sheet")) {
        const landscape = /page:\s*land/.test(section.getAttribute("style") ?? "");
        const size = landscape ? { w: A4.h, h: A4.w } : A4;
        // Laid out at full size; the zoom that fits the page is applied while drawing.
        const table = section.querySelector<HTMLElement>("table");
        const scale = parseFloat(table?.style.zoom ?? "") || 1;
        if (table) table.style.zoom = "1";
        sheets.push(...slice(section, size, scale));
      }
      return paint(sheets, title);
    });
  }
  throw new Error(`.${ext} can't be drawn as a PDF here.`);
}

// A long section over as many pages as it takes, cut between table rows.
function slice(section: HTMLElement, size: { w: number; h: number }, scale: number): Sheet[] {
  const top = section.getBoundingClientRect();
  const width = (size.w - 2 * MARGIN) / (PT * scale);
  const height = (size.h - 2 * MARGIN) / (PT * scale);
  const rows = [...section.querySelectorAll("tr")].map((tr) => tr.getBoundingClientRect().bottom);
  const content = Math.max(top.bottom, ...rows);
  const out: Sheet[] = [];
  for (let y = top.top; y < content - 0.5 && out.length < 2000; ) {
    const fits = rows.filter((b) => b > y + 0.5 && b <= y + height + 0.5);
    const end = fits.length ? Math.max(...fits) : Math.min(content, y + height);
    out.push({ root: section, box: { x: top.left, y, w: width, h: end - y }, size, at: { x: MARGIN, y: MARGIN }, scale });
    y = end;
  }
  return out.length ? out : [{ root: section, box: { x: top.left, y: top.top, w: width, h: height }, size, at: { x: MARGIN, y: MARGIN }, scale }];
}

// Word: docx-preview's pages (docx.ts), one section.docx per page.
const px = (v: string) => (v.endsWith("pt") ? parseFloat(v) / PT : v.endsWith("mm") ? (parseFloat(v) * 96) / 25.4 : v.endsWith("in") ? parseFloat(v) * 96 : parseFloat(v));

async function docxPdf(input: Uint8Array, title: string): Promise<Uint8Array> {
  const { renderDocx } = await import("./docx");
  return renderDocx(input, async (body, sections) => {
    materializeMarkers(body);
    const sheets = sections.flatMap((root) => {
      const r = root.getBoundingClientRect();
      const w = px(root.style.width) || r.width;
      const h = px(root.style.minHeight || root.style.height) || r.height;
      // A block taller than a page (left whole by paginate) carries on over more pages.
      const pages = Math.max(1, Math.ceil((r.height - 1) / h));
      return Array.from({ length: pages }, (_, i) => ({ root, box: { x: r.left, y: r.top + i * h, w, h }, size: { w: w * PT, h: h * PT } }));
    });
    return paint(sheets, title);
  }, fontFaces(fontBase()));
}
