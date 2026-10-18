"use client";

// Compare's differences, to keep or send on (src/components/workspace/CompareView.tsx):
// - annotatedCopy: the revised file with a highlight over every changed
//   passage (its note says what it replaced), a note where text was removed
//   and on each page the original doesn't have.
// - changeReport: one HTML file listing every changed page, words added and
//   removed marked, that opens anywhere without loading anything.
// Both read the rows textDiff returned (src/lib/pdf/compare.ts).

import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, type PDFPage } from "pdf-lib";
import type { Change } from "diff";
import { baseName, closePdf, openPdf, type Output } from "./common";
import { charBox, lineChars, pageText, type PageText } from "./text";
import type { PageDiff } from "./compare";

/** The page's language: a string by key, as useI18n's t(). */
export type Say = (key: string, vars?: Record<string, string | number>) => string;

// What changed on the revised page, as character ranges of its text (the
// lines joined with "\n", as textDiff compared it). A removal followed by an
// addition is one replacement; changes in spacing alone aren't changes.
type Mark = { kind: "added" | "replaced" | "removed"; from: number; to: number; old: string };

export function marks(changes: Change[]): Mark[] {
  const out: Mark[] = [];
  let at = 0;
  let removed = "";
  const flush = () => {
    if (removed) out.push({ kind: "removed", from: at, to: at, old: removed });
    removed = "";
  };
  for (const c of changes) {
    if (c.removed) {
      if (c.value.trim()) removed = removed ? `${removed} ${c.value.trim()}` : c.value.trim();
      continue;
    }
    if (c.added && c.value.trim()) {
      const lead = c.value.length - c.value.trimStart().length;
      const trail = c.value.length - c.value.trimEnd().length;
      out.push({ kind: removed ? "replaced" : "added", from: at + lead, to: at + c.value.length - trail, old: removed });
      removed = "";
    } else if (!c.added && c.value.trim()) {
      flush();
    }
    at += c.value.length;
  }
  flush();
  return out;
}

type Box = { x: number; y: number; w: number; h: number };

// The boxes around characters [from, to) of a page's text, one per line.
function boxes(pt: PageText, from: number, to: number): Box[] {
  const out: Box[] = [];
  let start = 0;
  for (const line of pt.lines) {
    const end = start + line.text.length;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a < b) {
      const { from: at } = lineChars(line.runs);
      const parts: Box[] = [];
      for (let i = a - start; i < b - start; i++) {
        const f = at[i];
        if (f) parts.push(charBox(line.runs[f[0]], f[1], f[1] + 1));
      }
      if (parts.length) {
        const x0 = Math.min(...parts.map((p) => p.x));
        const y0 = Math.min(...parts.map((p) => p.y));
        out.push({ x: x0, y: y0, w: Math.max(...parts.map((p) => p.x + p.w)) - x0, h: Math.max(...parts.map((p) => p.y + p.h)) - y0 });
      }
    }
    start = end + 1; // the "\n" between lines
  }
  return out;
}

// Where character `at` of a page's text starts (the end of the text when past it).
function pointAt(pt: PageText, at: number): { x: number; y: number } {
  let start = 0;
  let last: { x: number; y: number } | null = null;
  for (const line of pt.lines) {
    const { from } = lineChars(line.runs);
    for (let i = 0; i < from.length; i++) {
      const f = from[i];
      if (!f) continue;
      const box = charBox(line.runs[f[0]], f[1], f[1] + 1);
      if (start + i >= at) return { x: box.x, y: box.y };
      last = { x: box.x + box.w, y: box.y };
    }
    start += line.text.length + 1;
  }
  return last ?? { x: 12, y: 12 };
}

const YELLOW = [1, 0.84, 0.1];

function annotate(doc: PDFDocument, page: PDFPage, fields: Record<string, unknown>) {
  const ctx = doc.context;
  const ref = ctx.register(ctx.obj({ Type: "Annot", F: 4, C: YELLOW, T: PDFHexString.fromText("Compare"), M: PDFString.fromDate(new Date()), P: page.ref, ...fields } as never));
  let list = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!list) {
    list = ctx.obj([]);
    page.node.set(PDFName.of("Annots"), list);
  }
  list.push(ref);
}

// A highlight over `quads` (in PDF space, four corners each: top left, top
// right, bottom left, bottom right), drawn in multiply mode so the text
// shows through. Its appearance is included for viewers that don't draw one.
function highlight(doc: PDFDocument, page: PDFPage, quads: number[][], note: string) {
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const r = (n: number) => +n.toFixed(2);
  const paths = quads.map((q) => `${r(q[0])} ${r(q[1])} m ${r(q[2])} ${r(q[3])} l ${r(q[6])} ${r(q[7])} l ${r(q[4])} ${r(q[5])} l h f`).join("\n");
  const ctx = doc.context;
  const appearance = ctx.register(ctx.stream(`/G gs ${YELLOW.join(" ")} rg\n${paths}`, {
    Type: "XObject", Subtype: "Form", BBox: rect,
    Resources: { ExtGState: { G: { Type: "ExtGState", BM: "Multiply" } } },
  } as never));
  annotate(doc, page, { Subtype: "Highlight", Rect: rect, QuadPoints: quads.flat().map(r), Contents: PDFHexString.fromText(note), AP: { N: appearance } });
}

