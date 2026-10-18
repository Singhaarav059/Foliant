// Error codes: every engine failure must reach the user as a typed code with
// the file's name, never as raw parser or qpdf text.
//
//   node tests/errors.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, root, check, eq } from "./lib/load.mjs";

// pdf.js runs its worker in-process here, as converters in the browser use /vendor's copy.
globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

const results = { failed: 0 };
const test = check(results);
const fixture = (name) => new Uint8Array(readFileSync(join(root, "tests/fixtures", name)));
const asFile = (bytes, name) => new File([bytes], name, { type: name.endsWith(".pdf") ? "application/pdf" : "" });

const { loadPdf } = await load("organize");
const { runQpdf } = await load("qpdf");
const { protect } = await load("security");
const { compress, repair } = await load("optimize");
const { pdfToWord } = await load("convert");
const { openPdf } = await load("common");

// Runs fn, which must throw, and returns what it threw.
async function thrown(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("did not throw");
}

await test("a text file named .pdf is not_pdf, with its name", async () => {
  const e = await thrown(() => loadPdf(asFile(fixture("text-file.pdf"), "text-file.pdf"), "text-file.pdf"));
  eq(e.code, "not_pdf", "code");
  eq(e.fileName, "text-file.pdf", "fileName");
});

await test("a password-protected PDF is encrypted, with its name", async () => {
  const e = await thrown(() => loadPdf(asFile(fixture("locked-report.pdf"), "locked-report.pdf"), "locked-report.pdf"));
  eq(e.code, "encrypted", "code");
  eq(e.fileName, "locked-report.pdf", "fileName");
});

await test("compress on a text file says not_pdf", async () => {
  const e = await thrown(() => compress(asFile(fixture("text-file.pdf"), "text-file.pdf"), { level: "recommended" }));
  eq(e.code, "not_pdf", "code");
});

await test("qpdf's own diagnostics are captured", async () => {
  const e = await thrown(() => runQpdf(fixture("text-file.pdf"), (i, o) => ["--object-streams=generate", i, o]));
  if (!/PDF header|startxref/i.test(e.message)) throw new Error(`message was "${e.message}"`);
  eq(e.code, "not_pdf", "code");
});

await test("qpdf on a protected file says encrypted", async () => {
  const e = await thrown(() => runQpdf(fixture("locked-report.pdf"), (i, o) => ["--object-streams=generate", i, o]));
  eq(e.code, "encrypted", "code");
});

await test("protect on a protected file is typed, not 'qpdf exited with 2'", async () => {
  const e = await thrown(() => protect(asFile(fixture("locked-report.pdf"), "locked-report.pdf"), { password: "x", allowPrint: true, allowCopy: true, allowModify: true }));
  eq(e.code, "encrypted", "code");
});

await test("repair on a text file says not_pdf", async () => {
  const { fileError } = await load("errors");
  const file = asFile(fixture("text-file.pdf"), "text-file.pdf");
  const e = await fileError(await thrown(() => repair(file)), file);
  eq(e.code, "not_pdf", "code");
});

await test("pdf.js failures map by file content", async () => {
  const { fileError } = await load("errors");
  const text = asFile(fixture("text-file.pdf"), "text-file.pdf");
  eq((await fileError(await thrown(() => pdfToWord(text, { wordMode: "flow" })), text)).code, "not_pdf", "text file");
  // A PDF header followed by garbage is a damaged PDF, not "not a PDF".
  const garbage = new TextEncoder().encode("%PDF-1.7\n" + "garbage ".repeat(200));
  const broken = asFile(garbage, "broken.pdf");
  const e = await fileError(await thrown(() => openPdf(garbage)), broken);
  eq(e.code, "damaged", "broken PDF");
  eq(e.fileName, "broken.pdf", "fileName");
  const locked = asFile(fixture("locked-report.pdf"), "locked-report.pdf");
  eq((await fileError(await thrown(() => openPdf(fixture("locked-report.pdf"))), locked)).code, "encrypted", "pdf.js password");
});

await test("engine exceptions map to codes", async () => {
  const { toPdfError } = await load("errors");
  const pdf = new TextEncoder().encode("%PDF-1.7\n");
  eq(toPdfError(new RangeError("Maximum call stack size exceeded"), "loop.pdf", pdf).code, "damaged", "cyclic page tree");
  eq(toPdfError(new RangeError("Array buffer allocation failed"), "big.pdf", pdf).code, "out_of_memory", "allocation");
  eq(toPdfError(new DOMException("The source image could not be decoded.", "InvalidStateError"), "photo.heic").code, "image_unsupported", "HEIC");
  eq(toPdfError(Object.assign(new Error("Incorrect Password"), { name: "PasswordException", code: 2 }), "a.pdf").code, "wrong_password", "wrong password");
  eq(toPdfError(new Error("Couldn't download soffice.wasm.part1 (404)")).code, "download_failed", "download");
  eq(toPdfError(new TypeError("x is undefined"), "a.pdf", pdf).code, "unknown", "our own bug stays unknown");
});

await test("a server's own message is kept, not made unknown", async () => {
  const { ServerError, toPdfError, forFile } = await load("errors");
  // The API routes' messages are written for users (src/app/api/convert).
  const busy = toPdfError(new ServerError(429, "Too many conversions. Wait a few minutes."), "page.html");
  eq(busy.code, "server", "code");
  eq(busy.text, "Too many conversions. Wait a few minutes.", "text");
  // Office files go through forFile, which names the file.
  const docx = asFile(new Uint8Array([80, 75, 3, 4]), "brief.docx");
  const e = await thrown(() => forFile(docx, () => Promise.reject(new ServerError(415, "Unsupported file type."))));
  eq(e.code, "server", "forFile code");
  eq(e.text, "Unsupported file type.", "forFile text");
  eq(e.fileName, "brief.docx", "forFile fileName");
  // No answer at all: the connection, not the file.
  eq(toPdfError(new ServerError(0)).code, "network", "status 0");
  // A failure with no message from the route (a proxy's error page) stays unknown.
  eq(toPdfError(new ServerError(502)).code, "unknown", "no message");
});

await test("the report link carries tool, code and browser only", async () => {
  const { reportUrl } = await load("errors");
  const url = new URL(reportUrl("https://github.com/example/nopload/", { tool: "compress", code: "damaged", browser: "Firefox 140" }));
  eq(url.pathname, "/example/nopload/issues/new", "path");
  eq(url.searchParams.get("title"), "compress: damaged", "title");
  const body = url.searchParams.get("body");
  if (!body.includes("Tool: compress") || !body.includes("Error: damaged") || !body.includes("Browser: Firefox 140")) throw new Error(body);
  eq([...url.searchParams.keys()].join(), "title,body", "params");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
