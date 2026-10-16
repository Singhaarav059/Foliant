"use client";

import {
  PDFDocument, PDFPage, PDFFont, StandardFonts, rgb, degrees, BlendMode, PDFArray, PDFName,
  PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFTextField, PDFOptionList,
} from "pdf-lib";
import { baseName, hexToRgb, isWinAnsi, normaliseImage, pageSet, pdfBlob, textToPng, type Output } from "./common";
import { loadPdf } from "./organize";
import { fontCovering, layoutText, type LaidOut } from "./fonts";

// ── Visual ↔ user space
// Users place things on the page as they see it. A page may carry /Rotate and
// a CropBox that doesn't start at 0,0, so every placement goes through here.
export function visualFrame(page: PDFPage) {
  const box = page.getCropBox();
  const r = ((page.getRotation().angle % 360) + 360) % 360;
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
const isolated = new WeakSet<PDFPage>();
export function isolate(page: PDFPage) {
  if (isolated.has(page)) return;
  isolated.add(page);
  const ctx = page.doc.context;
  page.node.wrapContentStreams(ctx.register(ctx.stream("q")), ctx.register(ctx.stream("Q")));
}

async function save(doc: PDFDocument) {
  return pdfBlob(await doc.save({ useObjectStreams: true }));
}

// ── Text helpers. Helvetica when it can encode the text, bundled Noto fonts
// for other scripts, and an image of the text as a last resort (no bundled
// glyph, or the fonts couldn't be fetched).
async function textLine(doc: PDFDocument, font: PDFFont, text: string, size: number, bold = false): Promise<LaidOut | null> {
  if (isWinAnsi(text)) return { width: font.widthOfTextAtSize(text, size), runs: [{ font, text, x: 0 }] };
  if (text.includes("\n")) return null;
  return layoutText(doc, text, size, bold).catch(() => null);
}

async function drawLabel(
  doc: PDFDocument, page: PDFPage, font: PDFFont, text: string,
  o: { vx: number; vy: number; size: number; color: string; anchor: "left" | "center" | "right"; opacity?: number; angle?: number; bold?: boolean },
) {
  isolate(page);
  const f = visualFrame(page);
  const c = hexToRgb(o.color);
  const extra = o.angle ?? 0;
  const line = await textLine(doc, font, text, o.size, o.bold);
  if (line) {
    const dx = o.anchor === "center" ? -line.width / 2 : o.anchor === "right" ? -line.width : 0;
    // Offset along the rotated baseline so rotated labels stay anchored.
    const a = (extra * Math.PI) / 180;
    for (const run of line.runs) {
      const [x, y] = f.map(o.vx + (dx + run.x) * Math.cos(a), o.vy + (dx + run.x) * Math.sin(a));
      page.drawText(run.text, { x, y, size: o.size, font: run.font, color: rgb(c.r, c.g, c.b), opacity: o.opacity ?? 1, rotate: degrees(f.rot + extra) });
    }
    return { width: line.width, height: o.size };
  }
  const img = await textToPng(text, o.size, o.color, `${o.bold ? 700 : 500} {s}px system-ui, sans-serif`);
  const png = await doc.embedPng(img.png);
  const dx = o.anchor === "center" ? -img.width / 2 : o.anchor === "right" ? -img.width : 0;
  const a = (extra * Math.PI) / 180;
  const [x, y] = f.map(o.vx + dx * Math.cos(a) + img.height * 0.2 * Math.sin(a), o.vy + dx * Math.sin(a) - img.height * 0.2 * Math.cos(a));
  page.drawImage(png, { x, y, width: img.width, height: img.height, opacity: o.opacity ?? 1, rotate: degrees(f.rot + extra) });
  return { width: img.width, height: img.height };
}

// ── Page numbers
export async function pageNumbers(
  file: File,
  o: {
    position: string; numberFormat: string; startAt: number; pageRange: string; skipFirst: boolean;
    fontSize: number; color: string; facing: boolean;
    // Translated templates: "Page {n}", "Page {n} of {total}", "{n} of {total}".
    labels?: { page: string; pageOf: string; nOf: string };
  },
): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const total = pages.length;
  const chosen = pageSet(o.pageRange, total);
  if (o.skipFirst) chosen.delete(0);
  const numbered = [...chosen].sort((a, b) => a - b);
  const count = numbered.length;
  const labels = o.labels ?? { page: "Page {n}", pageOf: "Page {n} of {total}", nOf: "{n} of {total}" };
  const fill = (tpl: string, n: number, total: number) => tpl.replace("{n}", String(n)).replace("{total}", String(total));
  const [vert, horiz] = o.position.split("-");
  for (let k = 0; k < numbered.length; k++) {
    const i = numbered[k];
    const page = pages[i];
    const n = o.startAt + k;
    const last = o.startAt + count - 1;
    const text =
      o.numberFormat === "pageN" ? fill(labels.page, n, last)
      : o.numberFormat === "nOfTotal" ? fill(labels.nOf, n, last)
      : o.numberFormat === "pageNOfTotal" ? fill(labels.pageOf, n, last)
      : `${n}`;
    const { vw, vh } = visualFrame(page);
    const margin = Math.max(18, Math.min(vw, vh) * 0.045);
    let h = horiz;
    // Facing pages: outer edge alternates.
    if (o.facing && h !== "center" && (n % 2 === 0)) h = h === "left" ? "right" : "left";
    const vx = h === "left" ? margin : h === "right" ? vw - margin : vw / 2;
    const vy = vert === "top" ? vh - margin - o.fontSize * 0.75 : margin;
    await drawLabel(doc, page, font, text, {
      vx, vy, size: o.fontSize, color: o.color, anchor: h === "left" ? "left" : h === "right" ? "right" : "center",
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
    position: string; mosaic: boolean; opacity: number; rotation: string; layer: string; pageRange: string;
  },
): Promise<Output[]> {
  const doc = await loadPdf(file, file.name);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const chosen = pageSet(o.pageRange, pages.length);
  const opacity = o.opacity / 100;
  const angle = Number(o.rotation);
  const a = (angle * Math.PI) / 180;

  let image: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  let line: LaidOut | null = null;
  let textImg: { png: Uint8Array; width: number; height: number } | null = null;
  if (o.markType === "image") {
    if (!o.markImage) throw new Error("Choose an image for the watermark");
    const img = await normaliseImage(o.markImage);
    image = img.kind === "png" ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
  } else {
    line = await textLine(doc, font, o.markText, o.fontSize, true);
    if (!line) textImg = await textToPng(o.markText, o.fontSize, o.color, "700 {s}px system-ui, sans-serif");
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
      mh = font.heightAtSize(o.fontSize) * 0.72;
    }

    const draw = (cx: number, cy: number) => {
      // (cx, cy) is the visual centre of the mark. Rotate the bottom-left corner around it.
      const ox = cx - (mw / 2) * Math.cos(a) + (mh / 2) * Math.sin(a);
      const oy = cy - (mw / 2) * Math.sin(a) - (mh / 2) * Math.cos(a);
      const [x, y] = f.map(ox, oy);
      const rotate = degrees(f.rot + angle);
      if (image) page.drawImage(image, { x, y, width: mw, height: mh, opacity, rotate });
      else if (textImage) page.drawImage(textImage, { x, y, width: mw, height: mh, opacity, rotate });
      else {
        const c = hexToRgb(o.color);
        for (const run of line!.runs) {
          const [rx, ry] = f.map(ox + run.x * Math.cos(a), oy + run.x * Math.sin(a));
          page.drawText(run.text, { x: rx, y: ry, size: o.fontSize, font: run.font, color: rgb(c.r, c.g, c.b), opacity, rotate });
        }
      }
    };

    if (o.mosaic) {
      const stepX = mw * 1.6 + 40;
      const stepY = mh * 3 + 40;
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
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
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
          await drawLabel(doc, page, it.bold ? bold : font, lines[li], {
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
      const box = pages[page].getCropBox();
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