// A note icon at `point` (PDF space), its top left corner there.
function note(doc: PDFDocument, page: PDFPage, point: number[], text: string) {
  const [x, y] = point;
  annotate(doc, page, { Subtype: "Text", Name: "Comment", Rect: [x, y - 20, x + 20, y], Contents: PDFHexString.fromText(text), F: 4 | 8 | 16 });
}

export async function annotatedCopy(b: File, rows: PageDiff[], t: Say): Promise<Output> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const view = await openPdf(bytes);
  try {
    for (const row of rows) {
      if (row.b === null || row.status === "same" || row.b >= pages.length) continue;
      const pdfPage = await view.getPage(row.b + 1);
      const viewport = pdfPage.getViewport({ scale: 1 });
      // Page coordinates (top left origin, as pageText reads them) to PDF space.
      const pdf = (x: number, y: number) => viewport.convertToPdfPoint(x, y) as number[];
      const page = pages[row.b];
      if (row.status === "added") {
        note(doc, page, pdf(12, 12), t("cmp.notePageAdded"));
        continue;
      }
      const pt = await pageText(pdfPage);
      for (const m of marks(row.changes)) {
        if (m.kind === "removed") {
          const p = pointAt(pt, m.from);
          note(doc, page, pdf(p.x, p.y), t("cmp.noteRemoved", { old: m.old }));
          continue;
        }
        const quads = boxes(pt, m.from, m.to).map((q) => [...pdf(q.x, q.y), ...pdf(q.x + q.w, q.y), ...pdf(q.x, q.y + q.h), ...pdf(q.x + q.w, q.y + q.h)]);
        if (quads.length) highlight(doc, page, quads, m.kind === "replaced" ? t("cmp.noteReplaced", { old: m.old }) : t("cmp.noteAdded"));
      }
      pdfPage.cleanup();
    }
  } finally {
    await closePdf(view);
  }
  const out = await doc.save();
  return { name: `${baseName(b.name)}-changes.pdf`, blob: new Blob([out as BlobPart], { type: "application/pdf" }) };
}

// The heading CompareView gives a row.
export function rowTitle(d: PageDiff, t: Say) {
  return d.a === null ? t("cmp.pageAdded", { n: d.b! + 1 })
    : d.b === null ? t("cmp.pageRemoved", { n: d.a + 1 })
    : d.a === d.b ? t("ws.page", { n: d.a + 1 })
    : t("cmp.pageMoved", { a: d.a + 1, b: d.b + 1 });
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function changeReport(a: File, b: File, rows: PageDiff[], t: Say, when = new Date()): Output {
  const changed = rows.filter((d) => d.status !== "same");
  const date = when.toISOString().slice(0, 10);
  const sections = changed.map((d) => {
    const body = d.changes.map((c) => {
      // Long unchanged stretches are shortened, as on screen.
      const text = !c.added && !c.removed && c.value.length > 400 ? `${c.value.slice(0, 180)} … ${c.value.slice(-180)}` : c.value;
      return c.added ? `<ins>${escape(text)}</ins>` : c.removed ? `<del>${escape(text)}</del>` : escape(text);
    }).join("");
    return `<section data-change><h2>${escape(rowTitle(d, t))} <span class="n"><span class="add">+${d.added}</span> <span class="del">−${d.removed}</span></span></h2><p>${body}</p></section>`;
  });
  const title = t("cmp.reportTitle", { a: a.name, b: b.name });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font:15px/1.6 system-ui,sans-serif;color:#1f1f1c;background:#fff;max-width:860px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px}.meta{color:#6b6b66;margin:0 0 24px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0 0 24px}dt{color:#6b6b66}dd{margin:0;overflow-wrap:anywhere}
section{border:1px solid #e4e4df;border-radius:10px;padding:16px 18px;margin:0 0 14px}
p{white-space:pre-wrap;margin:0}ins{background:#dbeafe;color:#1e40af;text-decoration:none}del{background:#fee2e2;color:#991b1b}
.n{font-weight:400;margin-inline-start:8px}.add{color:#2563eb}.del{color:#dc2626}
</style></head><body>
<h1>${escape(title)}</h1>
<p class="meta">${escape(t("cmp.reportMeta", { date, n: changed.length }))}</p>
<dl><dt>${escape(t("cmp.original"))}</dt><dd>${escape(a.name)}</dd><dt>${escape(t("cmp.revised"))}</dt><dd>${escape(b.name)}</dd></dl>
${sections.join("\n") || `<p>${escape(t("cmp.noChanges"))}</p>`}
</body></html>
`;
  return { name: `${baseName(b.name)}-changes.html`, blob: new Blob([html], { type: "text/html" }) };
}
