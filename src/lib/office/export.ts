// What the Office → PDF options ask of LibreOffice. Most are its PDF export
// filter's own settings, passed as JSON with the save. Two aren't: fitting a
// sheet to the page and choosing sheets are each sheet's page setup, so the
// workbook is changed before it's opened. Other spreadsheet formats go
// through LibreOffice to XLSX first, so one way of changing them covers all.
//
// Kept free of browser APIs and path aliases: tests/libreoffice.mjs runs this
// same pipeline in Node.

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

// LibreOffice converting `data` (named `name`, whose extension says what it is)
// to `format`, with the export filter's options as JSON.
export type Convert = (data: Uint8Array, format: "pdf" | "xlsx", name: string, filterOptions?: string) => Promise<Uint8Array>;

// A mistake in the options rather than the file. The codes are the
// workspace's (src/lib/pdf/errors.ts), which reads them off any error.
export class ExportError extends Error {
  code: "bad_ranges" | "bad_sheets";
  fileName: string;
  constructor(code: "bad_ranges" | "bad_sheets", fileName: string) {
    super(`${code}: ${fileName}`);
    this.code = code;
    this.fileName = fileName;
  }
}

const SHEETS = ["xlsx", "xls", "ods", "csv"];
const SLIDES = ["pptx", "ppt", "odp"];
const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

// JPEG quality and the most pixels per inch an image keeps. Lossless keeps every pixel.
const IMAGES: Record<string, [quality: number, dpi: number]> = { high: [90, 300], medium: [80, 150], low: [60, 75] };
const PDFA: Record<string, number> = { "1b": 1, "2b": 2, "3b": 3 };

// "1-3, 5" as LibreOffice's PageRange wants it, or undefined for every page.
function pageRange(spec: string, fileName: string): string | undefined {
  const range = spec.replace(/\s+/g, "").replace(/;/g, ",");
  if (!range) return undefined;
  if (!/^\d+(-\d*)?(,\d+(-\d*)?)*$/.test(range) || /(^|[,-])0+(?=\D|$)/.test(range)) throw new ExportError("bad_ranges", fileName);
  return range;
}

export function pdfFilter(name: string, o: Record<string, unknown>): string {
  const filter: Record<string, { type: string; value: string }> = {};
  const set = (key: string, type: "boolean" | "long" | "string", value: unknown) => (filter[key] = { type, value: String(value) });
  const range = pageRange(String(o.officeRange ?? ""), name);
  if (range) set("PageRange", "string", range);
  const images = String(o.officeImages ?? "high");
  if (images === "lossless") {
    set("UseLosslessCompression", "boolean", true);
    set("ReduceImageResolution", "boolean", false);
  } else {
    const [quality, dpi] = IMAGES[images] ?? IMAGES.high;
    set("Quality", "long", quality);
    set("ReduceImageResolution", "boolean", true);
    set("MaxImageResolution", "long", dpi);
  }
  set("ExportBookmarks", "boolean", o.officeBookmarks ?? true);
  if (o.officeTagged) set("UseTaggedPDF", "boolean", true);
  const pdfa = PDFA[String(o.officePdfa ?? "off")];
  if (pdfa) set("SelectPdfVersion", "long", pdfa);
  if (SLIDES.includes(ext(name))) {
    set("ExportHiddenSlides", "boolean", Boolean(o.hiddenSlides));
    set("ExportNotesPages", "boolean", o.slideNotes === "both" || o.slideNotes === "notes");
    set("ExportOnlyNotesPages", "boolean", o.slideNotes === "notes");
  }
  return JSON.stringify(filter);
}

const unescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (_, e: string) =>
    ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e.toLowerCase()] ??
    String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))));
const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? unescape(m[1]) : undefined;
};
// The tag with `name` set to `value`, whether or not it had it.
const withAttr = (tag: string, name: string, value: string) =>
  tag.replace(new RegExp(`\\s${name}="[^"]*"`), "").replace(/\s*(\/?)>$/, ` ${name}="${value}"$1>`);

// Which of the visible sheets `spec` names ("2, 4-5, Budget"), in workbook
// order. Numbers count the sheets a reader sees, as tabs show them.
export function pickSheets(spec: string, visible: string[], fileName: string): Set<number> {
  const picked = new Set<number>();
  for (const part of spec.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
    const byName = visible.findIndex((n) => n.trim().toLowerCase() === part.toLowerCase());
    const span = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    const [from, to] = span ? [Number(span[1]), Number(span[2] ?? span[1])] : [0, 0];
    if (byName >= 0) picked.add(byName);
    else if (span && from >= 1 && from <= to && to <= visible.length) for (let i = from; i <= to; i++) picked.add(i - 1);
    else throw new ExportError("bad_sheets", fileName);
  }
  return picked;
}

