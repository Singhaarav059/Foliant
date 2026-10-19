// Every tool, declared once. Pages, the grid, option panels, workflows and
// processing all read from here.

import { STATIC } from "./mode";
import { MAX_OCR_LANGS } from "./ocr-langs";

export type CategoryId =
  | "organize"
  | "optimize"
  | "convertTo"
  | "convertFrom"
  | "edit"
  | "security";

export const CATEGORIES: { id: CategoryId }[] = [
  { id: "organize" },
  { id: "optimize" },
  { id: "convertTo" },
  { id: "convertFrom" },
  { id: "edit" },
  { id: "security" },
];

// How the workspace behaves once files are in.
//  files   – list of files, options sidebar, one action
//  pages   – page thumbnails you select, rotate, reorder or delete
//  editor  – a page canvas you draw on (edit, sign, redact, crop, forms)
//  scan    – camera capture
//  compare – two files side by side
//  url     – a web address instead of a file
export type ToolMode = "files" | "pages" | "editor" | "scan" | "compare" | "url";

export type OptionDef =
  | { key: string; type: "select"; choices: string[]; default: string; when?: Cond }
  // Up to `max` of the choices, joined with "+" ("eng+hin"), in the order picked.
  | { key: string; type: "multi"; choices: string[]; max: number; default: string; when?: Cond }
  | { key: string; type: "toggle"; default: boolean; when?: Cond }
  | { key: string; type: "number"; min: number; max: number; step?: number; default: number; when?: Cond }
  | { key: string; type: "range"; min: number; max: number; step?: number; default: number; unit?: string; when?: Cond }
  | { key: string; type: "text"; default: string; placeholder?: string; when?: Cond }
  // `strength`: a strength meter and a suggested password, which also fills `confirm`.
  | { key: string; type: "password"; default: string; when?: Cond; strength?: boolean; confirm?: string }
  | { key: string; type: "color"; default: string; when?: Cond }
  | { key: string; type: "position"; default: string; grid: 6 | 9; when?: Cond }
  | { key: string; type: "image"; when?: Cond };

// Show an option only when another option has one of these values.
export type Cond = { key: string; is: (string | boolean)[] };

export type ToolId =
  | "merge" | "split" | "extract" | "remove" | "organize" | "scan"
  | "compress" | "repair" | "ocr"
  | "jpgToPdf" | "wordToPdf" | "pptToPdf" | "excelToPdf" | "htmlToPdf"
  | "pdfToJpg" | "pdfToWord" | "pdfToPpt" | "pdfToExcel" | "pdfToPdfa" | "pdfToMarkdown"
  | "rotate" | "pageNumbers" | "watermark" | "crop" | "edit" | "forms"
  | "unlock" | "protect" | "sign" | "redact" | "compare";

export type Tool = {
  id: ToolId;
  slug: string;
  category: CategoryId;
  icon: string; // lucide icon name, see components/ToolIcon
  mode: ToolMode;
  runtime: "browser" | "server";
  accept: string[]; // file extensions without the dot
  multiple: boolean;
  minFiles?: number;
  options: OptionDef[];
  // Can be a step in a saved workflow (no interactive canvas, PDF in → PDF out).
  chainable?: boolean;
  isNew?: boolean;
};

const PDF = ["pdf"];
const IMAGES = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic", "heif", "tif", "tiff", "avif", "svg"];

// Languages PaddleOCR's PP-OCRv5 model reads at least about as well as Tesseract
// (Tesseract codes), for high-accuracy OCR. tests/ocr-accuracy.mjs holds each to that.
// Not Greek (no accented letters or final sigma), French (« » œ ï î) or Portuguese (ã).
export const PADDLE_LANGS = ["eng", "deu", "ita", "spa", "nld", "swe", "cat", "ind", "msa", "swa", "chi_sim", "chi_tra", "jpn"];

