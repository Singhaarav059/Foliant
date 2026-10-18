"use client";

import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFHexString, PDFString, decodePDFRawStream } from "pdf-lib";
import type { PDFPageProxy } from "pdfjs-dist";
import {
  baseName, bytesOf, canvasToBlob, normaliseImage, closePdf, openPdf, pdfBlob, pdfjs, renderPage, loadImage,
  type Output, type Progress,
} from "./common";
import { pageText, blocks, bodySizeOf, spans, dropChars, lineChars, type Line, type Run, type Span } from "./text";
import { allLines, flow, grid, type Layout, type Table } from "./tables";
import { documentLayout, figuresOf, type Figure, type PageLayout } from "./layout";
import { addInvisibleText } from "./textlayer";
import { srgbProfile } from "./icc";
import { loadPdf } from "./organize";
import { PdfError } from "./errors";
import { prepareDocx } from "./word";

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const MARGINS = { none: 0, small: 20, large: 50 } as const;

// ── Images → PDF
export async function imagesToPdf(
  files: Blob[],
  names: string[],
  o: { orientation: string; pageSize: string; margin: string; separate: boolean },
  progress?: Progress,
): Promise<Output[]> {
  const make = async (subset: number[]) => {
    const doc = await PDFDocument.create();
    for (const i of subset) {
      const img = await normaliseImage(files[i]);
      const embedded = img.kind === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
      const margin = MARGINS[o.margin as keyof typeof MARGINS] ?? 0;
      let pw: number, ph: number;
      if (o.pageSize === "fit") {
        // Images at 96 DPI, as browsers show them.
        pw = img.width * 0.75 + margin * 2;
        ph = img.height * 0.75 + margin * 2;
      } else {
        const [w, h] = SIZES[o.pageSize as keyof typeof SIZES] ?? SIZES.a4;
        const landscape = o.orientation === "landscape" || (o.orientation === "auto" && img.width > img.height);
        [pw, ph] = landscape ? [h, w] : [w, h];
      }
      const page = doc.addPage([pw, ph]);
      const scale = Math.min((pw - margin * 2) / img.width, (ph - margin * 2) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(embedded, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      progress?.(i + 1, files.length);
    }
    return pdfBlob(await doc.save({ useObjectStreams: true }));
  };
  const all = files.map((_, i) => i);
  if (o.separate) {
    const out: Output[] = [];
    for (const i of all) out.push({ name: `${baseName(names[i])}.pdf`, blob: await make([i]) });
    return out;
  }
  return [{ name: `${baseName(names[0])}${files.length > 1 ? "-and-more" : ""}.pdf`, blob: await make(all) }];
}

// ── Scan filters (document / greyscale / colour)
export async function scanFilter(image: Blob, filter: string): Promise<Blob> {
  if (filter === "color") return image;
  const bmp = await loadImage(image);
  const maxSide = 2400;
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * s);
  canvas.height = Math.round(bmp.height * s);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const grey = new Float32Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < px.length; i += 4, j++) grey[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  if (filter === "document") {
    // Flatten uneven lighting: divide by a blurred background estimate, then stretch.
    const bg = boxBlur(grey, canvas.width, canvas.height, Math.max(8, Math.round(canvas.width / 40)));
    for (let j = 0; j < grey.length; j++) {
      const v = Math.min(255, (grey[j] / Math.max(1, bg[j])) * 245);
      grey[j] = v > 200 ? 255 : v < 90 ? Math.max(0, v - 40) : v * 1.25 - 50;
    }
  }
  for (let i = 0, j = 0; i < px.length; i += 4, j++) {
    const v = Math.max(0, Math.min(255, grey[j]));
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvasToBlob(canvas, "image/jpeg", 0.85);
}

function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / (2 * r + 1);
      acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * r + 1);
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// ── PDF → images
export async function pdfToImages(file: File, o: { dpi: string; format: string }, progress?: Progress): Promise<Output[]> {
  const doc = await openPdf(await file.arrayBuffer());
  const scale = Number(o.dpi) / 72;
  const png = o.format === "png";
  const out: Output[] = [];
  const pad = String(doc.numPages).length;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const canvas = await renderPage(page, scale);
    out.push({
      name: `${baseName(file.name)}-${String(i).padStart(pad, "0")}.${png ? "png" : "jpg"}`,
      blob: await canvasToBlob(canvas, png ? "image/png" : "image/jpeg", 0.92),
    });
    page.cleanup();
    canvas.width = canvas.height = 0;
    progress?.(i, doc.numPages);
  }
  await closePdf(doc);
  return out;
}

