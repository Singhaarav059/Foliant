"use client";

// PDF → Word. "editable" rebuilds the document: columns become Word section
// columns, text keeps its font, size, colour and links, tables become Word
// tables, pictures stay where they were, and lines repeated on every page
// move into the page header and footer with live page numbers.
// "exact" puts each page in as a picture.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, renderPage, type Output, type Progress } from "./common";
import { blocks, bodySizeOf, dropChars, spans, type Block, type Line, type Span } from "./text";
import { allLines, type Table } from "./tables";
import { documentLayout, type Column, type Figure, type PageLayout } from "./layout";

type Docx = typeof import("docx");
type Child = InstanceType<Docx["Paragraph"]> | InstanceType<Docx["Table"]>;

const twip = (pt: number) => Math.round(pt * 20);
const px = (pt: number) => (pt * 4) / 3; // docx image sizes are in pixels at 96 dpi
const LIST = /^([•◦▪●○■\-–*]|\d{1,3}[.)]|[a-z][.)])\s+(.*)$/i;

export async function pdfToWord(file: File, o: { wordMode: string }, progress?: Progress): Promise<Output[]> {
  const docx = await import("docx");
  const pdf = await openPdf(await file.arrayBuffer());
  const sections = o.wordMode === "exact" ? await exact(docx, pdf, progress) : await editable(docx, pdf, progress);
  await closePdf(pdf);
  const { Document, Packer, LevelFormat, AlignmentType } = docx;
  const blob = await Packer.toBlob(new Document({
    creator: "Foliant",
    numbering: {
      config: [{
        reference: "ordered",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      }],
    },
    sections,
  }));
  return [{ name: `${baseName(file.name)}.docx`, blob }];
}

async function exact(docx: Docx, pdf: PDFDocumentProxy, progress?: Progress) {
  const { Paragraph, ImageRun } = docx;
  const sections: import("docx").ISectionOptions[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const v = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, 2);
    const data = await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.88));
    sections.push({
      properties: { page: { size: { width: twip(v.width), height: twip(v.height) }, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
      children: [new Paragraph({ children: [new ImageRun({ type: "jpg", data, transformation: { width: px(v.width), height: px(v.height) } })] })],
    });
    page.cleanup();
    progress?.(i, pdf.numPages);
  }
  return sections;
}

