"use client";

// Turns pdf.js text items into lines and paragraphs with sizes and positions.
// Word, Excel, Markdown, compare, redact and translate all build on this.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem } from "pdfjs-dist/types/src/display/api";

// `xs` (when known) holds each character's left edge plus the run's right edge, for exact boxes.
// `font` is a family name ("Times New Roman"), `color` a hex fill ("#cc1a1a"), `link` a URL.
// `turn` marks text that doesn't run left to right (a label up the margin, a
// page turned upside down): its direction in degrees clockwise, where its
// baseline starts, and each character's distance from there along it plus the
// end, like `xs`. x, y, w and h are then the box around it, and `xs` is unset.
export type Run = {
  text: string; x: number; y: number; w: number; h: number; size: number; bold: boolean; italic: boolean;
  xs?: number[]; font?: string; color?: string; link?: string;
  turn?: { angle: number; x: number; y: number; at: number[] };
};
export type Line = { runs: Run[]; text: string; x: number; y: number; w: number; size: number; bold: boolean };
// `rotation` is the viewport rotation the coordinates are in, for drawing the same view.
export type PageText = { width: number; height: number; lines: Line[]; items: Run[]; rotation?: number };

// Coordinates are top-left origin in PDF points, in the page as seen (the
// viewport at scale 1). With `upright`, a page whose text mostly runs another
// way (a table printed sideways, a page turned with Rotate) is read turned so
// that it runs left to right, the way a reader would hold it.
export async function pageText(page: PDFPageProxy, o: { upright?: boolean } = {}): Promise<PageText> {
  try {
    const glyphs = await placedGlyphs(page);
    const rotation = o.upright ? uprightRotation(page, glyphs) : page.rotate;
    const view = page.getViewport({ scale: 1, rotation });
    const items = glyphRuns(glyphs, view);
    if (items.length) return { width: view.width, height: view.height, rotation, lines: groupLines(items), items };
  } catch {
    // Fall back to pdf.js text items below.
  }
  const viewport = page.getViewport({ scale: 1 });
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
  return { width: viewport.width, height: viewport.height, rotation: page.rotate, lines: groupLines(items), items };
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

// One glyph as drawn: the start and end of its advance in PDF user space, the
// text direction there (for glyphs with no advance) and its style. `null`
// ends a text object; runs never continue across one.
type Placed = {
  ch: string; space: boolean; px: number; py: number; ex: number; ey: number; dx: number; dy: number;
  size: number; bold: boolean; italic: boolean; font?: string; color: string;
} | null;
type View = ReturnType<PDFPageProxy["getViewport"]>;

async function placedGlyphs(page: PDFPageProxy): Promise<Placed[]> {
  const { OPS } = await import("pdfjs-dist");
  const list = await page.getOperatorList();
  const out: Placed[] = [];
  type GS = { ctm: M; font: FontObj | null; size: number; cs: number; ws: number; hs: number; lead: number; rise: number; fill: string };
  let gs: GS = { ctm: [1, 0, 0, 1, 0, 0], font: null, size: 0, cs: 0, ws: 0, hs: 1, lead: 0, rise: 0, fill: "#000000" };
  const stack: GS[] = [];
  let tm: M = [1, 0, 0, 1, 0, 0];
  let tlm: M = [1, 0, 0, 1, 0, 0];

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
      const size = Math.hypot(trm[2], trm[3]) * gs.size;
      const ch = (g.unicode ?? "").normalize("NFKC");
      x += adv;
      if (size < 1) continue;
      out.push({ ch, space: !ch.trim(), px, py, ex, ey, dx: trm[0], dy: trm[1], size, bold, italic, font: family, color });
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
      case OPS.endText: out.push(null); break;
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
  return out;
}

// ── Direction
// A run is built in its own frame, turned so that it reads left to right:
// u along the baseline, v across it (down). Text that runs left to right on
// the page keeps u = x and v = y, so it's measured exactly as before.

// Direction of travel in degrees clockwise (y down). Within 10° of an axis
// counts as that axis, so slightly skewed scans read as before.
function angleOf(dx: number, dy: number) {
  const a = ((((Math.atan2(dy, dx) * 180) / Math.PI) % 360) + 360) % 360;
  const axis = Math.round(a / 90) * 90;
  return Math.abs(a - axis) <= 10 ? axis % 360 : a;
}
const sameWay = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180) < 3;
// cos and sin without the 1e-16 noise at right angles.
const trig = (angle: number): [number, number] => {
  const r = (angle * Math.PI) / 180;
  return [Math.round(Math.cos(r) * 1e12) / 1e12, Math.round(Math.sin(r) * 1e12) / 1e12];
};