// Pulls embedded images out as they are stored: JPEGs byte for byte, others re-encoded as PNG.
export async function extractImages(file: File): Promise<Output[]> {
  const doc = await PDFDocument.load(await bytesOf(file), { updateMetadata: false });
  const out: Output[] = [];
  let n = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    if (d.get(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;
    const filter = d.get(PDFName.of("Filter"));
    const filterName = filter instanceof PDFName ? filter.asString() : filter?.toString() ?? "";
    const w = (d.get(PDFName.of("Width")) as PDFNumber)?.asNumber();
    const h = (d.get(PDFName.of("Height")) as PDFNumber)?.asNumber();
    if (!w || !h || w * h < 64 * 64) continue; // skip icons and spacer pixels
    if (filterName.includes("DCTDecode") && !filterName.includes("Flate")) {
      n++;
      out.push({ name: `${baseName(file.name)}-image-${n}.jpg`, blob: new Blob([obj.contents as BlobPart], { type: "image/jpeg" }) });
      continue;
    }
    const bpc = (d.get(PDFName.of("BitsPerComponent")) as PDFNumber)?.asNumber();
    const cs = d.get(PDFName.of("ColorSpace"));
    const csName = cs instanceof PDFName ? cs.asString() : "";
    const channels = csName === "/DeviceRGB" ? 3 : csName === "/DeviceGray" ? 1 : 0;
    const parms = d.get(PDFName.of("DecodeParms"));
    if (bpc !== 8 || !channels || parms || !/Flate/.test(filterName)) continue;
    let raw: Uint8Array;
    try {
      raw = decodePDFRawStream(obj).decode();
    } catch {
      continue;
    }
    if (raw.length < w * h * channels) continue;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (let p = 0, q = 0; p < w * h; p++, q += channels) {
      img.data[p * 4] = raw[q];
      img.data[p * 4 + 1] = raw[q + (channels === 3 ? 1 : 0)];
      img.data[p * 4 + 2] = raw[q + (channels === 3 ? 2 : 0)];
      img.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    n++;
    out.push({ name: `${baseName(file.name)}-image-${n}.png`, blob: await canvasToBlob(canvas, "image/png") });
  }
  if (!out.length) throw new PdfError("no_images", file.name);
  return out;
}

// ── Table-ish layout: split lines into cells by wide gaps, then align columns.
type Cell = { x: number; text: string; bold: boolean };

function lineCells(line: Line): Cell[] {
  const cells: Cell[] = [];
  let cur: Cell | null = null;
  let lastEnd = -Infinity;
  for (const r of line.runs) {
    const gap = r.x - lastEnd;
    if (!cur || gap > Math.max(r.size * 1.2, 9)) {
      cur = { x: r.x, text: r.text, bold: r.bold };
      cells.push(cur);
    } else cur.text += (gap > r.size * 0.18 && !cur.text.endsWith(" ") ? " " : "") + r.text;
    lastEnd = r.x + r.w;
  }
  return cells.map((c) => ({ ...c, text: c.text.replace(/\s+/g, " ").trim() })).filter((c) => c.text);
}

function columnAnchors(rows: Cell[][], tolerance: number) {
  const xs = rows.flat().map((c) => c.x).sort((a, b) => a - b);
  const anchors: number[] = [];
  for (const x of xs) {
    const last = anchors[anchors.length - 1];
    if (last === undefined || x - last > tolerance) anchors.push(x);
  }
  return anchors;
}

function toGrid(lines: Line[]): (Cell | null)[][] {
  const rows = lines.map(lineCells);
  const size = lines.length ? lines.reduce((s, l) => s + l.size, 0) / lines.length : 10;
  const anchors = columnAnchors(rows, size * 2);
  return rows.map((cells) => {
    const row: (Cell | null)[] = new Array(anchors.length).fill(null);
    for (const c of cells) {
      let best = 0;
      for (let k = 1; k < anchors.length; k++) if (Math.abs(anchors[k] - c.x) < Math.abs(anchors[best] - c.x)) best = k;
      while (row[best] && best < anchors.length - 1) best++;
      row[best] = row[best] ? { ...row[best]!, text: `${row[best]!.text} ${c.text}` } : c;
    }
    return row;
  });
}

function asNumber(text: string): number | null {
  const t = text.replace(/[\s ]/g, "");
  if (!/^[-+(]?[$€£¥₹]?\d[\d,.]*%?\)?$/.test(t)) return null;
  const neg = t.startsWith("-") || t.startsWith("(");
  let core = t.replace(/[^\d.,]/g, "");
  if (/,\d{1,2}$/.test(core) && core.includes(".")) core = core.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+,\d+$/.test(core)) core = core.replace(/\./g, "").replace(",", ".");
  else core = core.replace(/,/g, "");
  const n = Number(core);
  if (!Number.isFinite(n)) return null;
  const v = t.endsWith("%") || t.endsWith("%)") ? n / 100 : n;
  return neg ? -v : v;
}

// ── PDF → Excel
export async function pdfToExcel(file: File, o: { sheetPer: string }, progress?: Progress): Promise<Output[]> {
  const ExcelJS = (await import("exceljs")).default;
  const doc = await openPdf(await file.arrayBuffer());
  const layouts = await documentLayout(doc, (i) => progress?.(i, doc.numPages));
  await closePdf(doc);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Nopload";
  const thin = { style: "thin" as const };
  const write = (ws: import("exceljs").Worksheet, layout: Layout) => {
    const widths: number[] = [];
    const fit = (k: number, chars: number) => (widths[k] = Math.max(widths[k] ?? 8, Math.min(60, chars + 2)));
    const put = (cell: import("exceljs").Cell, text: string, bold: boolean) => {
      const v = asNumber(text);
      cell.value = v ?? text;
      if (bold) cell.font = { bold: true };
      if (v !== null && /%\)?$/.test(text)) cell.numFmt = "0.##%";
    };
    for (const part of flow(layout)) {
      if (part.kind === "lines") {
        for (const row of toGrid(part.lines)) {
          const added = ws.addRow([]);
          row.forEach((c, k) => {
            if (!c) return;
            put(added.getCell(k + 1), c.text, c.bold);
            fit(k, c.text.length);
          });
        }
        continue;
      }
      // Detected tables keep their cells, merges and borders.
      const t = part.table;
      const top = ws.rowCount + 1;
      for (let r = 0; r < t.rows; r++) ws.addRow([]);
      for (const c of t.cells) {
        const cell = ws.getCell(top + c.row, c.col + 1);
        if (c.text) put(cell, c.text, c.bold);
        if (t.ruled) cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        else if (c.row === 0) cell.border = { top: thin, bottom: thin };
        else if (c.row + c.rowSpan === t.rows) cell.border = { bottom: thin };
        if (c.lines.length > 1) cell.alignment = { wrapText: true, vertical: "top" };
        if (c.rowSpan > 1 || c.colSpan > 1) ws.mergeCells(top + c.row, c.col + 1, top + c.row + c.rowSpan - 1, c.col + c.colSpan);
        if (c.colSpan === 1) fit(c.col, Math.max(...c.lines.map((l) => l.text.length), 0));
      }
      ws.addRow([]);
    }
    widths.forEach((w, k) => (ws.getColumn(k + 1).width = w));
  };
  if (o.sheetPer === "document") {
    const ws = wb.addWorksheet(baseName(file.name).slice(0, 31) || "Sheet1");
    layouts.forEach((l, i) => {
      write(ws, l);
      if (i < layouts.length - 1) ws.addRow([]);
    });
  } else {
    layouts.forEach((l, i) => write(wb.addWorksheet(`Page ${i + 1}`), l));
  }
  const buf = await wb.xlsx.writeBuffer();
  return [{
    name: `${baseName(file.name)}.xlsx`,
    blob: new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  }];
}

