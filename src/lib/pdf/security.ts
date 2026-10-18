"use client";

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFPage } from "pdf-lib";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, pdfBlob, pdfjs, renderPage, type Output, type Progress } from "./common";
import { prepareQpdf, runQpdf, QpdfError } from "./qpdf";
import { pageText, type PageText } from "./text";
import { addInvisibleText } from "./textlayer";
import { runsToWords } from "./convert";
import { visualFrame, type FracRect } from "./edit";
import { preparePdfium, redactInPlace, type Box } from "./pdfium";

export class WrongPasswordError extends Error {
  code = "wrong_password";
}

function randomPassword() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(36).padStart(2, "0")).join("");
}

export async function protect(
  file: File,
  o: { password: string; allowPrint: boolean; allowCopy: boolean; allowModify: boolean },
): Promise<Output[]> {
  // A separate random owner password means the permissions can't be lifted with the open password.
  const owner = randomPassword();
  const { output } = await runQpdf(await bytesOf(file), (i, out) => [
    "--encrypt", o.password, owner, "256",
    `--print=${o.allowPrint ? "full" : "none"}`,
    `--extract=${o.allowCopy ? "y" : "n"}`,
    `--modify=${o.allowModify ? "all" : "none"}`,
    "--",
    i, out,
  ]);
  return [{ name: `${baseName(file.name)}-protected.pdf`, blob: pdfBlob(output) }];
}

export async function unlock(file: File, o: { password: string }): Promise<Output[]> {
  // qpdf reports a bad password only on stderr, so check it with pdf.js first.
  try {
    await closePdf(await openPdf(await file.arrayBuffer(), o.password));
  } catch (e) {
    if ((e as { name?: string }).name === "PasswordException") throw new WrongPasswordError(file.name);
  }
  try {
    const { output } = await runQpdf(await bytesOf(file), (i, out) => [`--password=${o.password}`, "--decrypt", i, out]);
    return [{ name: `${baseName(file.name)}-unlocked.pdf`, blob: pdfBlob(output) }];
  } catch (e) {
    if (e instanceof QpdfError && e.wrongPassword) throw new WrongPasswordError(file.name);
    throw e;
  }
}

// Text matches → boxes in visual fractions, for the redaction editor.
export function findMatches(pages: PageText[], pattern: RegExp): { page: number; rect: FracRect }[] {
  const out: { page: number; rect: FracRect }[] = [];
  pages.forEach((p, pi) => {
    for (const line of p.lines) {
      // Match against each run separately so boxes follow real glyph positions.
      for (const run of line.runs) {
        const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(run.text))) {
          if (!m[0]) {
            re.lastIndex++;
            continue;
          }
          const per = run.w / Math.max(1, run.text.length);
          const exact = run.xs && run.xs.length === run.text.length + 1;
          const x = exact ? run.xs![m.index] : run.x + per * m.index;
          const w = exact ? run.xs![m.index + m[0].length] - x : per * m[0].length;
          const pad = run.size * 0.12;
          out.push({
            page: pi,
            rect: {
              x: (x - pad) / p.width,
              y: (run.y - pad) / p.height,
              w: (w + pad * 2) / p.width,
              h: (run.size * 1.2 + pad * 2) / p.height,
            },
          });
        }
      }
    }
  });
  return out;
}