// Tesseract's languages (tessdata_best, Apache-2.0), one vendored model each
// (scripts/vendor.mjs), downloaded only when picked. Every @tesseract.js-data
// package with an LSTM model; names come from src/lib/ocr-langs.ts.
export const OCR_LANGS = [
  "afr", "amh", "ara", "asm", "aze", "aze_cyrl", "bel", "ben", "bod", "bos", "bre", "bul",
  "cat", "ceb", "ces", "chi_sim", "chi_sim_vert", "chi_tra", "chi_tra_vert", "chr", "cos", "cym", "dan", "deu",
  "div", "dzo", "ell", "eng", "enm", "epo", "est", "eus", "fao", "fas", "fil", "fin",
  "fra", "frk", "frm", "fry", "gla", "gle", "glg", "grc", "guj", "hat", "heb", "hin",
  "hrv", "hun", "hye", "iku", "ind", "isl", "ita", "ita_old", "jav", "jpn", "jpn_vert", "kan",
  "kat", "kat_old", "kaz", "khm", "kir", "kmr", "kor", "kor_vert", "lao", "lat", "lav", "lit",
  "ltz", "mal", "mar", "mkd", "mlt", "mon", "mri", "msa", "mya", "nep", "nld", "nor",
  "oci", "ori", "pan", "pol", "por", "pus", "que", "ron", "rus", "san", "sin", "slk",
  "slv", "snd", "spa", "spa_old", "sqi", "srp", "srp_latn", "sun", "swa", "swe", "syr", "tam",
  "tat", "tel", "tgk", "tha", "tir", "ton", "tur", "uig", "ukr", "urd", "uzb", "uzb_cyrl",
  "vie", "yid", "yor",
];

// PDF to Word, Excel, PowerPoint and Markdown read scanned pages with OCR first (ocr.ts autoOcr).
const AUTO_OCR: OptionDef[] = [
  { key: "ocr", type: "select", choices: ["auto", "off"], default: "auto" },
  { key: "ocrLang", type: "multi", choices: OCR_LANGS, max: MAX_OCR_LANGS, default: "eng", when: { key: "ocr", is: ["auto"] } },
];