// ── PDF → Markdown
function mdEscape(s: string) {
  return s.replace(/([\\`*_[\]#|])/g, "\\$1");
}

function tableMd(lines: Line[]) {
  const grid = toGrid(lines);
  const width = Math.max(...grid.map((r) => r.length));
  const rows = grid.map((r) => Array.from({ length: width }, (_, k) => mdEscape(r[k]?.text ?? "")));
  const head = `| ${rows[0].join(" | ")} |`;
  const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
  return [head, sep, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

function detectedTableMd(t: Table) {
  const cell = (c: { text: string } | null) => mdEscape(c?.text ?? "").replace(/\n/g, " ");
  const rows = grid(t).map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [rows[0], `| ${new Array(t.cols).fill("---").join(" | ")} |`, ...rows.slice(1)].join("\n");
}

// Bold, italics and links; spaces stay outside the markers so they parse.
function inlineMd(list: Span[], plainBold = false) {
  return list.map((sp) => {
    if (sp.br) return "  \n";
    const [, lead, core, trail] = sp.text.match(/^(\s*)(.*?)(\s*)$/)!;
    if (!core) return sp.text;
    let t = mdEscape(core);
    if (sp.italic) t = `*${t}*`;
    if (sp.bold && !plainBold) t = `**${t}**`;
    if (sp.link) t = `[${t}](${sp.link.replace(/[()\s]/g, encodeURIComponent)})`;
    return lead + t + trail;
  }).join("");
}

function linesMd(lines: Line[], body: number, chunks: string[]) {
  // Runs of 3+ lines with 3+ aligned cells become tables.
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && lineCells(lines[j]).length >= 3) j++;
    if (j - i >= 3) {
      chunks.push(tableMd(lines.slice(i, j)));
      i = j;
      continue;
    }
    let k = i;
    while (k < lines.length && !(lineCells(lines[k]).length >= 3 && k + 2 < lines.length && lineCells(lines[k + 1]).length >= 3 && lineCells(lines[k + 2]).length >= 3)) k++;
    if (k === i) k = i + 1;
    for (const b of blocks(lines.slice(i, k), body)) {
      const list = spans(b.lines);
      if (b.kind === "heading") chunks.push(`${"#".repeat(b.level ?? 2)} ${inlineMd(list, true)}`);
      else if (b.kind === "list") {
        const m = b.text.match(/^([•◦▪●○■\-–*]|\d{1,3}[.)]|[a-z][.)])\s+(.*)$/i);
        const ordered = m && /\d/.test(m[1]);
        const text = inlineMd(m ? dropChars(list, b.text.length - m[2].length) : list);
        chunks.push(`${ordered ? `${m![1].replace(")", ".")}` : "-"} ${text}`);
      } else chunks.push(inlineMd(list));
    }
    i = k;
  }
}

// Headers and footers are left out; columns are read one after the other.
export function pagesToMarkdown(layouts: PageLayout[], pageBreaks: boolean) {
  const body = bodySizeOf(layouts.map((l) => ({ lines: allLines(l) })));
  const parts: string[] = [];
  layouts.forEach((layout, pi) => {
    const chunks: string[] = [];
    for (const item of layout.sections.flatMap((s) => s.columns.flatMap((c) => c.items))) {
      if (item.kind === "table") chunks.push(detectedTableMd(item.table));
      else if (item.kind === "lines") linesMd(item.lines, body, chunks);
    }
    // Consecutive list items sit together; everything else is separated by a blank line.
    let md = chunks.join("\n\n");
    for (let prev = ""; prev !== md; ) {
      prev = md;
      md = md.replace(/(^|\n)((?:- |\d+\. )[^\n]*)\n\n(?=(?:- |\d+\. ))/g, "$1$2\n");
    }
    parts.push(md);
    if (pageBreaks && pi < layouts.length - 1) parts.push(`\n---\n<!-- page ${pi + 2} -->`);
  });
  return parts.join("\n\n").trim() + "\n";
}

export async function pdfToMarkdown(file: File, o: { pageBreaks: boolean }, progress?: Progress): Promise<Output[]> {
  const doc = await openPdf(await file.arrayBuffer());
  const layouts = await documentLayout(doc, (i) => progress?.(i, doc.numPages));
  await closePdf(doc);
  const md = pagesToMarkdown(layouts, o.pageBreaks);
  if (!md.trim()) throw new PdfError("no_text", file.name);
  return [{ name: `${baseName(file.name)}.md`, blob: new Blob([md], { type: "text/markdown" }) }];
}

// ── PDF → Word (in ./word.ts)
export { pdfToWord } from "./word";

// ── PDF → PowerPoint
// With editable text, each slide is built in layers: the page's vector art
// (drawn without its text or pictures) as the background, each picture as
// its own image, and the text as text boxes in its own colours on top.
export async function pdfToPpt(file: File, o: { pptText: boolean }, progress?: Progress): Promise<Output[]> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pdf = await openPdf(await bytesOf(file));
  const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
  const inch = (pt: number) => pt / 72;
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "PDF", width: inch(first.width), height: inch(first.height) });
  pptx.layout = "PDF";
  const SCALE = 2;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const v = page.getViewport({ scale: 1 });
    const sx = first.width / v.width;
    const sy = first.height / v.height;
    const slide = pptx.addSlide();
    if (!o.pptText) {
      slide.background = { data: await imageData(await renderPage(page, SCALE), "jpg") };
    } else {
      const { figures, ops } = await slidePictures(page);
      const art = await slideRender(page, SCALE, ops);
      if (!blank(art)) slide.background = { data: await imageData(art, "jpg") };
      if (figures.length) {
        const shown = await slideRender(page, SCALE, new Set());
        for (const f of figures) {
          const w = Math.max(1, Math.round((f.x1 - f.x0) * SCALE));
          const h = Math.max(1, Math.round((f.y1 - f.y0) * SCALE));
          const crop = document.createElement("canvas");
          crop.width = w;
          crop.height = h;
          crop.getContext("2d")!.drawImage(shown, Math.round(f.x0 * SCALE), Math.round(f.y0 * SCALE), w, h, 0, 0, w, h);
          // Small pictures (logos, charts) stay sharp as PNG; photos go to JPEG.
          slide.addImage({
            data: await imageData(crop, w * h < 600_000 ? "png" : "jpg"),
            x: inch(f.x0 * sx), y: inch(f.y0 * sy), w: inch((f.x1 - f.x0) * sx), h: inch((f.y1 - f.y0) * sy),
          });
        }
      }
      const scale = Math.min(sx, sy);
      for (const l of (await pageText(page)).lines) {
        for (const seg of lineSegments(l)) {
          slide.addText(
            seg.pieces.map((p) => ({
              text: p.text,
              options: { color: p.color, bold: p.bold, italic: p.italic, fontFace: p.font, fontSize: Math.max(4, p.size * scale) },
            })),
            {
              x: inch(seg.x * sx), y: inch(l.y * sy), w: inch(Math.max(seg.w, l.size) * sx * 1.04), h: inch(l.size * 1.3 * sy),
              fontSize: Math.max(4, l.size * scale), margin: 0, valign: "top", fit: "none", wrap: false,
            },
          );
        }
      }
    }
    page.cleanup();
    progress?.(i, pdf.numPages);
  }
  await closePdf(pdf);
  const out = await oneParagraphProps((await pptx.write({ outputType: "arraybuffer" })) as ArrayBuffer);
  return [{ name: `${baseName(file.name)}.pptx`, blob: out }];
}

// pptxgenjs writes paragraph properties before every run of a paragraph, but
// a paragraph may have them only once, first; PowerPoint can call the file
// damaged. The ones after a run are dropped (they repeat the first).
async function oneParagraphProps(pptx: ArrayBuffer): Promise<Blob> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(pptx);
  for (const name of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const xml = await zip.file(name)!.async("string");
    zip.file(name, xml.replace(/(<\/a:r>)<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, "$1"));
  }
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", compression: "DEFLATE" });
}

// The page's pictures, as layout.ts finds figures (not tiny, overlaps merged,
// not covering most of the page), and the operators that paint them. Indices
// are into the "print" operator list, the one rendering runs.
async function slidePictures(page: PDFPageProxy): Promise<{ figures: Figure[]; ops: Set<number> }> {
  const { OPS } = await pdfjs();
  const view = page.getViewport({ scale: 1 });
  const { fnArray, argsArray } = await page.getOperatorList({ intent: "print" });
  type M = [number, number, number, number, number, number];
  const mul = (m: M, n: M): M => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
  // pdf.js 6 passes matrices as one typed-array argument; older builds passed six numbers.
  const asMatrix = (a: unknown): M => {
    const src = (Array.isArray(a) && a.length === 1 ? a[0] : a) as ArrayLike<number>;
    return [src[0], src[1], src[2], src[3], src[4], src[5]].map(Number) as M;
  };
  const paints = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
  const images: { rect: Figure; op: number }[] = [];
  let ctm: M = [1, 0, 0, 1, 0, 0];
  const stack: M[] = [];
  // Annotation appearances (image stamps, signatures) are drawn in their own
  // space, mapped onto the annotation's rectangle; they stay in the background.
  let annotation = 0;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i] as unknown[];
    if (fn === OPS.beginAnnotation) annotation++;
    else if (fn === OPS.endAnnotation) annotation = Math.max(0, annotation - 1);
    else if (annotation) continue;
    else if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(asMatrix(a), ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (a[0] && typeof a[0] === "object") ctm = mul(asMatrix(a[0]), ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (paints.has(fn)) {
      // Images fill the unit square of the current matrix.
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => view.convertToViewportPoint(x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      images.push({ rect: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, op: i });
    }
  }
  // Figures are clamped to the page: one lying wholly off it comes out empty
  // or inside out, and its picture stays out (OOXML sizes must be positive).
  const figures = figuresOf(images.map((m) => ({ ...m.rect })), view.width, view.height).figures.filter((f) => f.x1 - f.x0 >= 16 && f.y1 - f.y0 >= 16);
  const inside = (f: Figure, r: Figure) => r.x0 >= f.x0 - 3 && r.x1 <= f.x1 + 3 && r.y0 >= f.y0 - 3 && r.y1 <= f.y1 + 3;
  const ops = new Set(images.filter((m) => figures.some((f) => inside(f, m.rect))).map((m) => m.op));
  return { figures, ops };
}

// The page drawn without its text and without the operators in `drop`.
async function slideRender(page: PDFPageProxy, scale: number, drop: Set<number>) {
  const { OPS } = await pdfjs();
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const text = new Set([OPS.showText, OPS.showSpacedText, OPS.nextLineShowText, OPS.nextLineSetSpacingShowText]);
  const operationsFilter = (i: number, list: { fnArray: number[] }) => !text.has(list.fnArray[i]) && !drop.has(i);
  // "print", as renderPage: no requestAnimationFrame, so background tabs keep going.
  await page.render({ canvas, canvasContext: ctx, viewport, intent: "print", operationsFilter }).promise;
  return canvas;
}

// Nothing but white: the page has no vector art to keep.
function blank(canvas: HTMLCanvasElement) {
  const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  for (let k = 0; k < data.length; k += 4) if (data[k] < 250 || data[k + 1] < 250 || data[k + 2] < 250) return false;
  return true;
}

// pptxgenjs takes images as "image/png;base64,…".
async function imageData(canvas: HTMLCanvasElement, type: "png" | "jpg") {
  const mime = type === "png" ? "image/png" : "image/jpeg";
  const bytes = await bytesOf(await canvasToBlob(canvas, mime, 0.88));
  let bin = "";
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return `${mime};base64,${btoa(bin)}`;
}

// A line's text boxes: runs far apart (table columns, a label and its value)
// get boxes of their own, so they stay where they were. Each box's text is in
// pieces with the style and colour of the runs they came from.
type Piece = { text: string; color: string; bold: boolean; italic: boolean; font: string; size: number };
function lineSegments(l: Line): { x: number; w: number; pieces: Piece[] }[] {
  const groups: Run[][] = [];
  let lastEnd = -Infinity;
  for (const r of l.runs) {
    if (!groups.length || r.x - lastEnd > Math.max(l.size, r.size) * 2) groups.push([]);
    groups[groups.length - 1].push(r);
    lastEnd = Math.max(lastEnd, r.x + r.w);
  }
  return groups.flatMap((runs) => {
    const { text, from } = lineChars(runs);
    if (!text) return [];
    const pieces: Piece[] = [];
    let owner = runs[0];
    for (let k = 0; k < text.length; k++) {
      // A space put between runs goes with the run before it.
      const r = from[k] ? runs[from[k]![0]] : owner;
      const last = pieces[pieces.length - 1];
      if (last && r === owner) last.text += text[k];
      else if (last && sameLook(last, r)) {
        last.text += text[k];
        owner = r;
      } else {
        owner = r;
        pieces.push({ text: text[k], color: hex(r.color), bold: r.bold, italic: r.italic, font: r.font ?? "Arial", size: r.size });
      }
    }
    const last = runs[runs.length - 1];
    return [{ x: runs[0].x, w: last.x + last.w - runs[0].x, pieces }];
  });
}

const hex = (c?: string) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.slice(1).toUpperCase() : "000000");
const sameLook = (p: Piece, r: Run) =>
  p.color === hex(r.color) && p.bold === r.bold && p.italic === r.italic && p.font === (r.font ?? "Arial") && Math.abs(p.size - r.size) < 0.6;

// ── PDF → PDF/A (1b, 2b, 2u, 3b, 3u)
// Pages stay as they are (real text, vector graphics); pdfa.ts fixes what the
// standard forbids. Only pages it can't fix are rendered as images, with their
// text kept as an invisible searchable layer.
export async function pdfToPdfa(file: File, o: { pdfaDpi: string; keepText: boolean; pdfaLevel?: string }, progress?: Progress): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const { fixForPdfA, pdfaVersion, PDFA_LEVELS } = await import("./pdfa");
  const asked = PDFA_LEVELS.find((l) => l === o.pdfaLevel) ?? "2b";
  const { raster, level } = await fixForPdfA(doc, asked);
  if (raster.size) {
    // Rendered as fixed: annotations the original hid or didn't print are drawn, as on the pages kept as vectors.
    const src = await openPdf(await doc.save({ useObjectStreams: false }));
    const scale = Number(o.pdfaDpi) / 72;
    let done = 0;
    for (const i of [...raster].sort((a, b) => a - b)) {
      const view = await src.getPage(i + 1);
      const v = view.getViewport({ scale: 1 });
      const canvas = await renderPage(view, scale);
      const jpg = await doc.embedJpg(await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.88)));
      canvas.width = canvas.height = 0;
      // The same page object, so bookmarks and links into it still work.
      const page = doc.getPage(i);
      const node = page.node;
      for (const k of ["Annots", "CropBox", "BleedBox", "TrimBox", "ArtBox", "Group"]) node.delete(PDFName.of(k));
      node.set(PDFName.of("Contents"), doc.context.obj([]));
      node.set(PDFName.of("Resources"), doc.context.obj({}));
      node.set(PDFName.of("MediaBox"), doc.context.obj([0, 0, v.width, v.height]));
      node.set(PDFName.of("Rotate"), PDFNumber.of(0));
      page.drawImage(jpg, { x: 0, y: 0, width: v.width, height: v.height });
      if (o.keepText) addInvisibleText(doc, page, runsToWords((await pageText(view)).items, v.height));
      view.cleanup();
      progress?.(++done, raster.size);
    }
    await closePdf(src);
  }
  makePdfA(doc, doc.getTitle() || baseName(file.name), level);
  const out: Output = { name: `${baseName(file.name)}-pdfa.pdf`, blob: pdfBlob(pdfaVersion(await doc.save({ useObjectStreams: false }), level)) };
  if (level !== asked) out.note = `pdfaDowngraded:${level}`;
  return [out];
}

export function runsToWords(items: Run[], pageHeight: number) {
  return items
    .filter((r) => r.text.trim())
    .map((r) => r.turn
      // Turned text keeps its direction: clockwise on screen is counter-clockwise in PDF space.
      ? { text: r.text, x: r.turn.x, y: pageHeight - r.turn.y, width: r.turn.at[r.turn.at.length - 1], height: r.size * 0.95, angle: (-r.turn.angle * Math.PI) / 180 }
      : { text: r.text, x: r.x, y: pageHeight - (r.y + r.size), width: r.w, height: r.size * 0.95, angle: 0 });
}

function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makePdfA(doc: PDFDocument, title: string, level: string) {
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // The Info dictionary and the XMP must say the same things.
  const author = doc.getAuthor();
  const subject = doc.getSubject();
  const keywords = doc.getKeywords();
  const info = doc.context.lookup(doc.context.trailerInfo.Info);
  if (info instanceof PDFDict) info.delete(PDFName.of("Trapped"));
  doc.setTitle(title);
  doc.setProducer("Nopload");
  doc.setCreator("Nopload");
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title>${author ? `
   <dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>` : ""}${subject ? `
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(subject)}</rdf:li></rdf:Alt></dc:description>` : ""}${keywords ? `
   <pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>` : ""}
   <xmp:CreateDate>${iso}</xmp:CreateDate>
   <xmp:ModifyDate>${iso}</xmp:ModifyDate>
   <xmp:MetadataDate>${iso}</xmp:MetadataDate>
   <xmp:CreatorTool>Nopload</xmp:CreatorTool>
   <pdf:Producer>Nopload</pdf:Producer>
   <pdfaid:part>${level[0]}</pdfaid:part>
   <pdfaid:conformance>${level[1].toUpperCase()}</pdfaid:conformance>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  const ctx = doc.context;
  const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), ctx.register(meta));
  const icc = ctx.stream(srgbProfile(), { N: 3 });
  const intent = ctx.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    DestOutputProfile: ctx.register(icc),
  });
  doc.catalog.set(PDFName.of("OutputIntents"), ctx.obj([intent]));
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
}


// Loads the code a conversion loads as it runs (src/lib/offline.ts).
export function prepare(kind: "word" | "excel" | "ppt" | "pdf") {
  return Promise.all([
    pdfjs(),
    kind === "word" ? prepareDocx() : kind === "excel" ? import("exceljs") : kind === "ppt" ? import("pptxgenjs") : null,
  ]);
}