// Elements that come after <pageSetup> in a worksheet, in schema order.
const AFTER_SETUP = ["headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];

// A worksheet scaled to `wide` pages across and `tall` down (0: as many as it needs).
function fitSheet(xml: string, wide: number, tall: number): string {
  const p = xml.match(/<(\w+:)?worksheet[\s>]/)?.[1] ?? "";
  const el = (name: string) => `${p}${name}`;
  const element = (name: string) => new RegExp(`<${el(name)}\\b[^>]*/>|<${el(name)}\\b[^>]*>[\\s\\S]*?</${el(name)}>`);
  // Page breaks set by hand would split it again.
  xml = xml.replace(element("colBreaks"), "");
  if (tall) xml = xml.replace(element("rowBreaks"), "");
  // <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>, sheetPr being the first child.
  const fit = `<${el("pageSetUpPr")} fitToPage="1"/>`;
  const setUpPr = new RegExp(`<${el("pageSetUpPr")}\\b[^>]*>`);
  const sheetPr = xml.match(new RegExp(`<${el("sheetPr")}\\b[^>]*>`));
  if (!sheetPr) xml = xml.replace(new RegExp(`<${el("worksheet")}\\b[^>]*>`), (open) => `${open}<${el("sheetPr")}>${fit}</${el("sheetPr")}>`);
  else if (sheetPr[0].endsWith("/>")) xml = xml.replace(sheetPr[0], `${sheetPr[0].replace(/\s*\/>$/, ">")}${fit}</${el("sheetPr")}>`);
  else if (setUpPr.test(xml)) xml = xml.replace(setUpPr, (tag) => withAttr(tag, "fitToPage", "1"));
  else xml = xml.replace(`</${el("sheetPr")}>`, `${fit}</${el("sheetPr")}>`);
  // <pageSetup fitToWidth fitToHeight/>, after pageMargins.
  const sized = (tag: string) => withAttr(withAttr(tag, "fitToWidth", String(wide)), "fitToHeight", String(tall));
  const setup = new RegExp(`<${el("pageSetup")}\\b[^>]*>`);
  if (setup.test(xml)) return xml.replace(setup, sized);
  const tag = sized(`<${el("pageSetup")}/>`);
  const margins = xml.match(new RegExp(`<${el("pageMargins")}\\b[^>]*/>`));
  if (margins) return xml.replace(margins[0], margins[0] + tag);
  const next = xml.match(new RegExp(`<(?:${AFTER_SETUP.map(el).join("|")})[\\s/>]`));
  return next ? xml.replace(next[0], tag + next[0]) : xml.replace(`</${el("worksheet")}>`, `${tag}</${el("worksheet")}>`);
}

// The XLSX workbook with its sheets fitted ("width": one page across;
// "page": one page each) and only the `pick`ed ones left visible.
export function prepareWorkbook(xlsx: Uint8Array, fit: string, pick: string, fileName: string): Uint8Array {
  const files = unzipSync(xlsx);
  const book = Object.keys(files).find((k) => /^xl\/workbook\.xml$/i.test(k));
  if (!book) return xlsx;
  if (pick.trim()) {
    let workbook = strFromU8(files[book]);
    const sheets = [...workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => m[0]);
    const shown = sheets.filter((s) => (attr(s, "state") ?? "visible") === "visible");
    const picked = pickSheets(pick, shown.map((s) => attr(s, "name") ?? ""), fileName);
    for (const [i, tag] of shown.entries()) if (!picked.has(i)) workbook = workbook.replace(tag, withAttr(tag, "state", "hidden"));
    // The open sheet has to be one that's still shown: LibreOffice shows the
    // first sheet again when no view says otherwise.
    const first = String(sheets.indexOf(shown[Math.min(...picked)]));
    const view = /<(\w+:)?workbookView\b[^>]*>/;
    if (view.test(workbook)) workbook = workbook.replace(view, (tag) => withAttr(withAttr(tag, "activeTab", first), "firstSheet", "0"));
    else workbook = workbook.replace(/<(\w+:)?sheets>/, (open, p = "") => `<${p}bookViews><${p}workbookView activeTab="${first}"/></${p}bookViews>${open}`);
    files[book] = strToU8(workbook);
  }
  const size = ({ width: [1, 0], page: [1, 1] } as Record<string, number[]>)[fit];
  if (size) {
    for (const k of Object.keys(files)) if (/^xl\/worksheets\/[^/]+\.xml$/i.test(k)) files[k] = strToU8(fitSheet(strFromU8(files[k]), size[0], size[1]));
  }
  return zipSync(files);
}

// The PDF for an Office file, with these options.
export async function exportPdf(convert: Convert, data: Uint8Array, name: string, o: Record<string, unknown>): Promise<Uint8Array> {
  const filter = pdfFilter(name, o);
  const fit = String(o.sheetFit ?? "file");
  const pick = String(o.sheetPick ?? "");
  let input = data;
  let file = name;
  if (SHEETS.includes(ext(name)) && (fit !== "file" || pick.trim())) {
    if (ext(name) !== "xlsx") {
      input = await convert(data, "xlsx", name);
      file = `${name.replace(/\.[^.]*$/, "")}.xlsx`;
    }
    input = prepareWorkbook(input, fit, pick, name);
  }
  try {
    return await convert(input, "pdf", file, filter);
  } catch (e) {
    // LibreOffice won't save a page range the document doesn't reach.
    if (o.officeRange && /Failed to save/i.test(String((e as Error)?.message ?? e))) throw new ExportError("bad_ranges", name);
    throw e;
  }
}