const ALL: Tool[] = [
  // ── Organise
  {
    id: "merge", slug: "merge-pdf", category: "organize", icon: "Combine", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, minFiles: 2, chainable: true,
    options: [{ key: "bookmarks", type: "toggle", default: true }],
  },
  {
    id: "split", slug: "split-pdf", category: "organize", icon: "Split", mode: "files",
    runtime: "browser", accept: PDF, multiple: false,
    options: [
      { key: "splitMode", type: "select", choices: ["ranges", "every", "size"], default: "ranges" },
      { key: "ranges", type: "text", default: "1-2, 3-4", placeholder: "1-3, 4, 5-8", when: { key: "splitMode", is: ["ranges"] } },
      { key: "every", type: "number", min: 1, max: 500, default: 1, when: { key: "splitMode", is: ["every"] } },
      { key: "maxMb", type: "number", min: 1, max: 500, default: 5, when: { key: "splitMode", is: ["size"] } },
      { key: "mergeRanges", type: "toggle", default: false, when: { key: "splitMode", is: ["ranges"] } },
    ],
  },
  {
    id: "extract", slug: "extract-pages", category: "organize", icon: "FileOutput", mode: "pages",
    runtime: "browser", accept: PDF, multiple: false,
    options: [{ key: "separate", type: "toggle", default: false }],
  },
  {
    id: "remove", slug: "remove-pages", category: "organize", icon: "FileMinus", mode: "pages",
    runtime: "browser", accept: PDF, multiple: false, options: [],
  },
  {
    id: "organize", slug: "organize-pdf", category: "organize", icon: "LayoutGrid", mode: "pages",
    runtime: "browser", accept: PDF, multiple: true, options: [],
  },
  {
    id: "scan", slug: "scan-to-pdf", category: "organize", icon: "ScanLine", mode: "scan",
    runtime: "browser", accept: IMAGES, multiple: true,
    options: [
      { key: "filter", type: "select", choices: ["document", "grayscale", "color"], default: "document" },
      { key: "pageSize", type: "select", choices: ["fit", "a4", "letter"], default: "a4" },
    ],
  },
  // ── Optimise
  {
    id: "compress", slug: "compress-pdf", category: "optimize", icon: "Shrink", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [{ key: "level", type: "select", choices: ["extreme", "recommended", "light"], default: "recommended" }],
  },
  {
    id: "repair", slug: "repair-pdf", category: "optimize", icon: "Wrench", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true, options: [],
  },
  {
    id: "ocr", slug: "ocr-pdf", category: "optimize", icon: "ScanText", mode: "files",
    runtime: "browser", accept: PDF, multiple: false, chainable: true,
    options: [
      { key: "ocrLang", type: "multi", choices: OCR_LANGS, max: MAX_OCR_LANGS, default: "eng" },
      // PaddleOCR (src/lib/pdf/paddle.ts); downloads about 36 MB the first time.
      { key: "ocrEngine", type: "select", choices: ["standard", "accurate"], default: "standard", when: { key: "ocrLang", is: PADDLE_LANGS } },
      { key: "dpi", type: "select", choices: ["150", "200", "300"], default: "200" },
    ],
  },
  // ── Convert to PDF
  {
    id: "jpgToPdf", slug: "jpg-to-pdf", category: "convertTo", icon: "ImagePlus", mode: "files",
    runtime: "browser", accept: IMAGES, multiple: true,
    options: [
      { key: "pageSize", type: "select", choices: ["fit", "a4", "a3", "a5", "letter", "legal", "custom"], default: "a4" },
      // Millimetres (src/lib/pdf/convert.ts imagesToPdf).
      { key: "pageWidth", type: "number", min: 10, max: 5000, default: 210, when: { key: "pageSize", is: ["custom"] } },
      { key: "pageHeight", type: "number", min: 10, max: 5000, default: 297, when: { key: "pageSize", is: ["custom"] } },
      { key: "orientation", type: "select", choices: ["auto", "portrait", "landscape"], default: "auto", when: { key: "pageSize", is: ["a4", "a3", "a5", "letter", "legal"] } },
      { key: "margin", type: "range", min: 0, max: 50, default: 7, unit: " mm", when: { key: "pageSize", is: ["a4", "a3", "a5", "letter", "legal", "custom"] } },
      { key: "separate", type: "toggle", default: false },
    ],
  },
  {
    id: "wordToPdf", slug: "word-to-pdf", category: "convertTo", icon: "FileType", mode: "files",
    runtime: "server", accept: ["docx", "doc", "odt", "rtf"], multiple: true, options: [],
  },
  {
    id: "pptToPdf", slug: "powerpoint-to-pdf", category: "convertTo", icon: "Presentation", mode: "files",
    runtime: "server", accept: ["pptx", "ppt", "odp"], multiple: true, options: [],
  },
  {
    id: "excelToPdf", slug: "excel-to-pdf", category: "convertTo", icon: "Sheet", mode: "files",
    runtime: "server", accept: ["xlsx", "xls", "ods", "csv"], multiple: true,
    options: [{ key: "orientation", type: "select", choices: ["auto", "portrait", "landscape"], default: "auto" }],
  },
  {
    id: "htmlToPdf", slug: "html-to-pdf", category: "convertTo", icon: "Globe", mode: "url",
    runtime: "server", accept: ["html", "htm"], multiple: false,
    options: [
      { key: "pageSize", type: "select", choices: ["a4", "letter", "single"], default: "a4" },
      { key: "orientation", type: "select", choices: ["portrait", "landscape"], default: "portrait", when: { key: "pageSize", is: ["a4", "letter"] } },
      { key: "screenWidth", type: "select", choices: ["1440", "1024", "390"], default: "1440" },
      { key: "hideOverlays", type: "toggle", default: true },
    ],
  },
  // ── Convert from PDF
  {
    id: "pdfToJpg", slug: "pdf-to-jpg", category: "convertFrom", icon: "Images", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [
      { key: "jpgMode", type: "select", choices: ["pages", "images"], default: "pages" },
      { key: "format", type: "select", choices: ["jpg", "png", "webp"], default: "jpg", when: { key: "jpgMode", is: ["pages"] } },
      { key: "dpi", type: "select", choices: ["72", "150", "300", "custom"], default: "150", when: { key: "jpgMode", is: ["pages"] } },
      { key: "customDpi", type: "number", min: 72, max: 600, step: 1, default: 200, when: { key: "dpi", is: ["custom"] } },
      { key: "pageRange", type: "text", default: "", placeholder: "all", when: { key: "jpgMode", is: ["pages"] } },
      { key: "transparent", type: "toggle", default: false, when: { key: "format", is: ["png", "webp"] } },
    ],
  },
  {
    id: "pdfToWord", slug: "pdf-to-word", category: "convertFrom", icon: "FileText", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "wordMode", type: "select", choices: ["editable", "exact"], default: "editable" }, ...AUTO_OCR],
  },
  {
    id: "pdfToPpt", slug: "pdf-to-powerpoint", category: "convertFrom", icon: "MonitorPlay", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "pptText", type: "toggle", default: true }, ...AUTO_OCR],
  },
  {
    id: "pdfToExcel", slug: "pdf-to-excel", category: "convertFrom", icon: "Table", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "sheetPer", type: "select", choices: ["page", "document"], default: "page" }, ...AUTO_OCR],
  },
  {
    id: "pdfToPdfa", slug: "pdf-to-pdfa", category: "convertFrom", icon: "Archive", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      { key: "pdfaDpi", type: "select", choices: ["150", "200", "300"], default: "200" },
      { key: "keepText", type: "toggle", default: true },
    ],
  },
  {
    id: "pdfToMarkdown", slug: "pdf-to-markdown", category: "convertFrom", icon: "Hash", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, isNew: true,
    options: [{ key: "pageBreaks", type: "toggle", default: false }, ...AUTO_OCR],
  },
  // ── Edit
  {
    id: "rotate", slug: "rotate-pdf", category: "edit", icon: "RotateCw", mode: "pages",
    runtime: "browser", accept: PDF, multiple: false, chainable: true,
    // 0 leaves the turning to the per-page arrows.
    options: [{ key: "angle", type: "select", choices: ["0", "90", "180", "270"], default: "90" }],
  },
  {
    id: "pageNumbers", slug: "add-page-numbers", category: "edit", icon: "ListOrdered", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      { key: "position", type: "position", grid: 6, default: "bottom-center" },
      { key: "numberFormat", type: "select", choices: ["n", "pageN", "nOfTotal", "pageNOfTotal", "custom", "bates"], default: "n" },
      // {page} and {pages}; {filename} and {date} work too.
      { key: "template", type: "text", default: "{page} / {pages}", when: { key: "numberFormat", is: ["custom"] } },
      { key: "batesPrefix", type: "text", default: "", placeholder: "ABC", when: { key: "numberFormat", is: ["bates"] } },
      { key: "batesDigits", type: "number", min: 1, max: 12, default: 6, when: { key: "numberFormat", is: ["bates"] } },
      { key: "numberStyle", type: "select", choices: ["1", "i", "I", "a", "A"], default: "1", when: { key: "numberFormat", is: ["n", "pageN", "nOfTotal", "pageNOfTotal", "custom"] } },
      { key: "startAt", type: "number", min: 1, max: 999999, default: 1 },
      { key: "pageRange", type: "text", default: "", placeholder: "all" },
      { key: "skipFirstPages", type: "number", min: 0, max: 9999, default: 0 },
      { key: "skipLastPages", type: "number", min: 0, max: 9999, default: 0 },
      { key: "font", type: "select", choices: ["helvetica", "arimo", "tinos", "cousine", "noto"], default: "helvetica" },
      { key: "fontSize", type: "range", min: 6, max: 36, default: 11, unit: "pt" },
      { key: "color", type: "color", default: "#1f2937" },
      { key: "margin", type: "select", choices: ["small", "normal", "large"], default: "normal" },
      { key: "facing", type: "toggle", default: false },
    ],
  },
  {
    id: "watermark", slug: "add-watermark", category: "edit", icon: "Stamp", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      { key: "markType", type: "select", choices: ["text", "image"], default: "text" },
      // {filename} and {date} are filled in per file.
      { key: "markText", type: "text", default: "CONFIDENTIAL", when: { key: "markType", is: ["text"] } },
      { key: "font", type: "select", choices: ["helvetica", "arimo", "tinos", "cousine", "noto"], default: "helvetica", when: { key: "markType", is: ["text"] } },
      { key: "markImage", type: "image", when: { key: "markType", is: ["image"] } },
      { key: "fontSize", type: "range", min: 8, max: 160, default: 56, unit: "pt", when: { key: "markType", is: ["text"] } },
      { key: "color", type: "color", default: "#d33f6a", when: { key: "markType", is: ["text"] } },
      { key: "markBox", type: "toggle", default: false, when: { key: "markType", is: ["text"] } },
      { key: "imageScale", type: "range", min: 5, max: 100, default: 40, unit: "%", when: { key: "markType", is: ["image"] } },
      { key: "position", type: "position", grid: 9, default: "middle-center" },
      { key: "mosaic", type: "toggle", default: false },
      { key: "tileSpacing", type: "range", min: 60, max: 300, step: 10, default: 100, unit: "%", when: { key: "mosaic", is: [true] } },
      { key: "opacity", type: "range", min: 5, max: 100, default: 30, unit: "%" },
      { key: "rotation", type: "range", min: -180, max: 180, default: 45, unit: "°" },
      { key: "layer", type: "select", choices: ["over", "under"], default: "over" },
      { key: "pageRange", type: "text", default: "", placeholder: "all" },
    ],
  },
  {
    id: "crop", slug: "crop-pdf", category: "edit", icon: "Crop", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false,
    options: [{ key: "cropScope", type: "select", choices: ["all", "current"], default: "all" }],
  },
  {
    id: "edit", slug: "edit-pdf", category: "edit", icon: "PenLine", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false, options: [],
  },
  {
    id: "forms", slug: "pdf-forms", category: "edit", icon: "TextCursorInput", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false,
    options: [{ key: "flatten", type: "toggle", default: false }],
  },
  // ── Security
  {
    id: "unlock", slug: "unlock-pdf", category: "security", icon: "LockOpen", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "password", type: "password", default: "" }],
  },
  {
    id: "protect", slug: "protect-pdf", category: "security", icon: "Lock", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      // Off: anyone can open the file, and the permissions below still apply.
      { key: "openPassword", type: "toggle", default: true },
      { key: "password", type: "password", default: "", strength: true, confirm: "confirmPassword", when: { key: "openPassword", is: [true] } },
      { key: "confirmPassword", type: "password", default: "", when: { key: "openPassword", is: [true] } },
      { key: "allowPrint", type: "toggle", default: true },
      { key: "allowPrintHigh", type: "toggle", default: true, when: { key: "allowPrint", is: [true] } },
      { key: "allowCopy", type: "toggle", default: true },
      { key: "allowModify", type: "toggle", default: false },
      { key: "allowAnnotate", type: "toggle", default: false },
      { key: "allowForms", type: "toggle", default: false },
      { key: "allowAssemble", type: "toggle", default: false },
      { key: "ownerPassword", type: "password", default: "" },
      { key: "encryption", type: "select", choices: ["aes256", "aes128"], default: "aes256" },
    ],
  },
  {
    id: "sign", slug: "sign-pdf", category: "security", icon: "Signature", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false, options: [],
  },
  {
    id: "redact", slug: "redact-pdf", category: "security", icon: "SquareSlash", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false,
    options: [{ key: "redactDpi", type: "select", choices: ["150", "200", "300"], default: "200" }],
  },
  {
    id: "compare", slug: "compare-pdf", category: "security", icon: "GitCompare", mode: "compare",
    runtime: "browser", accept: PDF, multiple: true, minFiles: 2, options: [],
  },
];

