// Every tool, declared once. Pages, the grid, option panels, workflows and
// processing all read from here.

import { STATIC } from "./mode";

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
  | { key: string; type: "toggle"; default: boolean; when?: Cond }
  | { key: string; type: "number"; min: number; max: number; step?: number; default: number; when?: Cond }
  | { key: string; type: "range"; min: number; max: number; step?: number; default: number; unit?: string; when?: Cond }
  | { key: string; type: "text"; default: string; placeholder?: string; when?: Cond }
  | { key: string; type: "password"; default: string; when?: Cond }
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
const IMAGES = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "heic"];

// Languages PaddleOCR's PP-OCRv5 dictionary covers (Tesseract codes), for high-accuracy OCR.
export const PADDLE_LANGS = ["eng", "deu", "fra", "ita", "spa", "por", "nld", "swe", "cat", "ind", "msa", "swa", "ell", "chi_sim", "chi_tra", "jpn"];

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
      { key: "pdfaDpi", type: "select", choices: ["150", "200", "300"], default: "200" },
      { key: "keepText", type: "toggle", default: true },
    ],
  },
  {
    id: "pdfToMarkdown", slug: "pdf-to-markdown", category: "convertFrom", icon: "Hash", mode: "files",
    runtime: "browser", accept: PDF, multiple: true, isNew: true,
    options: [{ key: "pageBreaks", type: "toggle", default: false }],
  },
  // ── Edit
  {
    id: "rotate", slug: "rotate-pdf", category: "edit", icon: "RotateCw", mode: "pages",
    runtime: "browser", accept: PDF, multiple: false, chainable: true,
    options: [{ key: "angle", type: "select", choices: ["90", "180", "270"], default: "90" }],
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
    id: "redact", slug: "redact-pdf", category: "security", icon: "SquareSlash", mode: "editor",
    runtime: "browser", accept: PDF, multiple: false,
    options: [{ key: "redactDpi", type: "select", choices: ["150", "200", "300"], default: "200" }],
  },
  {
    id: "compare", slug: "compare-pdf", category: "security", icon: "GitCompare", mode: "compare",
    runtime: "browser", accept: PDF, multiple: true, minFiles: 2, options: [],
  },
];

// Without a server, Office and HTML files are laid out in the browser and
// saved through its print dialog, so those tools take fewer formats and options.
const IN_BROWSER: Partial<Record<ToolId, Partial<Tool>>> = {
  wordToPdf: { accept: ["docx"] },
  pptToPdf: { accept: ["pptx"] },
  excelToPdf: { accept: ["xlsx", "csv"] },
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

export function optionVisible(o: OptionDef, values: Record<string, unknown>) {
  return !o.when || o.when.is.includes(values[o.when.key] as string | boolean);
}

// Per task. On-device tools are bounded mainly by the device's memory.
export const LIMITS = { files: 100, mb: 200 };
