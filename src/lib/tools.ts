// Every tool, declared once. Pages, the grid, option panels, workflows and
// processing all read from here.

import { STATIC } from "./mode";
import { LOCALE_CODES } from "./i18n/locales";

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
//  check   – a report on the file's signatures, nothing to download
//  url     – a web address instead of a file
export type ToolMode = "files" | "pages" | "editor" | "scan" | "compare" | "check" | "url";

export type OptionDef =
  | { key: string; type: "select"; choices: string[]; default: string; when?: Cond }
  | { key: string; type: "toggle"; default: boolean; when?: Cond }
  | { key: string; type: "number"; min: number; max: number; step?: number; default: number; when?: Cond }
  | { key: string; type: "range"; min: number; max: number; step?: number; default: number; unit?: string; when?: Cond }
  | { key: string; type: "text"; default: string; placeholder?: string; when?: Cond }
  | { key: string; type: "password"; default: string; when?: Cond }
  | { key: string; type: "color"; default: string; when?: Cond }
  | { key: string; type: "position"; default: string; grid: 6 | 9; when?: Cond }
  | { key: string; type: "image"; when?: Cond };

// Show an option only when another option has one of these values.
// unset: also met while nothing has set the key (a value no option holds, like pdfaRaster).
export type Cond = { key: string; is: (string | boolean)[]; unset?: boolean };

export type ToolId =
  | "merge" | "split" | "extract" | "remove" | "organize" | "scan"
  | "compress" | "repair" | "ocr"
  | "jpgToPdf" | "wordToPdf" | "pptToPdf" | "excelToPdf" | "htmlToPdf"
  | "pdfToJpg" | "pdfToWord" | "pdfToPpt" | "pdfToExcel" | "pdfToPdfa" | "pdfToMarkdown" | "summarize"
  | "rotate" | "pageNumbers" | "watermark" | "crop" | "edit" | "forms"
  | "unlock" | "protect" | "sign" | "verify" | "redact" | "compare";

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
  // The dictionary key of its description, when not tool.<id>.desc (see descKey).
  desc?: string;
};

const PDF = ["pdf"];
const IMAGES = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic"];

// Languages PaddleOCR's PP-OCRv5 model reads at least about as well as Tesseract
// (Tesseract codes), for high-accuracy OCR. tests/ocr-accuracy.mjs holds each to that.
// Not Greek (no accented letters or final sigma), French (« » œ ï î) or Portuguese (ã).
export const PADDLE_LANGS = ["eng", "deu", "ita", "spa", "nld", "swe", "cat", "ind", "msa", "swa", "chi_sim", "chi_tra", "jpn"];