// Without a server, Office files go through LibreOffice in the browser
// (src/lib/office/libreoffice.ts), which writes a real PDF and reads every
// format; Standard lays them out in the browser and saves them through its
// print dialog. Automatic uses LibreOffice where the device can take it
// (src/lib/office/route.ts). HTML files always print.
const FIDELITY: OptionDef = { key: "fidelity", type: "select", choices: ["auto", "standard", "high"], default: "auto" };
export const LIGHT_OFFICE = ["docx", "pptx", "xlsx", "csv"];
const IN_BROWSER: Partial<Record<ToolId, Partial<Tool>>> = {
  wordToPdf: { accept: ["docx", "doc", "odt", "rtf"], options: [FIDELITY] },
  pptToPdf: { accept: ["pptx", "ppt", "odp"], options: [FIDELITY] },
  excelToPdf: {
    accept: ["xlsx", "xls", "ods", "csv"],
    // LibreOffice follows each sheet's own page setup, so orientation is for standard only.
    options: [FIDELITY, { key: "orientation", type: "select", choices: ["auto", "portrait", "landscape"], default: "auto", when: { key: "fidelity", is: ["standard"] } }],
  },
  htmlToPdf: {
    mode: "files",
    options: [
      { key: "pageSize", type: "select", choices: ["a4", "letter"], default: "a4" },
      { key: "orientation", type: "select", choices: ["portrait", "landscape"], default: "portrait" },
    ],
  },
};

export const TOOLS: Tool[] = STATIC
  ? ALL.map((t) => (t.runtime === "server" ? { ...t, ...IN_BROWSER[t.id], runtime: "browser" } : t))
  : ALL;

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug);
export const toolById = (id: ToolId) => TOOLS.find((t) => t.id === id)!;

export function defaultOptions(tool: Tool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of tool.options) if ("default" in o) out[o.key] = o.default;
  return out;
}

// With `defs`, an option shown only for another option's value is also hidden
// while that other option is (PDF to JPG's custom dpi, under the hidden dpi).
export function optionVisible(o: OptionDef, values: Record<string, unknown>, defs?: OptionDef[]): boolean {
  if (!o.when) return true;
  if (!o.when.is.includes(values[o.when.key] as string | boolean)) return false;
  const parent = defs?.find((d) => d.key === o.when!.key);
  return !parent || parent === o || optionVisible(parent, values, defs);
}

// Per task. On-device tools are bounded mainly by the device's memory.
export const LIMITS = { files: 100, mb: 200 };
