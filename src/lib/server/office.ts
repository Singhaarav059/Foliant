import "server-only";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { htmlToPdf, inBrowser } from "./chrome";
import { HttpError } from "./errors";
import { limiter, runProcess } from "./run";
import { docxHtml, pptxHtml, renderSlides, sheetHtml } from "@/lib/office/html";

const SOFFICE = [
  process.env.SOFFICE_PATH,
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/local/bin/soffice",
  "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
].filter(Boolean) as string[];

export const sofficePath = () => SOFFICE.find((p) => existsSync(p)) ?? null;

export class UnsupportedFormat extends HttpError {
  constructor(message: string) {
    super(422, message);
  }
}

// Settings for every run's private profile. An uploaded document runs no
// macros or embedded objects and loads nothing it links to: no linked
// files, images or URLs, and no Calc WEBSERVICE() or external references.
// Writer's link modes are NEVER 0 / MANUAL 1 / AUTO 2; Calc's are always 0 /
// never 1 / on request 2.
const PROFILE = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${[
  ["/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution", "true"],
  ["/org.openoffice.Office.Common/Security/Scripting", "MacroSecurityLevel", "3"],
  ["/org.openoffice.Office.Common/Security/Scripting", "DisableActiveContent", "true"],
  ["/org.openoffice.Office.Common/Security/Scripting", "DisablePythonRuntime", "true"],
  ["/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"],
  ["/org.openoffice.Office.Writer/Content/Update", "Link", "0"],
  ["/org.openoffice.Office.Calc/Content/Update", "Link", "1"],
].map(([path, name, value]) => `<item oor:path="${path}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`).join("\n")}
</oor:items>
`;

// MAX_OFFICE_JOBS LibreOffice runs at once (default 2), four waiting.
const gate = limiter(Number(process.env.MAX_OFFICE_JOBS ?? 2), 4);

async function viaLibreOffice(bin: string, data: Uint8Array, ext: string) {
  const dir = await mkdtemp(join(tmpdir(), "office-"));
  try {
    const input = join(dir, `input.${ext}`);
    await writeFile(input, data);
    // A private profile per run lets conversions happen in parallel.
    const profile = join(dir, "profile");
    await mkdir(join(profile, "user"), { recursive: true });
    await writeFile(join(profile, "user", "registrymodifications.xcu"), PROFILE);
    await runProcess(bin, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      "--headless", "--invisible", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
      "--convert-to", "pdf", "--outdir", dir, input,
    ], { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    return new Uint8Array(await readFile(join(dir, "input.pdf")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const officeToPdf = (data: Uint8Array, ext: string, orientation: string) => gate(() => convert(data, ext, orientation));

async function convert(data: Uint8Array, ext: string, orientation: string): Promise<{ pdf: Uint8Array; engine: string }> {
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
