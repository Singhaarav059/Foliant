import "server-only";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { htmlToPdf, inBrowser } from "./chrome";

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
      return { pdf: await htmlToPdf(await pptxHtml(data)), engine: "builtin" };
    default:
      throw new UnsupportedFormat(
        `.${ext} files need LibreOffice on the server. Save as .docx, .xlsx or .pptx, or install LibreOffice.`,
      );
  }
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── Word
async function docxHtml(data: Uint8Array) {
  const mammoth = await import("mammoth");
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const attr = (tag: string, name: string) => {
    const m = xml.match(new RegExp(`<w:${tag}\\b[^>]*\\bw:${name}="(\\d+)"`));
    return m ? Number(m[1]) / 20 : null;
  };
  const w = attr("pgSz", "w") ?? 595;
  const h = attr("pgSz", "h") ?? 842;
  const m = { t: attr("pgMar", "top") ?? 72, r: attr("pgMar", "right") ?? 72, b: attr("pgMar", "bottom") ?? 72, l: attr("pgMar", "left") ?? 72 };
  const { value } = await mammoth.convertToHtml(
    { buffer: Buffer.from(data) },
    { styleMap: ["p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => p.subtitle:fresh"] },
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}pt ${h}pt; margin: ${m.t}pt ${m.r}pt ${m.b}pt ${m.l}pt; }
    body { font: 11pt/1.4 Calibri, Carlito, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 10pt; } h1.title { font-size: 26pt; }
    h2 { font-size: 15pt; margin: 14pt 0 6pt; } h3 { font-size: 12.5pt; margin: 12pt 0 4pt; }
    p { margin: 0 0 8pt; } .subtitle { color: #555; font-size: 14pt; }
    table { border-collapse: collapse; margin: 6pt 0 10pt; width: 100%; }
    td, th { border: 0.5pt solid #999; padding: 3pt 5pt; vertical-align: top; }
    img { max-width: 100%; height: auto; }
    ul, ol { margin: 0 0 8pt 18pt; padding: 0; }
  </style></head><body>${value}</body></html>`;
}

// ── Excel and CSV
function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const sep = (text.split("\n")[0].match(/;/g)?.length ?? 0) > (text.split("\n")[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const argb = (c?: { argb?: string }) => (c?.argb && c.argb.length === 8 ? `#${c.argb.slice(2)}` : undefined);

async function sheetHtml(data: Uint8Array, ext: string, orientation: string) {
  type Sheet = { name: string; widths: number[]; rows: { height?: number; cells: { html: string; style: string; colspan: number; rowspan: number; skip: boolean }[] }[] };
  const sheets: Sheet[] = [];
  if (ext === "csv") {
    const rows = parseCsv(new TextDecoder().decode(data)).filter((r) => r.some((c) => c.trim()));
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, k) => Math.min(320, Math.max(48, ...rows.map((r) => (r[k]?.length ?? 0) * 7 + 12))));
    sheets.push({
      name: "Sheet1",
      widths,
      rows: rows.map((r, ri) => ({
        cells: Array.from({ length: cols }, (_, k) => ({
          html: esc(r[k] ?? ""), style: ri === 0 ? "font-weight:600" : /^-?[\d.,]+%?$/.test(r[k] ?? "") ? "text-align:right" : "",
          colspan: 1, rowspan: 1, skip: false,
        })),
      })),
    });
  } else {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(data) as unknown as ArrayBuffer);
    wb.eachSheet((ws) => {
      if (ws.state !== "visible") return;
      const rowCount = ws.actualRowCount ? ws.rowCount : 0;
      const colCount = ws.columnCount;
      if (!rowCount || !colCount) return;
      // Trim to the used area.
      let maxR = 0, maxC = 0;
      ws.eachRow({ includeEmpty: false }, (row, r) => {
        row.eachCell({ includeEmpty: false }, (cell, c) => {
          if (cell.text !== "") { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c); }
        });
      });
      if (!maxR) return;
      const merges = new Map<string, { cs: number; rs: number }>();
      const covered = new Set<string>();
      const model = ws.model as unknown as { merges?: string[] };
      for (const range of model.merges ?? []) {
        const [a, b] = range.split(":");
        const ca = ws.getCell(a), cb = ws.getCell(b);
        const r1 = Number(ca.row), c1 = Number(ca.col), r2 = Number(cb.row), c2 = Number(cb.col);
        merges.set(`${r1}:${c1}`, { cs: c2 - c1 + 1, rs: r2 - r1 + 1 });
        for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) if (r !== r1 || c !== c1) covered.add(`${r}:${c}`);
      }
      const widths: number[] = [];
      for (let c = 1; c <= maxC; c++) {
        const col = ws.getColumn(c);
        widths.push(col.hidden ? 0 : Math.round((col.width ?? 9) * 7 + 5));
      }
      const rows: Sheet["rows"] = [];
      for (let r = 1; r <= maxR; r++) {
        const row = ws.getRow(r);
        if (row.hidden) continue;
        const cells: Sheet["rows"][number]["cells"] = [];
        for (let c = 1; c <= maxC; c++) {
          const cell = row.getCell(c);
          const key = `${r}:${c}`;
          const st: string[] = [];
          const f = cell.font;
          if (f?.bold) st.push("font-weight:700");
          if (f?.italic) st.push("font-style:italic");
          if (f?.underline) st.push("text-decoration:underline");
          if (f?.size) st.push(`font-size:${f.size}pt`);
          const fc = argb(f?.color as { argb?: string });
          if (fc) st.push(`color:${fc}`);
          const fill = cell.fill as { type?: string; fgColor?: { argb?: string } } | undefined;
          const bg = fill?.type === "pattern" ? argb(fill.fgColor) : undefined;
          if (bg) st.push(`background:${bg}`);
          const al = cell.alignment;
          const numeric = typeof cell.value === "number" || cell.type === 4;
          st.push(`text-align:${al?.horizontal ?? (numeric ? "right" : "left")}`);
          if (al?.vertical) st.push(`vertical-align:${al.vertical === "middle" ? "middle" : al.vertical}`);
          st.push(al?.wrapText ? "white-space:pre-wrap" : "white-space:nowrap");
          const b = cell.border;
          for (const side of ["top", "right", "bottom", "left"] as const) {
            const s = b?.[side];
            if (s?.style) st.push(`border-${side}:${s.style === "thick" ? 2 : s.style === "medium" ? 1.5 : 0.75}px solid ${argb(s.color as { argb?: string }) ?? "#444"}`);
          }
          const m = merges.get(key);
          cells.push({
            html: esc(cell.text ?? ""),
            style: st.join(";"),
            colspan: m?.cs ?? 1,
            rowspan: m?.rs ?? 1,
            skip: covered.has(key) || ws.getColumn(c).hidden,
          });
        }
        rows.push({ height: row.height ? row.height * 1.333 : undefined, cells });
      }
      sheets.push({ name: ws.name, widths, rows });
    });
  }
  if (!sheets.length) throw new Error("This workbook has no visible data.");
  const A4 = { w: 595, h: 842 };
  const body = sheets.map((s, i) => {
    const total = s.widths.reduce((a, b) => a + b, 0) * 0.75; // px → pt
    const landscape = orientation === "landscape" || (orientation === "auto" && total > A4.w - 56);
    const usable = (landscape ? A4.h : A4.w) - 56;
    const zoom = Math.min(1, usable / Math.max(1, total));
    const cols = s.widths.map((w) => `<col style="width:${w}px">`).join("");
    const rows = s.rows.map((r) =>
      `<tr${r.height ? ` style="height:${r.height}px"` : ""}>${r.cells.filter((c) => !c.skip).map((c) =>
        `<td style="${c.style}"${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""}>${c.html}</td>`).join("")}</tr>`).join("");
    return `<section class="sheet" style="page:${landscape ? "land" : "port"};${i ? "break-before:page;" : ""}">
      <table style="zoom:${zoom.toFixed(3)}"><colgroup>${cols}</colgroup>${rows}</table></section>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page port { size: A4 portrait; margin: 28pt; }
    @page land { size: A4 landscape; margin: 28pt; }
    body { margin: 0; font: 10pt Calibri, Carlito, Arial, sans-serif; color: #111; }
    table { border-collapse: collapse; table-layout: fixed; }
    td { padding: 2px 4px; overflow: hidden; text-overflow: clip; border: 0.5px solid #e2e5ea; }
    tr { break-inside: avoid; }
  </style></head><body>${body}</body></html>`;
}

// ── PowerPoint: slide XML is parsed with Chrome's DOMParser, then printed slide per page.
async function pptxHtml(data: Uint8Array) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  const read = (p: string) => zip.file(p)?.async("string") ?? Promise.resolve("");
  const pres = await read("ppt/presentation.xml");
  const presRels = await read("ppt/_rels/presentation.xml.rels");
  const size = pres.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  const cx = size ? Number(size[1]) : 12192000;
  const cy = size ? Number(size[2]) : 6858000;
  const relTarget = (rels: string, id: string) => rels.match(new RegExp(`Id="${id}"[^>]*Target="([^"]+)"`))?.[1] ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*Id="${id}"`))?.[1];
  const ids = [...pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
  const resolve = (base: string, target: string) => {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const seg of target.split("/")) {
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return parts.join("/");
  };
  const media: Record<string, string> = {};
  const loadMedia = async (path: string) => {
    if (media[path] || !zip.file(path)) return;
    const ext = path.split(".").pop()!.toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
    if (!["png", "gif", "svg", "jpg", "jpeg"].includes(ext)) return; // EMF/WMF can't be shown in a browser
    media[path] = `data:${mime};base64,${await zip.file(path)!.async("base64")}`;
  };
  const relMap = async (path: string, rels: string) => {
    const out: Record<string, string> = {};
    for (const m of rels.matchAll(/<Relationship [^>]*>/g)) {
      const id = m[0].match(/Id="([^"]+)"/)?.[1];
      const target = m[0].match(/Target="([^"]+)"/)?.[1];
      if (!id || !target || /TargetMode="External"/.test(m[0])) continue;
      const full = resolve(path, target);
      out[id] = full;
      if (/\/media\//.test(full)) await loadMedia(full);
    }
    return out;
  };
  const relsPath = (p: string) => p.replace(/([^/]+)$/, "_rels/$1.rels");
  const slides = [];
  for (const id of ids) {
    const target = relTarget(presRels, id);
    if (!target) continue;
    const path = resolve("ppt/presentation.xml", target);
    const xml = await read(path);
    const rels = await read(relsPath(path));
    const relsObj = await relMap(path, rels);
    const layoutPath = Object.values(relsObj).find((p) => /slideLayouts\//.test(p)) ?? "";
    const layoutXml = layoutPath ? await read(layoutPath) : "";
    const layoutRels = layoutPath ? await relMap(layoutPath, await read(relsPath(layoutPath))) : {};
    const masterPath = Object.values(layoutRels).find((p) => /slideMasters\//.test(p)) ?? "";
    const masterXml = masterPath ? await read(masterPath) : "";
    const masterRels = masterPath ? await relMap(masterPath, await read(relsPath(masterPath))) : {};
    const themePath = Object.values(masterRels).find((p) => /theme\//.test(p)) ?? "";
    slides.push({ xml, rels: relsObj, layoutXml, layoutRels, masterXml, masterRels, themeXml: themePath ? await read(themePath) : "" });
  }
  if (!slides.length) throw new Error("No slides found in this presentation.");
  const pages = await inBrowser(renderSlides, { slides, media, cx, cy });
  const w = cx / 12700, h = cy / 12700;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${w}pt ${h}pt; margin: 0; }
    body { margin: 0; font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; }
    .slide { position: relative; width: ${w}pt; height: ${h}pt; overflow: hidden; break-after: page; background: #fff; }
    .slide:last-child { break-after: auto; }
    .sh { position: absolute; box-sizing: border-box; overflow: visible; }
    .sh p { margin: 0; line-height: 1.12; }
    .sh table { border-collapse: collapse; width: 100%; height: 100%; }
    .sh td { border: 0.75pt solid #fff; padding: 3pt 6pt; vertical-align: top; }
  </style></head><body>${pages.join("")}</body></html>`;
}