// A glyph on the page as seen: the start and end of its advance, and its direction.
function place(g: NonNullable<Placed>, view: View): [number, number, number, number, number] {
  const [vx, vy] = view.convertToViewportPoint(g.px, g.py);
  const [vex, vey] = view.convertToViewportPoint(g.ex, g.ey);
  let dx = vex - vx;
  let dy = vey - vy;
  if (Math.abs(dx) + Math.abs(dy) < 1e-6) {
    // No advance (an accent, a zero-width glyph): the text direction instead.
    const [ax, ay] = view.convertToViewportPoint(g.px + g.dx, g.py + g.dy);
    dx = ax - vx;
    dy = ay - vy;
  }
  return [vx, vy, vex, vey, angleOf(dx, dy)];
}

// The viewport rotation that turns most of the page's text to run left to right.
function uprightRotation(page: PDFPageProxy, glyphs: Placed[]) {
  const view = page.getViewport({ scale: 1 });
  const count = new Map<number, number>();
  for (const g of glyphs) {
    if (!g || g.space) continue;
    const angle = place(g, view)[4];
    if (angle % 90 === 0) count.set(angle, (count.get(angle) ?? 0) + 1);
  }
  let best = 0;
  for (const [angle, n] of count) if (n > (count.get(best) ?? 0)) best = angle;
  return (page.rotate + 360 - best) % 360;
}

function glyphRuns(glyphs: Placed[], view: View): Run[] {
  const runs: Run[] = [];
  type Cur = {
    text: string; x: number; endX: number; baseY: number; size: number; xs: number[]; angle: number; c: number; s: number;
    bold: boolean; italic: boolean; font?: string; color: string;
  };
  let cur: Cur | null = null;

  const flush = (r: Cur | null) => {
    if (!r || !r.text.trim()) return;
    const text = r.text.replace(/\s+$/, "");
    const xs = [...r.xs.slice(0, text.length), r.endX];
    const style = { size: r.size, bold: r.bold, italic: r.italic, font: r.font, color: r.color };
    if (!r.angle) {
      runs.push({ text, x: r.x, y: r.baseY - r.size, w: r.endX - r.x, h: r.size, xs, ...style });
      return;
    }
    // Back on the page: the box around the run, and where its baseline starts.
    const back = (u: number, v: number) => [u * r.c - v * r.s, u * r.s + v * r.c];
    const pts = [back(r.x, r.baseY), back(r.endX, r.baseY), back(r.x, r.baseY - r.size), back(r.endX, r.baseY - r.size)];
    const x0 = Math.min(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1]));
    const x1 = Math.max(...pts.map((p) => p[0]));
    const y1 = Math.max(...pts.map((p) => p[1]));
    runs.push({
      text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, ...style,
      turn: { angle: r.angle, x: pts[0][0], y: pts[0][1], at: xs.map((u) => u - r.x) },
    });
  };

  for (const g of glyphs) {
    if (!g) {
      flush(cur);
      cur = null;
      continue;
    }
    if (g.space) {
      // Spaces only mark a word break; real gaps are measured below.
      if (cur && !cur.text.endsWith(" ")) {
        cur.text += " ";
        cur.xs.push(cur.endX);
      }
      continue;
    }
    const [vx, vy, vex, vey, angle] = place(g, view);
    const size = g.size;
    // Glyphs going the same way are measured in the current run's frame.
    const prev = cur as Cur | null;
    const same: boolean = prev !== null && sameWay(prev.angle, angle);
    const frame: number = prev && same ? prev.angle : angle;
    const cs: [number, number] = prev && same ? [prev.c, prev.s] : trig(angle);
    const [c, s] = cs;
    const u0 = vx * c + vy * s;
    const u1 = vex * c + vey * s;
    const v: number = vy * c - vx * s;
    const left = Math.min(u0, u1);
    const right = Math.max(u0, u1);
    const gap = cur ? left - cur.endX : 0;
    const sameLine = cur && same && Math.abs(v - cur.baseY) < size * 0.35 && Math.abs(size - cur.size) < size * 0.25;
    const restyled = cur && (cur.bold !== g.bold || cur.italic !== g.italic || cur.color !== g.color || cur.font !== g.font);
    if (!cur || !sameLine || gap > size * 1.0 || gap < -size * 0.5 || restyled) {
      // groupLines puts the space back between restyled runs from the gap.
      flush(cur);
      cur = { text: "", x: left, endX: left, baseY: v, size, xs: [], angle: frame, c, s, bold: g.bold, italic: g.italic, font: g.font, color: g.color };
    } else if (gap > size * 0.22 && !cur.text.endsWith(" ")) {
      cur.text += " ";
      cur.xs.push(cur.endX);
    }
    // A glyph can map to several characters (ligatures); they share its box.
    for (let k = 0; k < g.ch.length; k++) cur.xs.push(left + ((right - left) * k) / g.ch.length);
    cur.text += g.ch;
    cur.endX = Math.max(cur.endX, right);
  }
  flush(cur);
  return runs;
}

