import { baseName, type Output } from "@/lib/pdf/common";

// Static build, without LibreOffice: Word, PowerPoint and Excel files are laid
// out in the browser and drawn straight into a PDF file (topdf.ts), so phones
// never see a print dialog. HTML files, and Office files that drawing fails
// on, become a page the browser prints to PDF: the HTML travels as the
// output's blob, and PrintResults opens the print dialog.
export type PrintOptions = { orientation?: string; pageSize?: string; margin?: string; screenWidth?: string };

export async function printable(file: File, o: PrintOptions): Promise<Output> {
  const data = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (["docx", "pptx", "xlsx", "csv"].includes(ext)) {
    try {
      const { officePdf } = await import("./topdf");
      const pdf = await officePdf(data, ext, o, baseName(file.name));
      return { name: `${baseName(file.name)}.pdf`, blob: new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" }) };
    } catch (e) {
      console.warn("Drawing the PDF failed; printing instead.", e);
    }
  }
  const office = await import("./html");
  let html: string;
  let note: string | undefined;
  if (ext === "docx") {
    // docx-preview keeps the layout; mammoth is the fallback for files it can't render.
    try {
      const { fontBase, fontFaces } = await import("./faces");
      html = await (await import("./docx")).docxPreviewHtml(data, fontFaces(fontBase()));
    } catch {
      html = await office.docxHtml(data);
    }
  }
  else if (ext === "pptx") html = await office.pptxHtml(data);
  else if (ext === "xlsx" || ext === "csv") html = await office.sheetHtml(data, ext, o.orientation ?? "auto");
  else if (ext === "html" || ext === "htm" || ext === "zip") {
    // A zip is a page with its files; pasted HTML arrives as a file too.
    const page = ext === "zip" ? await office.siteFromZip(data) : new TextDecoder().decode(data);
    const safe = office.blockRemote(page);
    html = office.htmlPage(safe.html, o);
    if (safe.blocked) note = `remote:${safe.blocked}`;
  }
  else throw new Error(`.${ext} files can't be converted in the browser.`);
  // The print dialog suggests the document title as the file name.
  if (!/<title[\s>]/i.test(html)) html = office.intoHead(html, `<title>${esc(baseName(file.name))}</title>`);
  return { name: `${baseName(file.name)}.pdf`, blob: new Blob([html], { type: "text/html" }), print: true, note };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
