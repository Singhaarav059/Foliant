"use client";

// Turns pdf.js text items into lines and paragraphs with sizes and positions.
// Word, Excel, Markdown, compare, redact and translate all build on this.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

// `xs` (when known) holds each character's left edge plus the run's right edge, for exact boxes.
// `font` is a family name ("Times New Roman"), `color` a hex fill ("#cc1a1a"), `link` a URL.
export type Run = {
  text: string; x: number; y: number; w: number; h: number; size: number; bold: boolean; italic: boolean;
  xs?: number[]; font?: string; color?: string; link?: string;
};
export type Line = { runs: Run[]; text: string; x: number; y: number; w: number; size: number; bold: boolean };
export type PageText = { width: number; height: number; lines: Line[]; items: Run[] };

// Coordinates are top-left origin in PDF points (unrotated page = viewport at scale 1).
export async function pageText(page: PDFPageProxy): Promise<PageText> {
  const viewport = page.getViewport({ scale: 1 });
  try {
    const items = await glyphRuns(page, viewport);
    if (items.length) return { width: viewport.width, height: viewport.height, lines: groupLines(items), items };
  } catch {
    // Fall back to pdf.js text items below.
  }
  const content = await page.getTextContent();
  const styles = content.styles as Record<string, { fontFamily?: string }>;
  const items: Run[] = [];
  for (const raw of content.items) {
    const it = raw as TextItem;
    if (!("str" in it) || !it.str) continue;
    const [a, b, , d, e, f] = it.transform;
    const size = Math.hypot(a, b) || Math.abs(d) || 10;
    // Convert the baseline origin to viewport space so rotation is handled.
    const [vx, vy] = viewport.convertToViewportPoint(e, f);
    const fontName = `${it.fontName} ${styles[it.fontName]?.fontFamily ?? ""}`.toLowerCase();
    items.push({
      text: it.str,
      x: vx,
      y: vy - size, // top of the run
      w: it.width || size * it.str.length * 0.5,
      h: size,
      size,
      bold: /bold|black|heavy|semibold|w[6-9]00/.test(fontName),
      italic: /italic|oblique/.test(fontName),
    });
  }
  return { width: viewport.width, height: viewport.height, lines: groupLines(items), items };
}

// ── Exact glyph positions
// pdf.js merges text on a line into one item and replaces gaps of any size
// with a single space, which loses table columns and makes per-character
// positions guesses. Walking the operator list with the text state gives
// each glyph's real position, so runs split where the real gaps are.

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
// pdf.js 6 passes matrices as one typed-array argument; older builds passed six numbers.
const asMatrix = (a: unknown[]): M => {
  const src = a.length === 1 && a[0] && typeof a[0] === "object" ? (a[0] as ArrayLike<number>) : (a as unknown as ArrayLike<number>);
  return [src[0], src[1], src[2], src[3], src[4], src[5]].map(Number) as M;
};
const apply = (m: M, x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

type Glyph = { unicode?: string; width?: number; isSpace?: boolean } | number | null;
type FontObj = {
  fontMatrix?: number[]; name?: string; loadedName?: string; fallbackName?: string;
  bold?: boolean; black?: boolean; italic?: boolean; vertical?: boolean;
};

const GENERIC: Record<string, string> = { serif: "Times New Roman", "sans-serif": "Arial", monospace: "Courier New" };
const RENAME: Record<string, string> = { Helvetica: "Arial", Times: "Times New Roman", "Times Roman": "Times New Roman", Courier: "Courier New" };

// "ABCDEF+TimesNewRomanPS-BoldMT" → "Times New Roman"; standard fonts fall back to a generic family.
export function fontFamily(font: FontObj): string | undefined {
  const raw = (font.name ?? "").replace(/^[A-Z]{6}\+/, "").split(/[-,]/)[0].replace(/(PSMT|PS|MT)$/, "");
  const name = raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s*(Bold|Italic|Oblique|Regular|Light|Medium|Semibold|Black)$/i, "").trim();
  if (name && !/^g_d\d/.test(name)) return RENAME[name] ?? name;
  return GENERIC[font.fallbackName ?? ""];
}

