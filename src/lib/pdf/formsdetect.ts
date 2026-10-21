"use client";

// Finds the blanks of a flat form, on the device and without a model, from
// what the page draws: runs of underscores in the text, answer lines drawn
// beside a label or above a caption, small empty squares and box glyphs (☐),
// and empty ruled cells and boxes (found with tables.ts). Each blank becomes
// a suggested text field, date field, signature field or checkbox, named
// after its label, for the user to accept or reject.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { charBox, pageText, type PageText, type Run } from "./text";
import { mergeEdges, pageEdges, ruledCells, type Edges, type Rect } from "./tables";
import { DATE_FORMATS, type DateFormat } from "./formsmeta";
import type { EditorItem } from "./edit";

export type DetectedKind = "textField" | "checkbox" | "dateField" | "signatureField";
// x, y, w, h are fractions of the page as seen, top-left origin, like EditorItem.
export type Suggestion = {
  id: string; page: number; kind: DetectedKind; label: string;
  x: number; y: number; w: number; h: number;
  multiline?: boolean; dateFormat?: DateFormat;
};
type Found = Omit<Suggestion, "id" | "page" | "x" | "y" | "w" | "h"> & Rect & { rank: number };

const SIGN = /\b(sign(ature|ed)?|signed by|unterschrift|firma|signatur[ea]?|assinatura|handtekening|podpis)\b/i;
const DATE = /\b(date|dated|datum|fecha|dob|d\.o\.b\.?)\b/i;
// "Date (dd/mm/yyyy)": the format a label asks for.
const FORMAT = /\(?\b(dd|mm|yyyy)([./-])(dd|mm)\2(yyyy|yy)\b\)?/i;
const BOXES = /[☐□▢❏❐❑❒]/g;

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const overlap = (a: Rect, b: Rect) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const iou = (a: Rect, b: Rect) => {
  const o = overlap(a, b);
  return o / (area(a) + area(b) - o || 1);
};
const runBox = (r: Run): Rect => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });

// A label as a field name: no trailing colon, no blank characters, not too long.
function clean(text: string) {
  return text.replace(/_{2,}|\.{3,}|…+/g, " ").replace(BOXES, " ").replace(/\s+/g, " ").replace(/^[\s:*•·-]+|[\s:*•·-]+$/g, "").slice(-48).trim();
}

function classify(label: string): { kind: DetectedKind; dateFormat?: DateFormat; label: string } {
  const f = FORMAT.exec(label);
  let dateFormat: DateFormat | undefined;
  if (f) {
    const want = `${f[1]}${f[2]}${f[3]}${f[2]}YYYY`.toUpperCase();
    dateFormat = DATE_FORMATS.find((d) => d === want);
    label = clean(label.replace(FORMAT, " "));
  }
  if (SIGN.test(label)) return { kind: "signatureField", label };
  if (DATE.test(label) || dateFormat) return { kind: "dateField", dateFormat: dateFormat ?? "YYYY-MM-DD", label };
  return { kind: "textField", label };
}