export function groupLines(items: Run[]): Line[] {
  const lines = linesOf(items.filter((r) => !r.turn));
  // Turned runs are grouped in their own frame, where they read left to right.
  // Each of their lines becomes one run, so its words stay in reading order
  // for everything downstream.
  const ways = new Map<number, Run[]>();
  for (const r of items) {
    if (!r.turn) continue;
    const key = Math.round(r.turn.angle) % 360;
    ways.set(key, [...(ways.get(key) ?? []), r]);
  }
  for (const [angle, runs] of ways) {
    const [c, s] = trig(angle);
    const level = runs.map((r): Run => {
      const t = r.turn!;
      const u = t.x * c + t.y * s;
      const v = t.y * c - t.x * s;
      return { ...r, turn: undefined, x: u, y: v - r.size, w: t.at[t.at.length - 1], h: r.size, xs: t.at.map((a) => u + a) };
    });
    for (const l of linesOf(level)) lines.push(turnLine(l, angle, c, s));
  }
  return lines.sort((p, q) => p.y - q.y || p.x - q.x);
}

function linesOf(items: Run[]): Line[] {
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
    const last = l.runs[l.runs.length - 1];
    l.text = lineChars(l.runs).text;
    l.x = l.runs[0].x;
    l.w = last.x + last.w - l.x;
    l.y = Math.min(...l.runs.map((r) => r.y));
    l.bold = l.runs.every((r) => r.bold || !r.text.trim());
  }
  return lines.filter((l) => l.text).sort((p, q) => p.y - q.y || p.x - q.x);
}

// A line's text, and where each of its characters comes from: [run, index]
// in `runs` (sorted left to right), or null for a space put between runs.
// Runs further apart than a narrow space get one; whitespace collapses to
// single spaces and the ends are trimmed.
export function lineChars(runs: Run[]): { text: string; from: ([number, number] | null)[] } {
  let text = "";
  const from: ([number, number] | null)[] = [];
  const add = (ch: string, at: [number, number] | null) => {
    if (/\s/.test(ch)) {
      if (!text || text.endsWith(" ")) return;
      ch = " ";
    }
    text += ch;
    from.push(at);
  };
  let lastEnd = -Infinity;
  runs.forEach((r, ri) => {
    if (r.x - lastEnd > r.size * 0.18) add(" ", null);
    for (let k = 0; k < r.text.length; k++) add(r.text[k], [ri, k]);
    lastEnd = r.x + r.w;
  });
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    from.pop();
  }
  return { text, from };
}

// A line of turned runs, measured in their own frame, as one run on the page.
function turnLine(l: Line, angle: number, c: number, s: number): Line {
  const { text, from } = lineChars(l.runs);
  const at: number[] = [];
  let end = l.runs[0].x;
  for (const f of from) {
    const xs = f && l.runs[f[0]].xs;
    // A space put between runs starts where the character before it ends.
    at.push(f && xs ? xs[f[1]] : end);
    if (f && xs) end = xs[f[1] + 1];
  }
  at.push(end);
  const u0 = at[0];
  const v = l.runs[0].y + l.runs[0].size;
  const back = (u: number, w: number) => [u * c - w * s, u * s + w * c];
  const pts = l.runs.flatMap((r) => [back(r.x, r.y), back(r.x + r.w, r.y), back(r.x, r.y + r.h), back(r.x + r.w, r.y + r.h)]);
  const x0 = Math.min(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const [ox, oy] = back(u0, v);
  const first = l.runs[0];
  const run: Run = {
    text, x: x0, y: y0, w: Math.max(...pts.map((p) => p[0])) - x0, h: Math.max(...pts.map((p) => p[1])) - y0,
    size: l.size, bold: l.runs.every((r) => r.bold), italic: l.runs.every((r) => r.italic), font: first.font, color: first.color,
    turn: { angle, x: ox, y: oy, at: at.map((a) => a - u0) },
  };
  return { runs: [run], text, x: run.x, y: run.y, w: run.w, size: run.size, bold: run.bold };
}

// The box around characters [start, end) of a run on the page, from the top
// of the em to below the descenders.
export function charBox(run: Run, start: number, end: number): { x: number; y: number; w: number; h: number } {
  if (run.turn) {
    const { angle, x, y, at } = run.turn;
    const [c, s] = trig(angle);
    const a = at[Math.min(start, at.length - 1)];
    const b = at[Math.min(end, at.length - 1)];
    const below = run.size * 0.2;
    const pts = [[a, below], [b, below], [a, -run.size], [b, -run.size]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
    const x0 = Math.min(...pts.map((p) => p[0]));
    const y0 = Math.min(...pts.map((p) => p[1]));
    return { x: x0, y: y0, w: Math.max(...pts.map((p) => p[0])) - x0, h: Math.max(...pts.map((p) => p[1])) - y0 };
  }
  const n = run.text.length;
  const exact = run.xs && run.xs.length === n + 1;
  const per = run.w / Math.max(1, n);
  const x0 = exact ? run.xs![start] : run.x + per * start;
  const x1 = exact ? run.xs![end] : run.x + per * end;
  return { x: x0, y: run.y, w: x1 - x0, h: run.size * 1.2 };
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