async function glyphRuns(page: PDFPageProxy, viewport: ReturnType<PDFPageProxy["getViewport"]>): Promise<Run[]> {
  const { OPS } = await import("pdfjs-dist");
  const list = await page.getOperatorList();
  const runs: Run[] = [];
  type GS = { ctm: M; font: FontObj | null; size: number; cs: number; ws: number; hs: number; lead: number; rise: number; fill: string };
  let gs: GS = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, cs: 0, ws: 0, hs: 1, lead: 0, rise: 0, fill: "#000000" };
  const stack: GS[] = [];
  let tm: M = [1, 0, 0, 1, 0, 0];
  let tlm: M = [1, 0, 0, 1, 0, 0];
  let cur: (Run & { endX: number; baseY: number }) | null = null;

  const flush = () => {
    if (cur && cur.text.trim()) {
      const text = cur.text.replace(/\s+$/, "");
      const xs = [...(cur.xs ?? []).slice(0, text.length), cur.endX];
      runs.push({ text, x: cur.x, y: cur.y, w: cur.endX - cur.x, h: cur.h, size: cur.size, bold: cur.bold, italic: cur.italic, xs, font: cur.font, color: cur.color });
    }
    cur = null;
  };

  const show = (glyphs: Glyph[]) => {
    const font = gs.font;
    if (!font || font.vertical) return;
    const fm = font.fontMatrix?.[0] ?? 0.001;
    const name = `${font.name ?? ""} ${font.loadedName ?? ""}`.toLowerCase();
    const bold = Boolean(font.bold || font.black) || /bold|black|heavy|semibold/.test(name);
    const italic = Boolean(font.italic) || /italic|oblique/.test(name);
    const family = fontFamily(font);
    const color = gs.fill;
    let x = 0;
    for (const g of glyphs) {
      if (g === null) continue;
      if (typeof g === "number") {
        x += (-g / 1000) * gs.size * gs.hs;
        continue;
      }
      const adv = ((g.width ?? 0) * fm * gs.size + gs.cs + (g.isSpace ? gs.ws : 0)) * gs.hs;
      const trm = mul(tm, gs.ctm);
      const [px, py] = apply(trm, x, gs.rise);
      const [ex, ey] = apply(trm, x + adv, gs.rise);
      const [vx, vy] = viewport.convertToViewportPoint(px, py);
      const [vex] = viewport.convertToViewportPoint(ex, ey);
      const size = Math.hypot(trm[2], trm[3]) * gs.size;
      const ch = (g.unicode ?? "").normalize("NFKC");
      x += adv;
      if (size < 1) continue;
      if (!ch.trim()) {
        // Spaces only mark a word break; real gaps are measured below.
        if (cur && !cur.text.endsWith(" ")) {
          cur.text += " ";
          cur.xs!.push(cur.endX);
        }
        continue;
      }
      const left = Math.min(vx, vex);
      const right = Math.max(vx, vex);
      const gap = cur ? left - cur.endX : 0;
      const sameLine = cur && Math.abs(vy - cur.baseY) < size * 0.35 && Math.abs(size - cur.size) < size * 0.25;
      const restyled = cur && (cur.bold !== bold || cur.italic !== italic || cur.color !== color || cur.font !== family);
      if (!cur || !sameLine || gap > size * 1.0 || gap < -size * 0.5 || restyled) {
        // groupLines puts the space back between restyled runs from the gap.
        flush();
        cur = { text: "", x: left, y: vy - size, w: 0, h: size, size, bold, italic, endX: left, baseY: vy, xs: [], font: family, color };
      } else if (gap > size * 0.22 && !cur.text.endsWith(" ")) {
        cur.text += " ";
        cur.xs!.push(cur.endX);
      }
      // A glyph can map to several characters (ligatures); they share its box.
      for (let k = 0; k < ch.length; k++) cur.xs!.push(left + ((right - left) * k) / ch.length);
      cur.text += ch;
      cur.endX = Math.max(cur.endX, right);
    }
    tm = mul([1, 0, 0, 1, x, 0], tm);
  };

  const { fnArray, argsArray } = list;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save: stack.push({ ...gs }); break;
      case OPS.restore: gs = stack.pop() ?? gs; break;
      case OPS.transform: gs.ctm = mul(asMatrix(a), gs.ctm); break;
      case OPS.paintFormXObjectBegin:
        stack.push({ ...gs });
        if (a[0] && typeof a[0] === "object") gs.ctm = mul(asMatrix([a[0]]), gs.ctm);
        break;
      case OPS.paintFormXObjectEnd: gs = stack.pop() ?? gs; break;
      case OPS.beginText: tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
      case OPS.endText: flush(); break;
      case OPS.setFont: {
        const id = a[0] as string;
        gs.font = page.commonObjs.has(id) ? (page.commonObjs.get(id) as FontObj) : null;
        gs.size = a[1] as number;
        break;
      }
      case OPS.setCharSpacing: gs.cs = a[0] as number; break;
      // pdf.js turns every fill colour space into an RGB hex string.
      case OPS.setFillRGBColor: if (typeof a[0] === "string") gs.fill = a[0]; break;
      case OPS.setWordSpacing: gs.ws = a[0] as number; break;
      case OPS.setHScale: gs.hs = (a[0] as number) / 100; break;
      case OPS.setLeading: gs.lead = a[0] as number; break;
      case OPS.setTextRise: gs.rise = a[0] as number; break;
      case OPS.setTextMatrix: tm = tlm = asMatrix(a); break;
      case OPS.moveText: tm = tlm = mul([1, 0, 0, 1, a[0] as number, a[1] as number], tlm); break;
      case OPS.setLeadingMoveText:
        gs.lead = -(a[1] as number);
        tm = tlm = mul([1, 0, 0, 1, a[0] as number, a[1] as number], tlm);
        break;
      case OPS.nextLine: tm = tlm = mul([1, 0, 0, 1, 0, -gs.lead], tlm); break;
      case OPS.nextLineShowText:
        tm = tlm = mul([1, 0, 0, 1, 0, -gs.lead], tlm);
        show(a[0] as Glyph[]);
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        show(a[0] as Glyph[]);
        break;
    }
  }
  flush();
  return runs;
}

