"use client";

// PDF → Word. "editable" rebuilds the document: columns become Word section
// columns, text keeps its font, size, colour and links, tables become Word
// tables, pictures stay where they were, and lines repeated on every page
// move into the page header and footer with live page numbers. Scans and
// full-page pictures go behind the text, so neither is lost.
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
const emu = (pt: number) => Math.round(pt * 12700); // and positions in EMUs
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
    HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom, TextWrappingType, LineRuleType,
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
      const canvas = await renderPage(page, SCALE, undefined, { rotation });
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

  // Backgrounds: the page drawn without its text (the text stays editable),
  // cut to each rectangle and placed behind the text where it was on the page.
  // Figures lying on a background are drawn into it, text and all, rather than into the flow.
  const BG_SCALE = 1.6;
  // `rotation` is the view the layout was read in, as for pictures.
  const behind = async (pageNo: number, rects: Figure[], withText: boolean, figures: Figure[] = [], rotation?: number) => {
    const runs: InstanceType<Docx["ImageRun"]>[] = [];
    const box = (f: Figure, canvas: HTMLCanvasElement) => {
      const x = Math.round(f.x0 * BG_SCALE);
      const y = Math.round(f.y0 * BG_SCALE);
      return [x, y, Math.max(1, Math.min(canvas.width - x, Math.round((f.x1 - f.x0) * BG_SCALE))), Math.max(1, Math.min(canvas.height - y, Math.round((f.y1 - f.y0) * BG_SCALE)))];
    };
    try {
      const page = await pdf.getPage(pageNo);
      const canvas = await renderPage(page, BG_SCALE, "#ffffff", { rotation, withoutText: !withText });
      if (!withText && figures.length) {
        const full = await renderPage(page, BG_SCALE, "#ffffff", { rotation });
        for (const f of figures) {
          const [x, y, w, h] = box(f, canvas);
          canvas.getContext("2d")!.drawImage(full, x, y, w, h, x, y, w, h);
        }
      }
      page.cleanup();
      for (const f of rects) {
        const [x, y, w, h] = box(f, canvas);
        const crop = document.createElement("canvas");
        crop.width = w;
        crop.height = h;
        const ctx = crop.getContext("2d")!;
        ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
        if (blank(ctx, w, h)) continue;
        runs.push(new ImageRun({
          type: "jpg",
          data: await bytesOf(await canvasToBlob(crop, "image/jpeg", 0.85)),
          transformation: { width: px(f.x1 - f.x0), height: px(f.y1 - f.y0) },
          floating: {
            horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(f.x0) },
            verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(f.y0) },
            behindDocument: true,
            allowOverlap: true,
            wrap: { type: TextWrappingType.NONE },
          },
        }));
      }
    } catch {
      // As with figures: the text still converts.
    }
    // A one-point paragraph anchors them, so the text below doesn't move.
    return runs.length ? [new Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT }, children: runs })] : [];
  };

  // ── Header and footer, with page numbers made live

  const pageCount = layouts.length;
  // With `pageNo`, the number equal to it becomes a PAGE field and one equal
  // to the page count, NUMPAGES; without, the text stays as it is.
  const furniture = (lines: Line[], width: number, pageNo?: number) =>
    lines.map((l) => {
      const centre = Math.abs(l.x + l.w / 2 - width / 2) < width * 0.06;
      const rightAligned = l.x + l.w > width * 0.75 && l.x > width * 0.5;
      const children: (InstanceType<Docx["TextRun"]> | InstanceType<Docx["ExternalHyperlink"]>)[] = [];
      for (const s of spans([l])) {
        const parts = s.text.split(/(\d+)/);
        parts.forEach((part, k) => {
          if (!part) return;
          const style = { bold: s.bold, italics: s.italic, size: Math.round(s.size * 2), font: s.font, color: s.color && s.color !== "#000000" ? s.color.slice(1) : undefined };
          if (pageNo && k % 2 === 1 && Number(part) === pageNo) children.push(new TextRun({ ...style, children: [PageNumber.CURRENT] }));
          else if (pageNo && k % 2 === 1 && Number(part) === pageCount && pageCount > 1) children.push(new TextRun({ ...style, children: [PageNumber.TOTAL_PAGES] }));
          else children.push(new TextRun({ ...style, text: part }));
        });
      }
      return new Paragraph({ alignment: centre ? AlignmentType.CENTER : rightAligned ? AlignmentType.RIGHT : undefined, children });
    });
  // Lines that read the same on every page once the page numbers are fields
  // make one header (or footer) for the document. Others, Bates numbers say,
  // change in ways a field can't follow, so each page gets its own, word for word.
  const running = (pick: (l: PageLayout) => Line[]) => {
    const at = layouts.findIndex((l) => pick(l).length);
    if (at < 0) return null;
    const template = pick(layouts[at]);
    const shown = (n: string, pageNo: number) => (Number(n) === at + 1 ? String(pageNo) : Number(n) === pageCount && pageCount > 1 ? String(pageCount) : n);
    const same = layouts.every((l, i) => {
      const lines = pick(l);
      return !lines.length || (lines.length === template.length && template.every((t, k) => {
        const a = t.text.split(/(\d+)/);
        const b = lines[k].text.split(/(\d+)/);
        return a.length === b.length && a.every((part, j) => (j % 2 ? shown(part, i + 1) : part) === b[j]);
      }));
    });
    return same
      ? { document: furniture(template, layouts[0].width, at + 1) }
      : { pages: layouts.map((l) => furniture(pick(l), l.width)) };
  };
  const header = running((l) => l.header);
  const footer = running((l) => l.footer);
  // The first section carries the document's header and footer, whatever is
  // on its page; later sections inherit them. Headers of their own go on each page's first section.
  const push = (section: import("docx").ISectionOptions, page: number, firstOnPage: boolean) => {
    const own = <T,>(r: ReturnType<typeof running>, make: (children: InstanceType<Docx["Paragraph"]>[]) => T) => {
      if (r?.document) return sections.length ? undefined : { default: make(r.document) };
      if (r?.pages && firstOnPage) return { default: make(r.pages[page].length ? r.pages[page] : [new Paragraph({})]) };
      return undefined;
    };
    sections.push({
      ...section,
      headers: own(header, (children) => new Header({ children })),
      footers: own(footer, (children) => new Footer({ children })),
    });
  };

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

    const whole = [{ x0: 0, y0: 0, x1: p.width, y1: p.height }];
    // A label up the margin may have turned the layout's view of a page that is
    // otherwise a scan. Such a page is kept as the picture it is, the way the
    // page is shown, with its own size and margins rather than the layout's.
    const shown = p.rotation === undefined || (await pdf.getPage(i + 1).then((page) => {
      const same = p.rotation === page.rotate;
      page.cleanup();
      return same;
    }));
    const turnedScan = !shown && textChars < 20;
    if (!textChars || !p.sections.length || turnedScan) {
      // A scan, a picture page, or one with nothing but its running header and
      // footer: the page goes in as a picture, without the text the header and
      // footer carry.
      let properties = props({});
      let rects = whole;
      if (!shown) {
        const page = await pdf.getPage(i + 1);
        const view = page.getViewport({ scale: 1 });
        page.cleanup();
        properties = { page: { size: { width: twip(view.width), height: twip(view.height) }, margin: { left: 1440, right: 1440, top: 1440, bottom: 1440 } } };
        rects = [{ x0: 0, y0: 0, x1: view.width, y1: view.height }];
      }
      push({ properties, children: [...(await behind(i + 1, rects, !textChars || turnedScan, [], shown ? p.rotation : undefined)), new Paragraph({})] }, i, true);
      progress?.(pageCount + i + 1, pageCount * 2);
      continue;
    }

    // A page with a few words and no figures may be a diagram or a form: keep its art too.
    // A scan made searchable is the exception: its words are in the picture
    // already, and the text is what the user is after.
    const backdrop = p.ocrLayer ? [] : p.backgrounds.length ? p.backgrounds : textChars < 20 && !p.figures.length ? whole : [];
    const onBackdrop = (f: Figure) => backdrop.some((b) => f.x0 >= b.x0 - 1 && f.y0 >= b.y0 - 1 && f.x1 <= b.x1 + 1 && f.y1 <= b.y1 + 1);
    const pics = await pictures(i + 1, p.figures.filter((f) => !onBackdrop(f)), p.rotation);
    const held = new Set(p.figures.filter(onBackdrop));
    const under = backdrop.length ? await behind(i + 1, backdrop, false, p.figures.filter(onBackdrop), p.rotation) : [];
    p.sections.forEach((sec, si) => {
      const cols = sec.columns.length;
      const gap = cols > 1 ? Math.max(6, (sec.columns[cols - 1].x0 - sec.columns[0].x1 - sec.columns.slice(1, -1).reduce((s, col) => s + col.x1 - col.x0, 0)) / (cols - 1)) : 0;
      const colWidth = cols > 1 ? (textWidth - gap * (cols - 1)) / cols : textWidth;
      const children: Child[] = si === 0 ? [...under] : [];
      sec.columns.forEach((col, ci) => {
        if (ci > 0) children.push(new Paragraph({ children: [new ColumnBreak()] }));
        children.push(...columnChildren(col, colWidth, pics, held));
      });
      if (!children.length) children.push(new Paragraph({}));
      push({
        properties: props({
          type: si === 0 ? SectionType.NEXT_PAGE : SectionType.CONTINUOUS,
          column: cols > 1 ? { count: cols, space: twip(gap), equalWidth: true } : undefined,
        }),
        children,
      }, i, si === 0);
    });
    progress?.(pageCount + i + 1, pageCount * 2);
  }
  return sections;

  // Nothing drawn but white: no picture needed.
  function blank(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let k = 0; k < data.length; k += 4) if (data[k] < 248 || data[k + 1] < 248 || data[k + 2] < 248) return false;
    return true;
  }

  function columnChildren(col: Column, width: number, pics: Map<Figure, { data: Uint8Array; type: "png" | "jpg" }>, held: Set<Figure>): Child[] {
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
        } else if (held.has(f)) {
          // Drawn into the background: the text after it keeps its distance.
          out.push(new Paragraph({ spacing: { before: 0, after: 0, line: twip(Math.max(1, f.y1 - (bottom ?? f.y0))), lineRule: LineRuleType.EXACT } }));
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
