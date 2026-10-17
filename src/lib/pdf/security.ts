"use client";

import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObjectCopier, PDFPage, PDFPageLeaf, PDFRawStream, PDFRef, PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { baseName, bytesOf, canvasToBlob, closePdf, openPdf, pdfBlob, renderPage, type Output, type Progress } from "./common";
import { runQpdf, QpdfError } from "./qpdf";
import { charBox, lineChars, pageText, type PageText } from "./text";
import { addInvisibleText } from "./textlayer";
import { runsToWords } from "./convert";
import { visualFrame, type FracRect } from "./edit";
import { redactInPlace, type Box } from "./pdfium";

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

// The editor's quick marks. Plain spaces only: search text marks line breaks
// and column gaps with other whitespace, so a number never runs on into the
// next line (unless it wraps at a hyphen) or table cell.
export const PRESETS = {
  emails: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  phones: /(?:\+?\d[\d ().-]{7,}\d)/g,
  numbers: /\b\d[\d -]{6,}\d\b/g,
};

// The editor's search box as a pattern: the text as typed, where any run of
// spaces matches any whitespace (so a phrase may wrap to the next line),
// optionally in the same case only and as whole words only.
export function searchPattern(query: string, o: { matchCase?: boolean; wholeWord?: boolean } = {}) {
  const body = query.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const [before, after] = o.wholeWord ? ["(?<![\\p{L}\\p{N}_])", "(?![\\p{L}\\p{N}_])"] : ["", ""];
  return new RegExp(before + body + after, o.matchCase ? "gu" : "giu");
}

// A page's text as one string to search, and where each character comes from:
// [line, run, index]. Lines join with a line break, or with nothing where one
// ends in a hyphen after a letter or digit and the next starts with one (a
// word, number or code wrapped there). Such a hyphen may be part of the text
// (well-known, 123-45-6789) or only mark the break (confiden-tial), so
// `versions` holds the text as written and, when there are any, without the
// ones after a letter with a lowercase letter next; `at` takes each of a
// version's characters back to `text`. A gap as wide as a table column becomes
// a tab, so patterns that allow only spaces (the number presets) stay within a cell.
export function searchText(p: PageText) {
  let text = "";
  const from: ([number, number, number] | null)[] = [];
  const soft = new Set<number>();
  p.lines.forEach((line, li) => {
    const chars = lineChars(line.runs);
    if (li > 0) {
      if (/[\p{L}\p{N}][-\u2010\u00ad]$/u.test(text) && /^[\p{L}\p{N}]/u.test(chars.text)) {
        if (/\p{L}.$/u.test(text) && /^\p{Ll}/u.test(chars.text)) soft.add(text.length - 1);
      } else {
        text += "\n";
        from.push(null);
      }
    }
    chars.from.forEach((f, j) => {
      let ch = chars.text[j];
      const [before, after] = [chars.from[j - 1], chars.from[j + 1]];
      if (!f && before && after && before[0] !== after[0]) {
        const a = line.runs[before[0]];
        const b = line.runs[after[0]];
        if (b.x - (a.x + a.w) > Math.max(b.size * 1.2, 9)) ch = "\t";
      }
      text += ch;
      from.push(f ? [li, f[0], f[1]] : null);
    });
  });
  const all = Array.from({ length: text.length }, (_, k) => k);
  const versions = [{ text, at: all }];
  if (soft.size) {
    const at = all.filter((k) => !soft.has(k));
    versions.push({ text: at.map((k) => text[k]).join(""), at });
  }
  return { text, from, versions };
}

const globally = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