export function groupLines(items: Run[]): Line[] {
  const sorted = [...items].sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: Line[] = [];
  for (const run of sorted) {
    const mid = run.y + run.h / 2;
    const line = lines.find((l) => Math.abs(l.y + l.size / 2 - mid) < Math.max(l.size, run.h) * 0.45);
    if (line) {
      line.runs.push(run);
      line.size = Math.max(line.size, run.size);
    } else {
      lines.push({ runs: [run], text: "", x: run.x, y: run.y, w: 0, size: run.size, bold: false });
    }
  }
  for (const l of lines) {
    l.runs.sort((p, q) => p.x - q.x);
    let text = "";
    let lastEnd = -Infinity;
    for (const r of l.runs) {
      const gap = r.x - lastEnd;
      if (text && gap > r.size * 0.18 && !text.endsWith(" ") && !r.text.startsWith(" ")) text += " ";
      text += r.text;
      lastEnd = r.x + r.w;
    }
    l.text = text.replace(/\s+/g, " ").trim();
    l.x = l.runs[0].x;
    l.w = lastEnd - l.x;
    l.y = Math.min(...l.runs.map((r) => r.y));
    l.bold = l.runs.every((r) => r.bold || !r.text.trim());
  }
  return lines.filter((l) => l.text).sort((p, q) => p.y - q.y || p.x - q.x);
}

export type Block = { kind: "heading" | "paragraph" | "list"; level?: number; text: string; size: number; bold: boolean; lines: Line[] };