async function editable(docx: Docx, pdf: PDFDocumentProxy, progress?: Progress) {
  const {
    Paragraph, TextRun, ExternalHyperlink, HeadingLevel, ImageRun, AlignmentType, ColumnBreak, SectionType,
    Header, Footer, PageNumber, Table: DocTable, TableRow, TableCell, WidthType, BorderStyle, TableLayoutType, VerticalAlign,
  } = docx;
  const layouts = await documentLayout(pdf, (i) => progress?.(i, pdf.numPages * 2));
  const body = bodySizeOf(layouts.map((l) => ({ lines: allLines(l) })));
  const sections: import("docx").ISectionOptions[] = [];

  // ── Text

  let listInstance = 0; // numbered lists restart at 1 after other text
  const runsOf = (list: Span[], force?: { bold?: boolean; color?: string }) =>
    list.map((s) => {
      if (s.br) return new TextRun({ break: 1 });
      const color = force?.color ?? (s.color && s.color !== "#000000" ? s.color.slice(1) : s.link ? "0563C1" : undefined);
      const run = new TextRun({
        text: s.text, bold: force?.bold ?? s.bold, italics: s.italic, size: Math.round(s.size * 2), font: s.font, color,
        underline: s.link ? {} : undefined,
      });
      return s.link ? new ExternalHyperlink({ link: s.link, children: [run] }) : run;
    });

  const paragraph = (b: Block, col: { x0: number; x1: number }, before: number, pageBreakBefore: boolean) => {
    const width = col.x1 - col.x0;
    const lefts = b.lines.map((l) => l.x);
    const rights = b.lines.map((l) => l.x + l.w);
    const maxRight = Math.max(...rights);
    const centered = b.lines.every((l) => Math.abs(l.x + l.w / 2 - (col.x0 + col.x1) / 2) < width * 0.04) && b.lines.every((l) => l.w < width * 0.9);
    const right = !centered && b.lines.every((l) => col.x1 - (l.x + l.w) < 3) && Math.min(...lefts) - col.x0 > 12;
    const justified = b.lines.length >= 3 && rights.slice(0, -1).every((r) => maxRight - r < 1.5) && maxRight - rights[rights.length - 1] > 6;
    // Short lines that end well before the column edge (addresses, verse) keep their breaks.
    const breaks = !centered && b.kind === "paragraph" && b.lines.length > 1 && rights.every((r) => r < col.x0 + width * 0.7);
    const rest = b.lines.length > 1 ? Math.min(...lefts.slice(1)) : lefts[0];
    const left = centered || right ? 0 : Math.max(0, rest - col.x0);
    const first = centered || right ? 0 : lefts[0] - rest;
    const lead = b.lines.length > 1 ? (b.lines[b.lines.length - 1].y - b.lines[0].y) / (b.lines.length - 1) / b.size : 1.2;
    let list = spans(b.lines, breaks);
    let bullet: { level: number } | undefined;
    let numbering: { reference: string; level: number; instance: number } | undefined;
    if (b.kind === "list") {
      const m = b.text.match(LIST);
      if (m) {
        list = dropChars(list, b.text.length - m[2].length);
        if (/\d/.test(m[1])) numbering = { reference: "ordered", level: 0, instance: listInstance };
        else bullet = { level: 0 };
      }
    }
    return new Paragraph({
      pageBreakBefore,
      heading: b.kind === "heading" ? (b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3) : undefined,
      alignment: centered ? AlignmentType.CENTER : right ? AlignmentType.RIGHT : justified ? AlignmentType.JUSTIFIED : undefined,
      bullet,
      numbering,
      indent: bullet || numbering ? undefined : {
        left: left > 3 ? twip(left) : undefined,
        firstLine: first > 3 ? twip(first) : undefined,
        hanging: first < -3 ? twip(-first) : undefined,
      },
      spacing: { before: twip(Math.min(36, Math.max(0, before))), after: 0, line: Math.round(Math.min(2.5, Math.max(1, lead / 1.17)) * 240) },
      // Headings keep the PDF's look rather than Word's heading style.
      children: runsOf(list, b.kind === "heading" ? { color: list[0]?.color?.slice(1) ?? "000000" } : undefined),
    });
  };

  // ── Tables

  const line = { style: BorderStyle.SINGLE, size: 4, color: "000000" };
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const tableOf = (t: Table, maxW: number) => {
    const scale = Math.min(1, maxW / t.w);
    const widths = t.colWidths.map((w) => twip(w * scale));
    const rows = Array.from({ length: t.rows }, (_, r) => new TableRow({
      tableHeader: r === 0,
      children: t.cells.filter((c) => c.row === r).map((c) => new TableCell({
        columnSpan: c.colSpan > 1 ? c.colSpan : undefined,
        rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
        width: { size: widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0), type: WidthType.DXA },
        verticalAlign: VerticalAlign.CENTER,
        borders: t.ruled ? undefined : { top: r === 0 ? line : none, bottom: r === 0 || c.row + c.rowSpan === t.rows ? line : none, left: none, right: none },
        children: [new Paragraph({ children: runsOf(spans(c.lines)) })],
      })),
    }));
    return new DocTable({
      rows,
      columnWidths: widths,
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      layout: TableLayoutType.FIXED,
      borders: t.ruled
        ? { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line }
        : { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    });
  };

  // ── Pictures: cropped from the rendered page, so vector art on top comes along.

  const SCALE = 2;
  const pictures = async (pageNo: number, figures: Figure[], rotation?: number) => {
    const out = new Map<Figure, { data: Uint8Array; type: "png" | "jpg" }>();
    if (!figures.length) return out;
    try {
      const page = await pdf.getPage(pageNo);
      // Drawn in the view the layout was read in, so the boxes match.
      const canvas = await renderPage(page, SCALE, undefined, rotation);
      page.cleanup();
      for (const f of figures) {
        const w = Math.max(1, Math.round((f.x1 - f.x0) * SCALE));
        const h = Math.max(1, Math.round((f.y1 - f.y0) * SCALE));
        const crop = document.createElement("canvas");
        crop.width = w;
        crop.height = h;
        crop.getContext("2d")!.drawImage(canvas, f.x0 * SCALE, f.y0 * SCALE, w, h, 0, 0, w, h);
        // Small pictures (logos, charts) stay sharp as PNG; photos go to JPEG.
        const png = w * h < 600_000;
        out.set(f, { data: await bytesOf(await canvasToBlob(crop, png ? "image/png" : "image/jpeg", 0.9)), type: png ? "png" : "jpg" });
      }
    } catch {
      // Without a canvas (or on a render error) the text still converts.
    }
    return out;
  };

  // ── Header and footer, with page numbers made live

  const pageCount = layouts.length;
  const furniture = (pick: (l: PageLayout) => Line[], width: number) => {
    const at = layouts.findIndex((l) => pick(l).length);
    if (at < 0) return undefined;
    const lines = pick(layouts[at]);
    return lines.map((l) => {
      const centre = Math.abs(l.x + l.w / 2 - width / 2) < width * 0.06;
      const rightAligned = l.x + l.w > width * 0.75 && l.x > width * 0.5;
      const children: (InstanceType<Docx["TextRun"]> | InstanceType<Docx["ExternalHyperlink"]>)[] = [];
      for (const s of spans([l])) {
        // The number that changes with the page becomes a PAGE field; one equal to the page count, NUMPAGES.
        const parts = s.text.split(/(\d+)/);
        parts.forEach((part, k) => {
          if (!part) return;
          const style = { bold: s.bold, italics: s.italic, size: Math.round(s.size * 2), font: s.font, color: s.color && s.color !== "#000000" ? s.color.slice(1) : undefined };
          if (k % 2 === 1 && Number(part) === at + 1) children.push(new TextRun({ ...style, children: [PageNumber.CURRENT] }));
          else if (k % 2 === 1 && Number(part) === pageCount && pageCount > 1) children.push(new TextRun({ ...style, children: [PageNumber.TOTAL_PAGES] }));
          else children.push(new TextRun({ ...style, text: part }));
        });
      }
      return new Paragraph({ alignment: centre ? AlignmentType.CENTER : rightAligned ? AlignmentType.RIGHT : undefined, children });
    });
  };
  const first = layouts[0];
  const headerLines = first ? furniture((l) => l.header, first.width) : undefined;
  const footerLines = first ? furniture((l) => l.footer, first.width) : undefined;

  // ── Pages

  for (let i = 0; i < layouts.length; i++) {
    const p = layouts[i];
    const size = { width: twip(p.width), height: twip(p.height) };
    const textChars = allLines(p).reduce((s, l) => s + l.text.length, 0);
    // Margins follow the page's own text block.
    const c = p.content;
    const m = (v: number) => Math.min(108, Math.max(18, v));
    const margin = c
      ? { left: twip(m(c.x0)), right: twip(m(p.width - c.x1)), top: twip(m(c.y0)), bottom: twip(m(p.height - c.y1)), header: twip(18), footer: twip(18) }
      : { left: 1440, right: 1440, top: 1440, bottom: 1440 };
    const textWidth = p.width - (c ? m(c.x0) + m(p.width - c.x1) : 144);
    const props = (extra: object) => ({ page: { size, margin }, ...extra });

    if (textChars < 20) {
      // Probably a scan or a picture page: keep it as an image, the way the
      // page is shown. A label up the margin may have turned the layout's view;
      // its size and margins are then the page's own, not the layout's.
      const page = await pdf.getPage(i + 1);
      const shown = (p.rotation ?? page.rotate) === page.rotate;
      const view = page.getViewport({ scale: 1 });
      const canvas = await renderPage(page, 1.6);
      const data = await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.85));
      page.cleanup();
      const w = shown ? Math.min(textWidth, p.width - 36) : view.width - 144;
      const own = { page: { size: { width: twip(view.width), height: twip(view.height) }, margin: { left: 1440, right: 1440, top: 1440, bottom: 1440 } } };
      sections.push({
        properties: shown ? props({}) : own,
        children: [new Paragraph({ children: [new ImageRun({ type: "jpg", data, transformation: { width: px(w), height: px((w * view.height) / view.width) } })] })],
      });
      progress?.(pageCount + i + 1, pageCount * 2);
      continue;
    }

    const pics = await pictures(i + 1, p.figures, p.rotation);
    p.sections.forEach((sec, si) => {
      const cols = sec.columns.length;
      const gap = cols > 1 ? Math.max(6, (sec.columns[cols - 1].x0 - sec.columns[0].x1 - sec.columns.slice(1, -1).reduce((s, col) => s + col.x1 - col.x0, 0)) / (cols - 1)) : 0;
      const colWidth = cols > 1 ? (textWidth - gap * (cols - 1)) / cols : textWidth;
      const children: Child[] = [];
      sec.columns.forEach((col, ci) => {
        if (ci > 0) children.push(new Paragraph({ children: [new ColumnBreak()] }));
        children.push(...columnChildren(col, colWidth, pics));
      });
      if (!children.length) children.push(new Paragraph({}));
      sections.push({
        properties: props({
          type: si === 0 ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS,
          column: cols > 1 ? { count: cols, space: twip(gap), equalWidth: true } : undefined,
        }),
        // Later sections inherit the first one's header and footer.
        headers: sections.length === 0 && headerLines ? { default: new Header({ children: headerLines }) } : undefined,
        footers: sections.length === 0 && footerLines ? { default: new Footer({ children: footerLines }) } : undefined,
        children,
      });
    });
    if (!p.sections.length) sections.push({ properties: props({}), children: [new Paragraph({})] });
    progress?.(pageCount + i + 1, pageCount * 2);
  }
  return sections;

  function columnChildren(col: Column, width: number, pics: Map<Figure, { data: Uint8Array; type: "png" | "jpg" }>): Child[] {
    const out: Child[] = [];
    let bottom: number | null = null;
    for (const item of col.items) {
      if (item.kind === "table") {
        out.push(tableOf(item.table, width), new Paragraph({ spacing: { after: 0 } }));
        bottom = item.table.y + item.table.h;
      } else if (item.kind === "figure") {
        const f = item.figure;
        const pic = pics.get(f);
        if (pic) {
          const w = Math.min(width, f.x1 - f.x0);
          const h = (w * (f.y1 - f.y0)) / (f.x1 - f.x0);
          const centred = Math.abs((f.x0 + f.x1) / 2 - (col.x0 + col.x1) / 2) < 12;
          out.push(new Paragraph({
            alignment: centred ? AlignmentType.CENTER : undefined,
            spacing: { before: twip(Math.min(24, Math.max(0, bottom === null ? 0 : f.y0 - bottom))) },
            children: [new ImageRun({ type: pic.type, data: pic.data, transformation: { width: px(w), height: px(h) } })],
          }));
        }
        bottom = f.y1;
      } else {
        let prevList = false;
        for (const b of blocks(item.lines, body)) {
          const top = b.lines[0].y;
          // Space above is the gap in the PDF less the normal gap between lines.
          const before = bottom === null ? 0 : top - bottom - b.size * 0.25;
          if (b.kind === "list" && !prevList) listInstance++;
          prevList = b.kind === "list";
          out.push(paragraph(b, col, before, false));
          const last = b.lines[b.lines.length - 1];
          bottom = last.y + last.size;
        }
      }
    }
    return out;
  }
}

// Loads the Word writer ahead of use (src/lib/offline.ts).
export const prepareDocx = () => import("docx");
