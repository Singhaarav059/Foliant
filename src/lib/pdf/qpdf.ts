"use client";

// qpdf compiled to WebAssembly. A fresh module per run: Emscripten's main()
// tears the runtime down on exit, so instances aren't reusable.
import { VENDOR } from "../vendor";

type QpdfModule = {
  FS: { writeFile(p: string, d: Uint8Array): void; readFile(p: string): Uint8Array; unlink(p: string): void };
  callMain(args: string[]): number;
};

export async function runQpdf(input: Uint8Array, args: (inPath: string, outPath: string) => string[]) {
  const createModule = (await import("@neslinesli93/qpdf-wasm")).default as unknown as (
    o: Record<string, unknown>,
  ) => Promise<QpdfModule>;
  const errors: string[] = [];
  const qpdf = await createModule({
    locateFile: () => `${VENDOR}qpdf.wasm`,
    noInitialRun: true,
    print: () => {},
    printErr: (line: string) => errors.push(line),
  });
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
  if (!output || (code !== 0 && code !== 3)) {
    throw new QpdfError(errors.join("\n") || `qpdf exited with ${code}`);
  }
  return { output, warnings: code === 3 ? errors : [] };
}

export class QpdfError extends Error {
  get wrongPassword() {
    return /invalid password/i.test(this.message);
  }
}