export const OCR_LANGS = [
  "eng", "spa", "fra", "deu", "ita", "por", "jpn", "rus", "kor", "chi_sim",
  "chi_tra", "ara", "bul", "cat", "nld", "ell", "hin", "ind", "msa", "pol",
  "swe", "tha", "tur", "ukr", "vie", "swa",
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
      { key: "ocrLang", type: "select", choices: OCR_LANGS, default: "eng" },
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
      { key: "orientation", type: "select", choices: ["auto", "portrait", "landscape"], default: "auto" },
      { key: "pageSize", type: "select", choices: ["fit", "a4", "letter"], default: "a4" },
      { key: "margin", type: "select", choices: ["none", "small", "large"], default: "small" },
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
      { key: "dpi", type: "select", choices: ["72", "150", "300"], default: "150", when: { key: "jpgMode", is: ["pages"] } },
      { key: "format", type: "select", choices: ["jpg", "png"], default: "jpg", when: { key: "jpgMode", is: ["pages"] } },
    ],
  },
  {
    id: "pdfToWord", slug: "pdf-to-word", category: "convertFrom", icon: "FileText", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "wordMode", type: "select", choices: ["editable", "exact"], default: "editable" }],
  },
  {
    id: "pdfToPpt", slug: "pdf-to-powerpoint", category: "convertFrom", icon: "MonitorPlay", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "pptText", type: "toggle", default: true }],
  },
  {
    id: "pdfToExcel", slug: "pdf-to-excel", category: "convertFrom", icon: "Table", mode: "files",
    runtime: "browser", accept: PDF, multiple: true,
    options: [{ key: "sheetPer", type: "select", choices: ["page", "document"], default: "page" }],
  },
  {
    id: "pdfToPdfa", slug: "pdf-to-pdfa", category: "convertFrom", icon: "Archive", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      { key: "pdfaLevel", type: "select", choices: ["1b", "2b", "2u", "3b", "3u"], default: "2b" },
      // pdfaRaster isn't an option: the workspace sets it once it knows whether some page must become an image.
      // Workflow steps never set it, and show both.
      { key: "pdfaDpi", type: "select", choices: ["150", "200", "300"], default: "200", when: { key: "pdfaRaster", is: [true], unset: true } },
      { key: "keepText", type: "toggle", default: true, when: { key: "pdfaRaster", is: [true], unset: true } },
    ],
  },
  {
    id: "pdfToMarkdown", slug: "pdf-to-markdown", category: "convertFrom", icon: "Hash", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, isNew: true,
    options: [{ key: "pageBreaks", type: "toggle", default: false }],
  },
  {
    // src/lib/ai/summarize.ts: the browser's built-in AI when already on the device, else extractive.
    id: "summarize", slug: "summarize-pdf", category: "convertFrom", icon: "TextQuote", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, isNew: true,
    options: [
      { key: "summaryLength", type: "select", choices: ["short", "medium", "long"], default: "medium" },
      { key: "summaryLang", type: "select", choices: ["same", ...LOCALE_CODES], default: "same" },
    ],
  },
  // ── Edit
  {
    id: "rotate", slug: "rotate-pdf", category: "edit", icon: "RotateCw", mode: "pages",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    // 0 leaves the turning to the per-page arrows.
    options: [{ key: "angle", type: "select", choices: ["0", "90", "180", "270"], default: "90" }],
  },
  {
    id: "pageNumbers", slug: "add-page-numbers", category: "edit", icon: "ListOrdered", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      { key: "position", type: "position", grid: 6, default: "bottom-center" },
      { key: "numberFormat", type: "select", choices: ["n", "pageN", "nOfTotal", "pageNOfTotal"], default: "n" },
      { key: "startAt", type: "number", min: 1, max: 9999, default: 1 },
      { key: "pageRange", type: "text", default: "", placeholder: "all" },
      { key: "skipFirst", type: "toggle", default: false },
      { key: "fontSize", type: "range", min: 6, max: 36, default: 11, unit: "pt" },
      { key: "color", type: "color", default: "#1f2937" },
      { key: "facing", type: "toggle", default: false },
    ],
  },
  {
    id: "watermark", slug: "add-watermark", category: "edit", icon: "Stamp", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, chainable: true,
    options: [
      { key: "markType", type: "select", choices: ["text", "image"], default: "text" },
      { key: "markText", type: "text", default: "CONFIDENTIAL", when: { key: "markType", is: ["text"] } },
      { key: "markImage", type: "image", when: { key: "markType", is: ["image"] } },
      { key: "fontSize", type: "range", min: 8, max: 160, default: 56, unit: "pt", when: { key: "markType", is: ["text"] } },
      { key: "color", type: "color", default: "#d33f6a", when: { key: "markType", is: ["text"] } },
      { key: "imageScale", type: "range", min: 5, max: 100, default: 40, unit: "%", when: { key: "markType", is: ["image"] } },
      { key: "position", type: "position", grid: 9, default: "middle-center" },
      { key: "mosaic", type: "toggle", default: false },
      { key: "opacity", type: "range", min: 5, max: 100, default: 30, unit: "%" },
      { key: "rotation", type: "select", choices: ["0", "45", "90", "180", "270", "-45"], default: "45" },
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
      { key: "password", type: "password", default: "" },
      { key: "confirmPassword", type: "password", default: "" },
      { key: "allowPrint", type: "toggle", default: true },
      { key: "allowCopy", type: "toggle", default: true },
      { key: "allowModify", type: "toggle", default: false },
    ],
  },
  {
    id: "sign", slug: "sign-pdf", category: "security", icon: "Signature", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false, options: [],
  },
  {
    id: "verify", slug: "verify-pdf-signature", category: "security", icon: "ShieldCheck", mode: "check",
    runtime: "browser", accept: PDF, multiple: false, options: [], isNew: true,
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
// format; Standard lays them out in the browser and draws the PDF there
// (src/lib/office/topdf.ts). Automatic uses LibreOffice where the device can
// take it (src/lib/office/route.ts). HTML files always print.
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
  // An HTML file, a zipped page or pasted HTML; a URL would need a server.
  htmlToPdf: {
    mode: "files",
    desc: "tool.htmlToPdf.descStatic",
    accept: ["html", "htm", "zip"],
    options: [
      { key: "pageSize", type: "select", choices: ["a4", "letter", "a3", "a5"], default: "a4" },
      { key: "orientation", type: "select", choices: ["portrait", "landscape"], default: "portrait" },
      { key: "margin", type: "select", choices: ["none", "small", "large"], default: "small" },
      { key: "screenWidth", type: "select", choices: ["page", "1440", "1024", "390"], default: "page" },
    ],
  },
};

export const TOOLS: Tool[] = STATIC
  ? ALL.map((t) => (t.runtime === "server" ? { ...t, ...IN_BROWSER[t.id], runtime: "browser" } : t))
  : ALL;

// A build can describe a tool differently (the static HTML to PDF takes no URL).
export const descKey = (tool: Tool) => tool.desc ?? `tool.${tool.id}.desc`;

export const toolBySlug = (slug: string) => TOOLS.find((t) => t.slug === slug);
export const toolById = (id: ToolId) => TOOLS.find((t) => t.id === id)!;

export function defaultOptions(tool: Tool): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of tool.options) if ("default" in o) out[o.key] = o.default;
  return out;
}

export function optionVisible(o: OptionDef, values: Record<string, unknown>) {
  if (!o.when) return true;
  const v = values[o.when.key];
  return (v === undefined && !!o.when.unset) || o.when.is.includes(v as string | boolean);
}

// Per task. On-device tools are bounded mainly by the device's memory.
export const LIMITS = { files: 100, mb: 200 };