// Text matches → boxes in visual fractions, for the redaction editor. A match
// is found in the page's text, so it may span runs (a bold surname, a phrase
// split across text objects) and lines; it gets one box per line it covers.
// `hit` numbers the matches, `text` is what matched with whitespace as single spaces.
export function findMatches(pages: PageText[], pattern: RegExp): { page: number; rect: FracRect; text: string; hit: number }[] {
  const out: { page: number; rect: FracRect; text: string; hit: number }[] = [];
  const re = globally(pattern);
  let hit = 0;
  pages.forEach((p, pi) => {
    const { from, versions } = searchText(p);
    // Each match as the range of the text it covers (a hyphen left out
    // included); both versions find most of them.
    const found = new Map<string, [number, number, string]>();
    for (const v of versions) {
      for (const m of v.text.matchAll(re)) {
        if (!m[0]) continue;
        const [a, b] = [v.at[m.index], v.at[m.index + m[0].length - 1] + 1];
        if (!found.has(`${a}:${b}`)) found.set(`${a}:${b}`, [a, b, m[0]]);
      }
    }
    for (const [a, b, matched] of [...found.values()].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      // The characters covered, as a range in each run of each line.
      const covered = new Map<number, Map<number, [number, number]>>();
      for (let k = a; k < b; k++) {
        const f = from[k];
        if (!f) continue;
        const [li, ri, i] = f;
        const runs = covered.get(li) ?? new Map<number, [number, number]>();
        const [lo, hi] = runs.get(ri) ?? [i, i];
        runs.set(ri, [Math.min(lo, i), Math.max(hi, i)]);
        covered.set(li, runs);
      }
      for (const [li, runs] of covered) {
        const line = p.lines[li];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, size = 0;
        for (const [ri, [lo, hi]] of runs) {
          const run = line.runs[ri];
          const box = charBox(run, lo, hi + 1);
          x0 = Math.min(x0, box.x);
          y0 = Math.min(y0, box.y);
          x1 = Math.max(x1, box.x + box.w);
          y1 = Math.max(y1, box.y + box.h);
          size = Math.max(size, run.size);
        }
        const pad = size * 0.12;
        out.push({
          page: pi,
          hit,
          text: matched.replace(/\s+/g, " "),
          rect: { x: (x0 - pad) / p.width, y: (y0 - pad) / p.height, w: (x1 - x0 + pad * 2) / p.width, h: (y1 - y0 + pad * 2) / p.height },
        });
      }
      hit++;
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

const name = (s: string) => PDFName.of(s);

// Links, notes and form fields under a box would still carry or point at what's
// hidden. Popups and replies belong to their note and go with it. This runs
// before the page is copied, so what goes is never copied at all.
function dropAnnotsUnder(page: PDFPage, boxes: Box[]) {
  const annots = page.node.lookupMaybe(name("Annots"), PDFArray);
  if (!annots) return;
  const ctx = page.doc.context;
  const refs = annots.asArray();
  const dicts = refs.map((ref) => {
    const a = ctx.lookup(ref);
    return a instanceof PDFDict ? a : null;
  });
  const under = (a: PDFDict) => {
    const rect = a.lookupMaybe(name("Rect"), PDFArray);
    if (!rect) return false;
    const [x0, y0, x1, y1] = rect.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0));
    const r = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
    return boxes.some((b) => r.x0 < b.x1 && b.x0 < r.x1 && r.y0 < b.y1 && b.y0 < r.y1);
  };
  const gone = new Set(dicts.filter((a): a is PDFDict => a !== null && under(a)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of dicts) {
      if (!a || gone.has(a)) continue;
      const owner = a.lookupMaybe(name("Parent"), PDFDict) ?? a.lookupMaybe(name("IRT"), PDFDict);
      if (owner && gone.has(owner)) {
        gone.add(a);
        grew = true;
      }
    }
  }
  page.node.set(name("Annots"), ctx.obj(refs.filter((_, i) => !gone.has(dicts[i]!))));
}

// A page drawn as an image keeps nothing of the original. Set rather than
// removed, so nothing is inherited from the page tree either.
function blank(page: PDFPage) {
  const node = page.node;
  for (const key of node.keys()) if (key !== name("Type") && key !== name("Parent")) node.delete(key);
  node.set(name("MediaBox"), node.context.obj([0, 0, 1, 1]));
  node.set(name("CropBox"), node.context.obj([0, 0, 1, 1]));
  node.set(name("Resources"), node.context.obj({}));
  node.set(name("Rotate"), PDFNumber.of(0));
}

// Page data that could repeat what was hidden: a thumbnail, an editor's private
// copy of the page (Illustrator keeps the whole artwork there), page metadata,
// page scripts and article beads.
const PRIVATE = ["Thumb", "PieceInfo", "Metadata", "AA", "B", "StructParents"];

// Cuts what the copier would follow from the pages to anything they don't
// show: the page data above, link targets outside the page tree (a page that
// was never in it would come along hidden), replies and popups whose note is
// gone, and the form a widget belongs to. The output has no form, and a
// field's tree leads to every field in it, those under a box included.
// Done before copying, so none of it is copied at all.
function detach(doc: PDFDocument) {
  const pages = doc.getPages();
  const annots = new Set<PDFDict>();
  const list = (page: PDFPage) => (page.node.lookupMaybe(name("Annots"), PDFArray)?.asArray() ?? []).map((ref) => doc.context.lookup(ref));
  for (const page of pages) for (const a of list(page)) if (a instanceof PDFDict) annots.add(a);
  const refs = new Set(pages.map((p) => p.ref));
  const live = (o: unknown) => !(o instanceof PDFRef) || refs.has(o);
  const kept = (o: unknown) => o === undefined || annots.has(doc.context.lookup(o as PDFRef) as PDFDict);
  for (const page of pages) for (const key of PRIVATE) page.node.delete(name(key));
  for (const a of annots) {
    if (a.get(name("Subtype")) === name("Widget")) a.delete(name("Parent"));
    else if (!kept(a.get(name("Parent")))) a.delete(name("Parent"));
    for (const key of ["IRT", "Popup"]) if (!kept(a.get(name(key)))) a.delete(name(key));
    if (!live(a.get(name("P")))) a.delete(name("P"));
    const dest = a.lookupMaybe(name("Dest"), PDFArray);
    if (dest && !live(dest.get(0))) a.delete(name("Dest"));
    const action = a.lookupMaybe(name("A"), PDFDict);
    const target = action?.lookupMaybe(name("D"), PDFArray);
    if (target && !live(target.get(0))) a.delete(name("A"));
  }
}

// A searched text the caller expects gone everywhere, and the search that
// found it (the text itself, in the same case, when there is none).
export type Term = { text: string; pattern?: RegExp };

export class RedactionLeakError extends Error {
  code = "redaction_leak";
}

// `terms` are texts the caller expects gone everywhere (every search hit was
// kept). If the same search finds one anywhere, every marked page is drawn as
// an image instead; if it still finds one (a note or form field outside the
// boxes), nothing is returned.
export async function redact(
  file: File, marks: { page: number; rect: FracRect }[], o: { redactDpi: string; terms?: Term[] }, progress?: Progress,
): Promise<Output[]> {
  const bytes = await bytesOf(file);
  const byPage = new Map<number, FracRect[]>();
  for (const m of marks) byPage.set(m.page, [...(byPage.get(m.page) ?? []), m.rect]);
  const original = await PDFDocument.load(bytes, { updateMetadata: false });
  const boxes = new Map([...byPage].map(([i, rects]) => [i, userBoxes(original.getPage(i), rects)] as const));

  let pdfium: { bytes: Uint8Array; failed: number[] } | null = null;
  try {
    pdfium = await redactInPlace(bytes, boxes);
  } catch {
    // PDFium couldn't open or save the file: every marked page is rendered instead.
  }
  const terms = (o.terms ?? []).filter((t) => t.text.trim());
  const title = terms.some((t) => baseName(file.name).includes(t.text)) ? "" : baseName(file.name);
  const build = (raster: Set<number>) => assemble(bytes, pdfium?.bytes ?? null, byPage, boxes, raster, Number(o.redactDpi) / 72, title, progress);
  let out = await build(new Set(pdfium ? pdfium.failed : byPage.keys()));
  if (terms.length && (await leftovers(out, terms)).length) {
    out = await build(new Set(byPage.keys()));
    if ((await leftovers(out, terms)).length) throw new RedactionLeakError();
  }
  return [{ name: `${baseName(file.name)}-redacted.pdf`, blob: pdfBlob(out) }];
}

// Builds the output: pages from `redacted` (PDFium's file; the original when
// there is none), and the pages in `raster` drawn as images from the original.
async function assemble(
  bytes: Uint8Array, redacted: Uint8Array | null, byPage: Map<number, FracRect[]>, boxes: Map<number, Box[]>,
  raster: Set<number>, scale: number, title: string, progress?: Progress,
) {
  const src = await PDFDocument.load(redacted ?? bytes, { updateMetadata: false });
  const count = src.getPageCount();
  for (const [i, b] of boxes) {
    if (raster.has(i)) blank(src.getPage(i));
    else dropAnnotsUnder(src.getPage(i), b);
  }
  detach(src);
  // One copier for every page, so a link to another page lands on that page's
  // copy rather than bringing along a hidden duplicate (the unredacted one, for
  // a page drawn as an image).
  const out = await PDFDocument.create();
  let done = 0;
  const tick = () => progress?.(++done, count);
  await src.flush();
  const copier = PDFObjectCopier.for(src.context, out.context);
  for (let i = 0; i < count; i++) {
    const ref = copier.copy(src.getPage(i).ref);
    out.addPage(PDFPage.of(out.context.lookup(ref) as PDFPageLeaf, ref, out));
    if (!raster.has(i)) tick();
  }

  const view = raster.size ? await openPdf(bytes) : null;
  for (const i of [...raster].sort((a, b) => a - b)) {
    const rects = byPage.get(i) ?? [];
    const page = await view!.getPage(i + 1);
    const v = page.getViewport({ scale: 1 });
    const canvas = await renderPage(page, scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    for (const b of rects) ctx.fillRect(b.x * canvas.width, b.y * canvas.height, b.w * canvas.width, b.h * canvas.height);
    const jpg = await out.embedJpg(await bytesOf(await canvasToBlob(canvas, "image/jpeg", 0.9)));
    const p = out.getPage(i);
    for (const box of ["MediaBox", "CropBox"]) p.node.set(name(box), out.context.obj([0, 0, v.width, v.height]));
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
    tick();
  }
  if (view) await closePdf(view);
  // Nothing from the original's metadata survives.
  out.setProducer("Foliant");
  out.setCreator("Foliant");
  if (title) out.setTitle(title);
  out.catalog.delete(name("Metadata"));
  // qpdf rewrites the file from what it still refers to, so nothing left over
  // from editing survives, and drops resources no page uses (an image wholly
  // under a box that PDFium took off the page). Without it, nothing is saved.
  return (await runQpdf(await out.save({ useObjectStreams: true }), (i, o) => ["--object-streams=generate", "--remove-unreferenced-resources=yes", i, o])).output;
}

// Texts from `terms` the same search still finds in the file: in any string
// (link targets, notes, form values), in XMP or attached files, or in the text
// of a page. The document information dictionary is redact()'s own: dates,
// the producer and a title it has checked.
export async function leftovers(bytes: Uint8Array, terms: Term[]): Promise<string[]> {
  const found = new Set<string>();
  // Each term's own search, run again: a whole-word search for "Ann" doesn't
  // count "Anna", and "ANN" is another text.
  const searches = terms.map((t) => [t.text, globally(t.pattern ?? searchPattern(t.text, { matchCase: true }))] as const);
  const check = (s: string) => {
    for (const [text, re] of searches)
      if (!found.has(text) && [...s.matchAll(re)].some((m) => m[0].replace(/\s+/g, " ") === text)) found.add(text);
  };
  const visit = (o: unknown): void => {
    if (o instanceof PDFString || o instanceof PDFHexString) {
      try {
        check(o.decodeText());
      } catch {
        check(o.asString());
      }
    } else if (o instanceof PDFDict) o.values().forEach(visit);
    else if (o instanceof PDFArray) o.asArray().forEach(visit);
  };
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = doc.context.trailerInfo.Info;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (ref === info) continue;
    if (!(obj instanceof PDFRawStream)) {
      visit(obj);
      continue;
    }
    visit(obj.dict);
    const kind = [obj.dict.get(name("Type")), obj.dict.get(name("Subtype"))].map(String).join(" ");
    if (!/Metadata|EmbeddedFile|XML/.test(kind)) continue;
    let data: Uint8Array;
    try {
      data = decodePDFRawStream(obj).decode();
    } catch {
      data = obj.contents;
    }
    check(new TextDecoder().decode(data));
    check(new TextDecoder("utf-16be").decode(data));
  }
  const pdf = await openPdf(bytes);
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const text = await pageText(page);
      for (const v of searchText(text).versions) check(v.text);
      // Each run on its own as well, apart from the next (table cells "44" and "71" aren't "4471").
      check(text.items.map((r) => r.text).join("\n"));
      page.cleanup();
    }
  } finally {
    await closePdf(pdf);
  }
  return [...found];
}