const overlaps = (a: FracRect, b: FracRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// True redaction: PDFium removes the text, image pixels and shapes under each
// box and draws the box in black; everything else stays as it was (real text,
// sharp vectors). Pages are then copied into a new file, which leaves behind
// bookmarks, attachments, scripts, form data and tags that could repeat the
// hidden text. A page PDFium can't handle falls back to being rendered as an
// image with the boxes burned in.
function userBoxes(page: PDFPage, rects: FracRect[]): Box[] {
  const { vw, vh, map } = visualFrame(page);
  return rects.map((r) => {
    const pts = [
      map(r.x * vw, (1 - r.y) * vh), map((r.x + r.w) * vw, (1 - r.y) * vh),
      map(r.x * vw, (1 - r.y - r.h) * vh), map((r.x + r.w) * vw, (1 - r.y - r.h) * vh),
    ];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
}

// Links, notes and form fields under a box would still carry or point at what's hidden.
function dropAnnotsUnder(page: PDFPage, boxes: Box[]) {
  const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  if (!annots) return;
  const keep = annots.asArray().filter((ref) => {
    const a = page.doc.context.lookup(ref);
    const rect = a instanceof PDFDict ? a.lookupMaybe(PDFName.of("Rect"), PDFArray) : undefined;
    if (!rect) return true;
    const [x0, y0, x1, y1] = rect.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
    const r = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
    return !boxes.some((b) => r.x0 < b.x1 && b.x0 < r.x1 && r.y0 < b.y1 && b.y0 < r.y1);
  });
  page.node.set(PDFName.of("Annots"), page.doc.context.obj(keep));
}

export async function redact(file: File, marks: { page: number; rect: FracRect }[], o: { redactDpi: string }, progress?: Progress): Promise<Output[]> {
  const bytes = await bytesOf(file);
  const original = await PDFDocument.load(bytes, { updateMetadata: false });
  const byPage = new Map<number, FracRect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.rect]);
  const boxes = new Map([...byPage].map(([i, rects]) => [i, userBoxes(original.getPage(i), rects)] as const));

  let redacted: PDFDocument | null = null;
  let failed = new Set(byPage.keys());
  try {
    const res = await redactInPlace(bytes, boxes);
    redacted = await PDFDocument.load(res.bytes, { updateMetadata: false });
    failed = new Set(res.failed);
  } catch {
    // PDFium couldn't open or save the file: every marked page is rendered instead.
  }

  const view = failed.size ? await openPdf(bytes) : null;
  const out = await PDFDocument.create();
  const scale = Number(o.redactDpi) / 72;
  for (let i = 0; i < original.getPageCount(); i++) {
    const rects = byPage.get(i);
    if (!rects?.length || !failed.has(i)) {
      const [copied] = await out.copyPages(redacted ?? original, [i]);
      out.addPage(copied);
      if (rects?.length) dropAnnotsUnder(copied, boxes.get(i)!);
      progress?.(i + 1, original.getPageCount());
      continue;
    }
    const page = await view!.getPage(i + 1);
    const v = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    for (const b of rects) ctx.fillRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height);
    const jpg = await out.embedJpg(await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.9)));
    const p = out.addPage([v.width, v.height]);
    p.drawImage(jpg, { x: 0, y: 0, width: v.width, height: v.height });
    const text = await pageText(page);
    // Word by word, so text beside a redaction stays searchable.
    const words = text.items.flatMap((r) => {
      if (!r.xs || r.xs.length !== r.text.length + 1) return [r];
      const out: typeof text.items = [];
      for (const m of r.text.matchAll(/\S+/g)) {
        const x0 = r.xs[m.index], x1 = r.xs[m.index + m[0].length];
        out.push({ ...r, text: m[0], x: x0, w: x1 - x0, xs: undefined });
      }
      return out;
    });
    const keep = words.filter((r) => !rects.some((b) => overlaps(b, { x: r.x / v.width, y: r.y / v.height, w: r.w / v.width, h: r.h / v.height })));
    addInvisibleText(out, p, runsToWords(keep, v.height));
    canvas.width = canvas.height = 0;
    page.cleanup();
    progress?.(i + 1, original.getPageCount());
  }
  if (view) await closePdf(view);
  // Nothing from the original's metadata survives.
  out.setProducer("Foliant");
  out.setCreator("Foliant");
  out.setTitle(baseName(file.name));
  out.catalog.delete(PDFName.of("Metadata"));
  return [{ name: `${baseName(file.name)}-redacted.pdf`, blob: pdfBlob(await out.save({ useObjectStreams: true })) }];
}

// Loads the code protect, unlock and redact load as they run (src/lib/offline.ts).
export const prepare = () => Promise.all([pdfjs(), prepareQpdf(), preparePdfium()]);