// Blanks on one page. Coordinates are points in the page as seen (pdf.js
// viewport at scale 1, top-left origin); `existing` are boxes that already
// hold form fields.
export function detectFields(text: PageText, edges: Edges, existing: Rect[] = []): Omit<Suggestion, "id" | "page">[] {
  const W = text.width, H = text.height;
  const runs = text.items.filter((r) => !r.turn && r.text.trim());
  const merged = mergeEdges(edges);
  const groups = ruledCells(edges);
  const found: Found[] = [];

  // The first character of a run that starts at or after x.
  const cut = (r: Run, x: number) => {
    let k = 0;
    while (k < r.text.length && charBox(r, k, k + 1).x < x - 0.5) k++;
    return k;
  };
  const lineAt = (top: number, bottom: number) => {
    const mid = (top + bottom) / 2;
    return text.lines.find((l) => l.y - 1 <= mid && mid <= l.y + l.size * 1.3);
  };
  // The label beside a blank on the line around top–bottom, left or right of
  // x, and how far from it it starts. The nearest run may be some way off
  // ("Name:      ____"); runs after it join only across a word gap, so the
  // label stops at the blank or label before it.
  const beside = (x: number, top: number, bottom: number, dir: -1 | 1) => {
    const all = lineAt(top, bottom)?.runs ?? [];
    const list = dir < 0 ? all.filter((r) => r.x < x - 0.5).sort((a, b) => b.x - a.x) : all.filter((r) => r.x + r.w > x + 0.5).sort((a, b) => a.x - b.x);
    const words: string[] = [];
    let edge = x, gap = Infinity;
    for (const r of list) {
      // Only the characters on this side of x: a run may carry the blank itself.
      const k = cut(r, x);
      const part = dir < 0 ? r.text.slice(0, k) : r.text.slice(k);
      const near = dir < 0 ? (k < r.text.length ? charBox(r, k, k + 1).x : r.x + r.w) : (k > 0 ? charBox(r, k, k + 1).x : r.x);
      const d = Math.abs(edge - near);
      if (d > (words.length ? r.size * 1.2 : Math.max(30, r.size * 4))) break;
      if (!words.length) gap = d;
      const pieces = part.split(/_{3,}|\.{8,}|…{3,}|[☐□▢❏❐❑❒]/);
      const kept = dir < 0 ? pieces.pop()! : pieces[0];
      if (dir < 0) words.unshift(kept);
      else words.push(kept);
      if (kept !== part) break; // reached another blank
      edge = dir < 0 ? r.x : r.x + r.w;
    }
    return { label: clean(words.join(" ")), gap };
  };
  const leftOf = (x: number, top: number, bottom: number) => beside(x, top, bottom, -1).label;
  // A checkbox's label is the text nearest to it, on either side.
  const nearest = (x0: number, x1: number, top: number, bottom: number) => {
    const l = beside(x0, top, bottom, -1), r = beside(x1, top, bottom, 1);
    return (r.label && (!l.label || r.gap <= l.gap) ? r : l).label;
  };
  // Small text just under a line, inside its span: "Signature", "Date". A
  // heading under a rule is bold or large, and is no caption.
  const below = (x0: number, x1: number, y: number) => clean(runs
    .filter((r) => r.y >= y + 0.5 && r.y <= y + 14 && r.x >= x0 - 4 && r.x < x1 - 4 && !r.bold && r.size <= 10)
    .sort((a, b) => a.x - b.x).map((r) => r.text).join(" "));
  // Text ending just above a box and starting near its left edge: "Comments".
  const above = (x0: number, x1: number, y: number) => clean(runs
    .filter((r) => r.y + r.h <= y + 1 && r.y + r.h >= y - 16 && r.x >= x0 - 6 && r.x < x1)
    .sort((a, b) => a.x - b.x).map((r) => r.text).join(" "));
  const textIn = (r: Rect, pad = 1.5) => runs.some((t) => overlap(runBox(t), { x0: r.x0 + pad, y0: r.y0 + pad, x1: r.x1 - pad, y1: r.y1 - pad }) > 0);
  const add = (f: Omit<Found, "kind" | "label" | "dateFormat"> & { label: string; kind?: DetectedKind }) => {
    const c = f.kind === "checkbox" ? { kind: "checkbox" as const, label: f.label } : classify(f.label);
    found.push({ ...f, ...c });
  };

  // ── Underscore runs and dotted leaders: "Name: ________", "Name: ..........".
  for (const r of runs) {
    for (const m of r.text.matchAll(/_{3,}|\.{8,}|…{3,}/g)) {
      const b = charBox(r, m.index!, m.index! + m[0].length);
      if (b.w < 15) continue;
      // Leaders that run to a page number are a contents list.
      if (m[0][0] !== "_") {
        const line = text.lines.find((l) => l.runs.includes(r));
        const after = r.text.slice(m.index! + m[0].length) + " " + (line?.runs.filter((o) => o.x > r.x + r.w - 0.5).map((o) => o.text).join(" ") ?? "");
        if (/^\s*([\d]+|[ivxlc]+)\s*$/i.test(after)) continue;
      }
      const base = r.y + r.size;
      add({ x0: b.x, x1: b.x + b.w, y0: base - r.size * 1.05, y1: base + 2, label: leftOf(b.x, r.y, base) || below(b.x, b.x + b.w, base + 2), rank: 2 });
    }
  }

  // ── Box glyphs: "☐ Yes".
  for (const r of runs) {
    for (const m of r.text.matchAll(BOXES)) {
      const b = charBox(r, m.index!, m.index! + 1);
      const s = Math.min(b.w, r.size) * 0.9;
      const cx = b.x + b.w / 2, cy = r.y + r.size * 0.62;
      add({ kind: "checkbox", x0: cx - s / 2, x1: cx + s / 2, y0: cy - s / 2, y1: cy + s / 2, label: nearest(b.x, b.x + b.w, r.y, r.y + r.size), rank: 0 });
    }
  }

  // ── Ruled cells and boxes.
  const cellEdges = groups.flat();
  for (const group of groups) {
    // A row of small empty boxes, one per character, is one field.
    const first = group[0];
    if (group.length >= 3 && group.every((o) => Math.abs(o.y0 - first.y0) < 1.5 && Math.abs(o.y1 - first.y1) < 1.5 && o.x1 - o.x0 <= 24 && o.y1 - o.y0 <= 24 && !textIn(o))) {
      const b = { x0: Math.min(...group.map((o) => o.x0)), x1: Math.max(...group.map((o) => o.x1)), y0: first.y0, y1: first.y1 };
      const label = leftOf(b.x0, b.y0, b.y1) || above(b.x0, b.x1, b.y0);
      if (label) add({ ...b, label, rank: 1 });
      continue;
    }
    for (const c of group) {
      const w = c.x1 - c.x0, h = c.y1 - c.y0;
      if (textIn(c)) continue;
      // A rule running through it makes it a frame around something, not a blank.
      const through = (e: Rect, horizontal: boolean) => horizontal
        ? e.y0 > c.y0 + 2 && e.y0 < c.y1 - 2 && e.x1 > c.x0 + 2 && e.x0 < c.x1 - 2
        : e.x0 > c.x0 + 2 && e.x0 < c.x1 - 2 && e.y1 > c.y0 + 2 && e.y0 < c.y1 - 2;
      if (merged.h.some((e) => through(e, true)) || merged.v.some((e) => through(e, false))) continue;
      if (group.length === 1 && w >= 6 && w <= 22 && h >= 6 && h <= 22 && w / h > 0.75 && w / h < 1.33) {
        add({ kind: "checkbox", ...c, label: nearest(c.x0, c.x1, c.y0, c.y1), rank: 0 });
        continue;
      }
      if (w < 30 || h < 10 || (w > W * 0.85 && h > H * 0.4)) continue;
      // Named by the cell on its left, the cell above, or text beside or above the box.
      const leftCell = group.find((o) => Math.abs(o.x1 - c.x0) < 2 && o.y0 < c.y1 - 2 && o.y1 > c.y0 + 2 && textIn(o));
      const upCell = group.find((o) => Math.abs(o.y1 - c.y0) < 2 && o.x0 < c.x1 - 2 && o.x1 > c.x0 + 2 && textIn(o));
      const cellText = (o: Rect | undefined) => o ? clean(runs.filter((t) => overlap(runBox(t), o) > area(runBox(t)) * 0.5).sort((a, b) => a.y - b.y || a.x - b.x).map((t) => t.text).join(" ")) : "";
      const label = cellText(leftCell) || cellText(upCell) || leftOf(c.x0, c.y0, Math.min(c.y1, c.y0 + 24)) || above(c.x0, c.x1, c.y0);
      // A lone box with nothing saying what goes in it is decoration.
      if (!label && group.length === 1) continue;
      add({ ...c, x0: c.x0 + 1, y0: c.y0 + 1, x1: c.x1 - 1, y1: c.y1 - 1, label, multiline: h > 36, rank: 1 });
    }
  }

  // ── Answer lines: drawn beside a label, or above a caption.
  for (const e of merged.h) {
    const len = e.x1 - e.x0, y = e.y0;
    if (len < 24) continue;
    // A border of a ruled cell or box.
    if (cellEdges.some((c) => (Math.abs(c.y0 - y) < 2.5 || Math.abs(c.y1 - y) < 2.5) && c.x0 < e.x1 - 2 && c.x1 > e.x0 + 2)) continue;
    // Text standing on it: underlined text, or a line already written on.
    if (runs.some((r) => r.y + r.h >= y - 14 && r.y + r.h <= y + 1 && Math.min(r.x + r.w, e.x1 - 2) - Math.max(r.x, e.x0 + 2) > 2)) continue;
    const sizeNear = runs.find((r) => Math.abs(r.y + r.size - y) < 6 && r.x + r.w <= e.x0 + 3)?.size ?? 11;
    const left = leftOf(e.x0, y - sizeNear, y);
    const caption = left ? "" : below(e.x0, e.x1, y);
    if (!left && (!caption || len > W * 0.6)) continue;
    const h = left ? Math.max(12, Math.min(20, sizeNear * 1.3)) : 16;
    add({ x0: e.x0, x1: e.x1, y0: y - h, y1: y, label: left || caption, rank: 3 });
  }

  // ── One suggestion per blank, none where a field already is.
  const kept: Found[] = [];
  for (const f of [...found].sort((a, b) => a.rank - b.rank)) {
    if (existing.some((r) => iou(r, f) > 0.3 || overlap(r, f) > area(f) * 0.6)) continue;
    if (kept.some((k) => iou(k, f) > 0.3 || overlap(k, f) > Math.min(area(k), area(f)) * 0.6)) continue;
    kept.push(f);
  }
  return kept
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
    .map((f) => ({
      kind: f.kind, label: f.label, multiline: f.multiline, dateFormat: f.dateFormat,
      x: f.x0 / W, y: f.y0 / H, w: (f.x1 - f.x0) / W, h: (f.y1 - f.y0) / H,
    }));
}

