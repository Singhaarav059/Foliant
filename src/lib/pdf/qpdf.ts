"use client";

// qpdf compiled to WebAssembly. A fresh module per run: Emscripten's main()
// tears the runtime down on exit, so instances aren't reusable.
import { VENDOR } from "../vendor";
import type { ErrorCode } from "./errors";

type QpdfModule = {
  FS: { writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array; unlink(p: string): void };
  callMain(args: string[]): number;
};

// Tests point this at the file on disk.
export const qpdfWasm = { url: () => `${VENDOR}qpdf.wasm` };

export async function runQpdf(input: Uint8Array, args: (inPath: string, outPath: string) => string[]) {
  const createModule = (await import("@neslinesli93/qpdf-wasm")).default as unknown as (
    o: Record<string, unknown>,
  ) => Promise<QpdfModule>;
  // This build ignores the print/printErr options: its output functions are
  // console.log and console.error, bound when the module is created. Swap
  // them in for that synchronous moment so qpdf's messages land here.
  const lines: string[] = [];
  const keep = { log: console.log, error: console.error };
  console.log = console.error = (...parts: unknown[]) => void lines.push(parts.join(" "));
  let pending: Promise<QpdfModule>;
  try {
    pending = createModule({ locateFile: () => qpdfWasm.url(), noInitialRun: true });
  } finally {
    console.log = keep.log;
    console.error = keep.error;
  }
  const qpdf = await pending;
  qpdf.FS.writeFile("/in.pdf", input);
  let code = 0;
  try {
    code = qpdf.callMain(args("/in.pdf", "/out.pdf"));
  } catch (e) {
    // Emscripten signals exit() by throwing an ExitStatus with a status field.
    const status = (e as { status?: number }).status;
    if (typeof status === "number") code = status;
    else throw e;
  }
  let output: Uint8Array | null = null;
  try {
    output = qpdf.FS.readFile("/out.pdf");
  } catch {
    output = null;
  }
  // qpdf exit codes: 0 success, 3 success with warnings, 2 error.
  if (!output || (code !== 0 && code !== 3)) throw new QpdfError(lines.join("\n") || `qpdf exited with ${code}`);
  return { output, warnings: code === 3 ? lines : [] };
}

export class QpdfError extends Error {
  // What the message means for the user (see errors.ts).
  code: ErrorCode;
  constructor(message: string) {
    super(message);
    // Problems with the input are reported against its path; anything else
    // (a rejected argument, say) isn't the file's fault.
    this.code = /invalid password/i.test(message) ? "encrypted"
      : /can't find PDF header|not a PDF file/i.test(message) ? "not_pdf"
      : /\/in\.pdf/.test(message) ? "damaged" : "unknown";
  }
  get wrongPassword() {
    return /invalid password/i.test(this.message);
  }
}
