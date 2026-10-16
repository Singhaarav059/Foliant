import { baseName, type Output } from "@/lib/pdf/common";

// Static build: lays out an Office or HTML file as a page the browser prints
// to PDF. The HTML travels as the output's blob; PrintResults opens the print
// dialog, which writes a real PDF with selectable text.
export async function printable(file: File, o: { orientation?: string; pageSize?: string }): Promise<Output> {
  const data = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const office = await import("./html");
  let html: string;
  if (ext === "docx") html = await office.docxHtml(data);
  else if (ext === "pptx") html = await office.pptxHtml(data);
  else if (ext === "xlsx" || ext === "csv") html = await office.sheetHtml(data, ext, o.orientation ?? "auto");
  else if (ext === "html" || ext === "htm") html = intoHead(new TextDecoder().decode(data), pageSize(o));
  else throw new Error(`.${ext} files can't be converted in the browser.`);
  // The print dialog suggests the document title as the file name.
  if (!/<title[\s>]/i.test(html)) html = intoHead(html, `<title>${esc(baseName(file.name))}</title>`);
  return { name: `${baseName(file.name)}.pdf`, blob: new Blob([html], { type: "text/html" }), print: true };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A default page size for HTML files; their own @page rules still win because
// they come later.
const pageSize = (o: { orientation?: string; pageSize?: string }) =>
  `<style>@page { size: ${o.pageSize === "letter" ? "letter" : "A4"} ${o.orientation === "landscape" ? "landscape" : "portrait"}; margin: 12mm; }</style>`;

// Inside <head> when there is one, so the doctype stays first.
function intoHead(html: string, snippet: string) {
  const head = html.match(/<head[^>]*>/i) ?? html.match(/<html[^>]*>/i);
  if (!head || head.index === undefined) return snippet + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}
