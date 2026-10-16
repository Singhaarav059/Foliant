import "server-only";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { htmlToPdf, inBrowser } from "./chrome";
import { docxHtml, pptxHtml, renderSlides, sheetHtml } from "@/lib/office/html";

const run = promisify(execFile);

const SOFFICE = [
  process.env.SOFFICE_PATH,
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/local/bin/soffice",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
].filter(Boolean) as string[];

export const sofficePath = () => SOFFICE.find((p) => existsSync(p)) ?? null;

export class UnsupportedFormat extends Error {}

async function viaLibreOffice(bin: string, data: Uint8Array, ext: string) {
  const dir = await mkdtemp(join(tmpdir(), "office-"));
  try {
    const input = join(dir, `input.${ext}`);
    await writeFile(input, data);
    // A private profile per run lets conversions happen in parallel.
    await run(bin, [
      `-env:UserInstallation=file://${join(dir, "profile")}`,
      "--headless", "--norestore", "--convert-to", "pdf", "--outdir", dir, input,
    ], { timeout: 180_000 });
    return new Uint8Array(await readFile(join(dir, "input.pdf")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function officeToPdf(data: Uint8Array, ext: string, orientation: string): Promise<{ pdf: Uint8Array; engine: string }> {
  const bin = sofficePath();
  if (bin) return { pdf: await viaLibreOffice(bin, data, ext), engine: "libreoffice" };
  switch (ext) {
    case "docx":
      return { pdf: await htmlToPdf(await docxHtml(data)), engine: "builtin" };
    case "xlsx":
    case "csv":
      return { pdf: await htmlToPdf(await sheetHtml(data, ext, orientation)), engine: "builtin" };
    case "pptx":
      return { pdf: await htmlToPdf(await pptxHtml(data, (input) => inBrowser(renderSlides, input))), engine: "builtin" };
    default:
      throw new UnsupportedFormat(
        `.${ext} files need LibreOffice on the server. Save as .docx, .xlsx or .pptx, or install LibreOffice.`,
      );
  }
}