// Groups lines into headings, list items and paragraphs using size and spacing.
export function blocks(lines: Line[], bodySize: number): Block[] {
  const out: Block[] = [];
  let prev: Line | null = null;
  for (const l of lines) {
    const ratio = l.size / bodySize;
    const isHeading = (ratio > 1.18 || (l.bold && ratio > 1.02 && l.text.length < 90)) && l.text.length < 140;
    const bullet = l.text.match(/^([•◦▪●○■\-–*]|\d{1,3}[.)]|[a-z][.)])\s+(.*)$/i);
    const gap = prev ? l.y - (prev.y + prev.size) : 0;
    const last = out[out.length - 1];
    if (isHeading) {
      const level = ratio > 1.8 ? 1 : ratio > 1.4 ? 2 : 3;
      if (last && last.kind === "heading" && last.level === level && prev && gap < l.size * 0.6) {
        last.text += " " + l.text;
        last.lines.push(l);
      } else out.push({ kind: "heading", level, text: l.text, size: l.size, bold: true, lines: [l] });
    } else if (bullet) {
      out.push({ kind: "list", text: l.text, size: l.size, bold: l.bold, lines: [l] });
    } else if (
      last && (last.kind === "paragraph" || last.kind === "list") && prev &&
      gap < Math.max(l.size, prev.size) * 0.85 && Math.abs(l.size - prev.size) < 1.5
    ) {
      const joined = last.text.endsWith("-") ? last.text.slice(0, -1) + l.text : last.text + " " + l.text;
      last.text = joined;
      last.lines.push(l);
    } else {
      out.push({ kind: "paragraph", text: l.text, size: l.size, bold: l.bold, lines: [l] });
    }
    prev = l;
  }
  return out;
}

export function bodySizeOf(pages: { lines: Line[] }[]) {
  const counts = new Map<number, number>();
  for (const p of pages)
    for (const l of p.lines) {
      const s = Math.round(l.size * 2) / 2;
      counts.set(s, (counts.get(s) ?? 0) + l.text.length);
    }
  let best = 11;
  let max = 0;
  for (const [s, n] of counts) if (n > max) [best, max] = [s, n];
  return best;
}

export async function documentText(doc: PDFDocumentProxy, onPage?: (i: number) => void) {
  const pages: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push(await pageText(page));
    page.cleanup();
    onPage?.(i);
  }
  return pages;
}

export function plainText(p: PageText) {
  return p.lines.map((l) => l.text).join("\n");
}

// ── Styled text for Word and Markdown

export type Span = { text: string; bold: boolean; italic: boolean; size: number; font?: string; color?: string; link?: string; br?: boolean };

// Joins lines into styled spans: neighbouring runs with the same style merge,
// lines join with a space (or a line break when `breaks`), and words broken
// with a hyphen at a line end are put back together.
export function spans(lines: Line[], breaks = false): Span[] {
  const out: Span[] = [];
  const same = (a: Span, r: Run) =>
    !a.br && a.bold === r.bold && a.italic === r.italic && a.font === r.font && a.color === r.color && a.link === r.link && Math.abs(a.size - r.size) < 0.6;
  lines.forEach((l, li) => {
    let lastEnd = -Infinity;
    l.runs.forEach((r, ri) => {
      const last = out[out.length - 1];
      let text = r.text;
      if (ri === 0 && li > 0 && last) {
        if (breaks) out.push({ ...last, text: "", br: true, link: undefined });
        else if (/[a-z]-$/.test(last.text) && /^[a-z]/.test(text)) last.text = last.text.slice(0, -1);
        else if (!last.text.endsWith(" ")) last.text += " ";
      } else if (ri > 0 && last && r.x - lastEnd > r.size * 0.18 && !last.text.endsWith(" ") && !text.startsWith(" ")) {
        // The space goes on the run before, so a link doesn't start with one.
        last.text += " ";
      }
      lastEnd = r.x + r.w;
      const tail = out[out.length - 1];
      if (tail && same(tail, r)) tail.text += text;
      else {
        if (!out.length) text = text.trimStart();
        out.push({ text, bold: r.bold, italic: r.italic, size: r.size, font: r.font, color: r.color, link: r.link });
      }
    });
  });
  for (const s of out) s.text = s.text.replace(/\s+/g, " ");
  if (out.length) out[out.length - 1].text = out[out.length - 1].text.trimEnd();
  return out.filter((s) => s.text || s.br);
}

// Removes the first `n` characters (a list marker) from spans.
export function dropChars(list: Span[], n: number): Span[] {
  const out = list.map((s) => ({ ...s }));
  for (const s of out) {
    if (n <= 0) break;
    const take = Math.min(n, s.text.length);
    s.text = s.text.slice(take);
    n -= take;
  }
  if (out[0]) out[0].text = out[0].text.trimStart();
  return out.filter((s) => s.text || s.br);
}