type SlideInput = {
  slides: { xml: string; rels: Record<string, string>; layoutXml: string; layoutRels: Record<string, string>; masterXml: string; masterRels: Record<string, string>; themeXml: string }[];
  media: Record<string, string>;
  cx: number;
  cy: number;
};

// Runs inside Chrome. Self-contained: no closures over server code.
function renderSlides(input: SlideInput): string[] {
  const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const PNS = "http://schemas.openxmlformats.org/presentationml/2006/main";
  const RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const parse = (x: string) => new DOMParser().parseFromString(x || "<x/>", "application/xml");
  const kids = (el: Element | null | undefined, ns: string, name: string) =>
    el ? Array.from(el.children).filter((c) => c.namespaceURI === ns && c.localName === name) : [];
  const kid = (el: Element | null | undefined, ns: string, name: string) => kids(el, ns, name)[0] ?? null;
  const pt = (emu: string | null | undefined) => (emu ? Number(emu) / 12700 : 0);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return input.slides.map((s) => {
    const slide = parse(s.xml), layout = parse(s.layoutXml), master = parse(s.masterXml), theme = parse(s.themeXml);
    const scheme: Record<string, string> = {};
    const cs = theme.getElementsByTagNameNS(A, "clrScheme")[0];
    if (cs) for (const c of Array.from(cs.children)) {
      const v = c.getElementsByTagNameNS(A, "srgbClr")[0]?.getAttribute("val") ?? c.getElementsByTagNameNS(A, "sysClr")[0]?.getAttribute("lastClr");
      if (v) scheme[c.localName] = `#${v}`;
    }
    const alias: Record<string, string> = { tx1: "dk1", bg1: "lt1", tx2: "dk2", bg2: "lt2" };
    const color = (holder: Element | null): string | null => {
      if (!holder) return null;
      const srgb = kid(holder, A, "srgbClr");
      if (srgb) return `#${srgb.getAttribute("val")}`;
      const sch = kid(holder, A, "schemeClr");
      if (sch) { const v = sch.getAttribute("val") ?? ""; return scheme[alias[v] ?? v] ?? null; }
      const sys = kid(holder, A, "sysClr");
      if (sys) return `#${sys.getAttribute("lastClr") ?? "000000"}`;
      return null;
    };
    const fillOf = (spPr: Element | null) => color(kid(spPr, A, "solidFill"));
    const sizes = (doc: Document, style: string) => {
      const st = doc.getElementsByTagNameNS(PNS, style)[0];
      const sz = st?.getElementsByTagNameNS(A, "lvl1pPr")[0]?.getElementsByTagNameNS(A, "defRPr")[0]?.getAttribute("sz");
      return sz ? Number(sz) / 100 : null;
    };
    const titleSize = sizes(master, "titleStyle") ?? 40;
    const bodySize = sizes(master, "bodyStyle") ?? 24;
    const ph = (el: Element) => el.getElementsByTagNameNS(PNS, "ph")[0] ?? null;
    const findPh = (doc: Document, p: Element) => {
      const type = p.getAttribute("type") ?? "body", idx = p.getAttribute("idx");
      const all = Array.from(doc.getElementsByTagNameNS(PNS, "sp"));
      return all.find((sp) => { const q = ph(sp); return q && idx && q.getAttribute("idx") === idx; }) ??
        all.find((sp) => { const q = ph(sp); return q && (q.getAttribute("type") ?? "body") === type; }) ?? null;
    };
    const xfrmOf = (el: Element): { x: number; y: number; w: number; h: number; rot: number } | null => {
      const x = el.getElementsByTagNameNS(A, "xfrm")[0] ?? el.getElementsByTagNameNS(PNS, "xfrm")[0];
      const off = x && kid(x, A, "off"), ext = x && kid(x, A, "ext");
      if (off && ext) return { x: pt(off.getAttribute("x")), y: pt(off.getAttribute("y")), w: pt(ext.getAttribute("cx")), h: pt(ext.getAttribute("cy")), rot: Number(x!.getAttribute("rot") ?? 0) / 60000 };
      const p = ph(el);
      if (!p) return null;
      for (const doc of [layout, master]) {
        const m = findPh(doc, p);
        if (m) { const r = xfrmOf(m); if (r) return r; }
      }
      return null;
    };
    const text = (txBody: Element | null, isTitle: boolean) => {
      if (!txBody) return "";
      const bodyPr = kid(txBody, A, "bodyPr");
      const anchor = bodyPr?.getAttribute("anchor");
      const paras = kids(txBody, A, "p").map((p) => {
        const pPr = kid(p, A, "pPr");
        const algn = pPr?.getAttribute("algn");
        const lvl = Number(pPr?.getAttribute("lvl") ?? 0);
        const bu = pPr && kid(pPr, A, "buChar")?.getAttribute("char");
        const noBu = pPr && kid(pPr, A, "buNone");
        const endSz = kid(p, A, "endParaRPr")?.getAttribute("sz");
        let html = "";
        let firstSize = 0;
        for (const r of Array.from(p.children)) {
          if (r.localName === "br") { html += "<br>"; continue; }
          if (r.localName !== "r" && r.localName !== "fld") continue;
          const rPr = kid(r, A, "rPr");
          const t = kid(r, A, "t")?.textContent ?? "";
          const sz = rPr?.getAttribute("sz") ? Number(rPr.getAttribute("sz")) / 100 : isTitle ? titleSize : bodySize;
          firstSize ||= sz;
          const st = [`font-size:${sz}pt`];
          if (rPr?.getAttribute("b") === "1") st.push("font-weight:700");
          if (rPr?.getAttribute("i") === "1") st.push("font-style:italic");
          if (rPr?.getAttribute("u") && rPr.getAttribute("u") !== "none") st.push("text-decoration:underline");
          const c = color(kid(rPr, A, "solidFill"));
          if (c) st.push(`color:${c}`);
          html += `<span style="${st.join(";")}">${esc(t)}</span>`;
        }
        const size = firstSize || (endSz ? Number(endSz) / 100 : isTitle ? titleSize : bodySize);
        // Body placeholders bullet by default; other shapes only when the XML asks.
        const owner = txBody.parentElement;
        const phType = owner && ph(owner) ? ph(owner)!.getAttribute("type") ?? "body" : null;
        const bullet = !isTitle && !noBu && html && (bu || phType === "body") ? `${esc(bu ?? "•")}&nbsp;` : "";
        const align = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : "left";
        return `<p style="text-align:${align};padding-left:${lvl * 18}pt;font-size:${size}pt;min-height:${size * 1.1}pt">${bullet}${html || "&nbsp;"}</p>`;
      });
      const justify = anchor === "ctr" ? "center" : anchor === "b" ? "flex-end" : "flex-start";
      return `<div style="display:flex;flex-direction:column;justify-content:${justify};height:100%;padding:3.6pt 7.2pt">${paras.join("")}</div>`;
    };
    const bg = (doc: Document, rels: Record<string, string>) => {
      const bgPr = doc.getElementsByTagNameNS(PNS, "bgPr")[0];
      if (!bgPr) return null;
      const c = fillOf(bgPr);
      if (c) return `background:${c}`;
      const blip = bgPr.getElementsByTagNameNS(A, "blip")[0]?.getAttributeNS(RNS, "embed");
      const src = blip && input.media[rels[blip]];
      return src ? `background:url(${src}) center/cover` : null;
    };
    const shapes = (tree: Element | null, rels: Record<string, string>, skipPh: boolean): string => {
      if (!tree) return "";
      let out = "";
      for (const el of Array.from(tree.children)) {
        if (el.localName === "grpSp") { out += shapes(el, rels, skipPh); continue; }
        if (!["sp", "pic", "graphicFrame", "cxnSp"].includes(el.localName)) continue;
        if (skipPh && ph(el)) continue; // layout/master placeholders are prompts, not content
        const box = xfrmOf(el);
        if (!box) continue;
        const spPr = kid(el, PNS, "spPr");
        const st = [`left:${box.x}pt`, `top:${box.y}pt`, `width:${box.w}pt`, `height:${box.h}pt`];
        if (box.rot) st.push(`transform:rotate(${box.rot}deg)`);
        const fill = fillOf(spPr);
        if (fill) st.push(`background:${fill}`);
        const ln = kid(spPr, A, "ln");
        const lc = ln && !kid(ln, A, "noFill") ? color(kid(ln, A, "solidFill")) : null;
        if (lc) st.push(`border:${Math.max(0.75, pt(ln!.getAttribute("w")))}pt solid ${lc}`);
        if (spPr?.getElementsByTagNameNS(A, "prstGeom")[0]?.getAttribute("prst") === "ellipse") st.push("border-radius:50%");
        if (el.localName === "pic") {
          const id = el.getElementsByTagNameNS(A, "blip")[0]?.getAttributeNS(RNS, "embed");
          const src = id && input.media[rels[id]];
          if (src) out += `<img class="sh" style="${st.join(";")};object-fit:fill" src="${src}">`;
          continue;
        }
        if (el.localName === "graphicFrame") {
          const tbl = el.getElementsByTagNameNS(A, "tbl")[0];
          if (!tbl) continue;
          const rows = Array.from(tbl.getElementsByTagNameNS(A, "tr")).map((tr, ri) => `<tr>${Array.from(tr.getElementsByTagNameNS(A, "tc")).map((tc) => {
            const tcPr = kid(tc, A, "tcPr");
            const c = fillOf(tcPr) ?? (ri === 0 ? scheme.accent1 ?? "#4472c4" : ri % 2 ? "#e9ebf5" : "#cfd5ea");
            return `<td style="background:${c};${ri === 0 ? "color:#fff;font-weight:700" : ""}">${text(kid(tc, A, "txBody"), false)}</td>`;
          }).join("")}</tr>`).join("");
          out += `<div class="sh" style="${st.join(";")}"><table>${rows}</table></div>`;
          continue;
        }
        const isTitle = ["title", "ctrTitle"].includes(ph(el)?.getAttribute("type") ?? "");
        out += `<div class="sh" style="${st.join(";")}">${text(kid(el, PNS, "txBody"), isTitle)}</div>`;
      }
      return out;
    };
    const tree = (doc: Document) => doc.getElementsByTagNameNS(PNS, "spTree")[0] ?? null;
    const background = bg(slide, s.rels) ?? bg(layout, s.layoutRels) ?? bg(master, s.masterRels) ?? "background:#fff";
    // Master and layout decorations (logos, bars) sit under the slide's own shapes.
    const showMaster = slide.documentElement.getAttribute("showMasterSp") !== "0" && layout.documentElement?.getAttribute("showMasterSp") !== "0";
    return `<div class="slide" style="${background}">${showMaster ? shapes(tree(master), s.masterRels, true) : ""}${shapes(tree(layout), s.layoutRels, true)}${shapes(tree(slide), s.rels, false)}</div>`;
  });
}
