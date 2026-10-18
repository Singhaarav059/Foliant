// Errors the user can see. Every engine failure (pdf.js, pdf-lib, qpdf,
// PDFium, the browser's image decoder) is turned into one of these codes,
// with the name of the file to blame, at the point where that file is known.
// The workspace shows a translated message for the code, so raw parser text
// ("offset=43", "qpdf exited with 2") never reaches the page. Codes rather
// than classes, because class names don't survive minification.

export type ErrorCode =
  | "not_pdf"
  | "damaged"
  | "unrecoverable"
  | "encrypted"
  | "wrong_password"
  | "already_encrypted"
  | "password_too_long"
  | "protect_unverified"
  | "redaction_leak"
  | "no_pages"
  | "image_unsupported"
  | "page_too_large"
  | "out_of_memory"
  | "no_text"
  | "no_images"
  | "bad_ranges"
  | "bad_sheets"
  | "empty_document"
  | "missing_image"
  | "download_failed"
  | "office_isolation"
  | "office_memory"
  | "office_stalled"
  | "server"
  | "network"
  | "unknown";

const CODES = new Set<string>([
  "not_pdf", "damaged", "unrecoverable", "encrypted", "wrong_password", "already_encrypted", "password_too_long", "protect_unverified", "redaction_leak", "no_pages",
  "image_unsupported", "page_too_large", "out_of_memory", "no_text", "no_images", "bad_ranges", "bad_sheets", "empty_document",
  "missing_image", "download_failed", "office_isolation", "office_memory", "office_stalled", "server", "network", "unknown",
]);

export class PdfError extends Error {
  code: ErrorCode;
  fileName: string;
  // A message already written for the user, shown as it is (a "server" error's).
  text?: string;
  constructor(code: ErrorCode, fileName = "", cause?: unknown) {
    super(fileName ? `${code}: ${fileName}` : code, cause === undefined ? undefined : { cause });
    this.name = "PdfError";
    this.code = code;
    this.fileName = fileName;
  }
}

// A request to this site's API (the server build's conversions) that failed.
// The routes answer with a message written for users, kept as `text`. No
// answer at all (status 0) is the connection's fault; an answer without a
// message (a proxy's error page) is an unknown failure.
export class ServerError extends Error {
  code?: ErrorCode;
  text?: string;
  constructor(public status: number, text?: string) {
    super(text || `Server error ${status}`);
    this.code = status === 0 ? "network" : text ? "server" : undefined;
    this.text = text || undefined;
  }
}

// "%PDF-" within the first kilobyte, where readers look for it.
export function hasPdfHeader(head: Uint8Array) {
  const limit = Math.min(head.length, 1024) - 5;
  for (let i = 0; i <= limit; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

const isPdfName = (name: string) => /\.pdf$/i.test(name);

// Maps any thrown value to a PdfError. `head` (the file's first bytes) tells
// "not a PDF at all" from "a damaged PDF"; leave it out when the input
// isn't meant to be a PDF.
export function toPdfError(e: unknown, fileName = "", head?: Uint8Array): PdfError {
  const err = (e ?? {}) as { code?: unknown; fileName?: unknown; text?: unknown; name?: unknown; message?: unknown };
  if (typeof err.code === "string" && CODES.has(err.code)) {
    if (e instanceof PdfError && (e.fileName || !fileName)) return e;
    const typed = new PdfError(err.code as ErrorCode, (typeof err.fileName === "string" && err.fileName) || fileName, e);
    if (typeof err.text === "string") typed.text = err.text;
    return typed;
  }
  const name = typeof err.name === "string" ? err.name : "";
  const message = String(err.message ?? e ?? "");
  const as = (code: ErrorCode) => new PdfError(code, fileName, e);

  // pdf.js: code 2 is INCORRECT_PASSWORD, 1 is NEED_PASSWORD.
  if (name === "PasswordException") return as(err.code === 2 ? "wrong_password" : "encrypted");
  // pdf-lib ("…is encrypted…"), qpdf and PDFium (FPDF_ERR_PASSWORD) without a password.
  if (/is encrypted|invalid password|\(error 4\)/i.test(message)) return as("encrypted");
  if (/out of memory|allocation failed|could not allocate|Invalid (typed )?array length|Array buffer allocation/i.test(message)) return as("out_of_memory");
  // createImageBitmap and img.decode() on a format the browser can't read (HEIC outside Safari).
  if ((name === "InvalidStateError" || name === "EncodingError") && /decod/i.test(message)) return as("image_unsupported");
  // Office converters fetch parts of themselves, and read the document's contents.
  if (/Couldn't download|Failed to fetch|NetworkError|Load failed/i.test(message)) return as("download_failed");
  if (/no visible data|No slides found/i.test(message)) return as("empty_document");
  if (head && (!head.length || !hasPdfHeader(head))) return as("not_pdf");
  if (/No PDF header|can't find PDF header|not a PDF/i.test(message)) return as("not_pdf");
  // Structure errors from each parser, and the stack overflow a cyclic page tree causes.
  if (
    name === "InvalidPDFException" || name === "UnknownErrorException" ||
    (name === "RangeError" && /call stack/i.test(message)) ||
    /Invalid PDF|Failed to parse|startxref|xref|trailer|Expected instance of|Missing ?Catalog|parse error|could not open the file|damaged/i.test(message)
  ) return as(head || (fileName && isPdfName(fileName)) ? "damaged" : "unknown");
  return as("unknown");
}

// The same, reading the first bytes of the file itself.
export async function fileError(e: unknown, file: Blob & { name?: string }, fileName = file.name ?? ""): Promise<PdfError> {
  const typed = e as { code?: unknown };
  if (typeof typed?.code === "string" && CODES.has(typed.code)) return toPdfError(e, fileName);
  const pdf = isPdfName(fileName) || file.type === "application/pdf";
  let head: Uint8Array | undefined;
  if (pdf) {
    try {
      head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
    } catch {
      head = undefined;
    }
  }
  return toPdfError(e, fileName, head);
}

// Runs one file's work so any failure names that file.
export async function forFile<T>(file: Blob & { name?: string }, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    throw await fileError(e, file);
  }
}

// A prefilled issue on the project's tracker. It carries the tool, the error
// code and the browser only: never file names, text or content.
export function reportUrl(repo: string, o: { tool: string; code: string; browser: string }) {
  const title = `${o.tool}: ${o.code}`;
  const body = [
    `Tool: ${o.tool}`,
    `Error: ${o.code}`,
    `Browser: ${o.browser}`,
    "",
    "What happened (please don't attach private files):",
    "",
  ].join("\n");
  return `${repo.replace(/\/+$/, "")}/issues/new?${new URLSearchParams({ title, body })}`;
}