export async function detectPage(page: PDFPageProxy, index: number): Promise<Suggestion[]> {
  const [text, edges, annots] = await Promise.all([pageText(page), pageEdges(page), page.getAnnotations()]);
  const vp = page.getViewport({ scale: 1 });
  const existing = (annots as { subtype?: string; rect?: number[] }[]).filter((a) => a.subtype === "Widget" && a.rect).map((a) => {
    const [ax, ay] = vp.convertToViewportPoint(a.rect![0], a.rect![1]);
    const [bx, by] = vp.convertToViewportPoint(a.rect![2], a.rect![3]);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  });
  return detectFields(text, edges, existing).map((s, k) => ({ ...s, page: index, id: `${index}-${k}` }));
}

export async function detectDocument(doc: PDFDocumentProxy, onPage?: (i: number) => void): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  for (let i = 0; i < doc.numPages; i++) {
    onPage?.(i);
    out.push(...(await detectPage(await doc.getPage(i + 1), i)));
  }
  return out;
}

// Accepted suggestions as fields for the editor to add.
export function toItems(list: Suggestion[]): EditorItem[] {
  return list.map((s) => ({
    id: `detected-${s.id}`, page: s.page, kind: s.kind, x: s.x, y: s.y, w: s.w, h: s.h,
    name: s.label || undefined, tooltip: s.label || undefined, multiline: s.multiline, dateFormat: s.dateFormat,
  }));
}
