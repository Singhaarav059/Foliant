// Word, Excel/CSV and PowerPoint → printable HTML. Shared by the server
// (which prints it with Chrome) and the static build (which opens the
// browser's own print dialog).

const onServer = typeof window === "undefined";
const arrayBufferOf = (data: Uint8Array) => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ── Word
export async function docxHtml(data: Uint8Array) {
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
    onServer ? { buffer: Buffer.from(data) } : { arrayBuffer: arrayBufferOf(data) },
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

export async function sheetHtml(data: Uint8Array, ext: string, orientation: string) {
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
    await wb.xlsx.load((onServer ? Buffer.from(data) : arrayBufferOf(data)) as unknown as ArrayBuffer);
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

// ── PowerPoint: slide XML is parsed with a browser's DOMParser, one slide per page.
// The server passes a renderer that runs renderSlides inside headless Chrome.
export async function pptxHtml(data: Uint8Array, render: (input: SlideInput) => Promise<string[]> = async (input) => renderSlides(input)) {
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
  const pages = await render({ slides, media, cx, cy });
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

export type SlideInput = {
  slides: { xml: string; rels: Record<string, string>; layoutXml: string; layoutRels: Record<string, string>; masterXml: string; masterRels: Record<string, string>; themeXml: string }[];
  media: Record<string, string>;
  cx: number;
  cy: number;
};

// Runs in a browser. Self-contained, so the server can hand it to headless Chrome.
export function renderSlides(input: SlideInput): string[] {
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

// ── HTML files, zipped pages and pasted HTML (static build). The browser
// prints the page from a blob: URL, where relative links resolve to nothing,
// so a zip's files are inlined as data: URLs; and nothing remote is loaded,
// so the page can't tell another site the user's address.

const MIME: Record<string, string> = {
  css: "text/css", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
};

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Attribute values, quoted or not: name="v", name='v', name=v.
const attr = (names: string) => new RegExp(`(\\s(?:${names})\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, "gi");

// One page from a zip: index.html (the shallowest), with its stylesheets,
// images, fonts and media inlined. Links to other pages stay as they are.
// What a zipped page may unpack in all: every file ends up base64 in one
// HTML string, which a phone's tab can't hold much beyond this.
export const ZIP_LIMIT = 150 * 2 ** 20;

export async function siteFromZip(data: Uint8Array): Promise<string> {
  const { unzipSync, strFromU8 } = await import("fflate");
  // Only files a page can use are unpacked (not backups, archives or
  // binaries it never references), and only up to ZIP_LIMIT.
  let total = 0;
  const files = unzipSync(data, {
    filter: (f) => {
      const ext = f.name.split(".").pop()!.toLowerCase();
      if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || !(ext === "html" || ext === "htm" || ext in MIME)) return false;
      total += f.originalSize;
      if (total > ZIP_LIMIT) throw new Error(`This zip is too big to convert here: its page files come to more than ${ZIP_LIMIT / 2 ** 20} MB.`);
      return true;
    },
  });
  const names = Object.keys(files).filter((n) => !n.endsWith("/") && !n.startsWith("__MACOSX/"));
  const depth = (n: string) => n.split("/").length;
  const pages = names.filter((n) => /\.html?$/i.test(n)).sort((a, b) => depth(a) - depth(b));
  const index = pages.find((n) => /(^|\/)index\.html?$/i.test(n) && depth(n) === depth(pages[0])) ?? pages[0];
  if (!index) throw new Error("This zip has no HTML page in it.");
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));

  const find = (from: string, ref: string) => {
    ref = ref.trim();
    if (!ref || /^[a-z][a-z\d+.-]*:|^\/\/|^#/i.test(ref)) return null; // other schemes, remote, fragments
    let path: string;
    try {
      path = decodeURIComponent(new URL(ref, `http://zip/${from}`).pathname.slice(1));
    } catch {
      return null;
    }
    return files[path] ? path : lower.get(path.toLowerCase()) ?? null;
  };
  const inline = (path: string, seen: Set<string>): string => {
    const ext = path.split(".").pop()!.toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    if (ext !== "css") return `data:${type};base64,${base64(files[path])}`;
    if (seen.has(path)) return "data:text/css,"; // @import cycle
    const text = css(strFromU8(files[path]), path, new Set([...seen, path]));
    return `data:text/css;base64,${base64(new TextEncoder().encode(text))}`;
  };
  // Unquoted data URLs, which are safe inside any attribute quotes.
  const css = (text: string, from: string, seen: Set<string>) =>
    text
      .replace(/@import\s+(["'])([^"']+)\1/gi, (all, _q, ref: string) => {
        const p = find(from, ref);
        return p ? `@import url(${inline(p, seen)})` : all;
      })
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, _q, ref: string) => {
        const p = find(from, ref);
        return p ? `url(${inline(p, seen)})` : all;
      });
  const rewrite = (value: string) => {
    const p = find(index, value.replace(/&amp;/g, "&"));
    return p ? inline(p, new Set()) : null;
  };
  const sub = (re: RegExp, html: string, fn: (value: string) => string | null) =>
    html.replace(re, (all, lead: string, dq?: string, sq?: string, bare?: string) => {
      const out = fn(dq ?? sq ?? bare ?? "");
      return out === null ? all : `${lead}"${out}"`;
    });

  let html = strFromU8(files[index]);
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open: string, body: string, close: string) => open + css(body, index, new Set()) + close);
  html = sub(attr("style"), html, (v) => css(v.replace(/&quot;/g, '"'), index, new Set()).replace(/"/g, "&quot;"));
  html = sub(attr("src|poster|data|background"), html, rewrite);
  html = sub(attr("srcset"), html, (v) => v.split(",").map((part) => {
    const [url, ...rest] = part.trim().split(/\s+/);
    return [rewrite(url) ?? url, ...rest].join(" ");
  }).join(", "));
  // href loads something only on <link> (stylesheets, icons) and in SVG images.
  html = html.replace(/<(link|image|use)\b[^>]*>/gi, (tag) => sub(attr("href|xlink:href"), tag, rewrite));
  return html;
}

// CSS escapes (\\68 or \\h) read as the characters they stand for.
const unescapeCss = (s: string) => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (_, hex: string | undefined, ch: string) => (hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch));

// Anything that resolves to another host, the way a browser reads it
// ("https:host", "\\host" and " //host" included). Relative URLs stay on
// this site; data:, blob: and about: load nothing.
const HERE = "http://page.invalid/";
function isRemote(ref: string) {
  let url: URL;
  try {
    url = new URL(ref.trim(), HERE);
  } catch {
    return false;
  }
  return !/^(data|blob|about|javascript|mailto|tel):$/.test(url.protocol) && url.origin !== new URL(HERE).origin;
}
// A grey box where a remote image was.
const PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#eef0f3" stroke="#c4c9d2" stroke-dasharray="4 3"/></svg>')}`;
// Belt and braces: the page itself may load only what it carries inline.
const CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline' data: blob:; font-src data: blob:; media-src data: blob:";
// Attributes that load what they point at.
const LOADS = new Set(["src", "poster", "data", "background", "lowsrc", "dynsrc", "xlink:href"]);

// Takes out everything that would load from another host: stylesheets,
// scripts, images (shown as a placeholder), frames, media, CSS url() and
// @import, <base> and refreshes. Links stay. Counts what it took out.
// The page is read with the browser's own parser, so what is checked is
// exactly what the browser would load; the CSP goes first in <head>.
export function blockRemote(input: string): { html: string; blocked: number } {
  let blocked = 0;
  const hit = () => (blocked++, true);
  // URLs may be written with CSS escapes (url(\\68ttps://…)), and image-set()
  // takes plain strings as well as url().
  const remote = (ref: string) => isRemote(unescapeCss(ref)) && hit();
  const css = (text: string) =>
    text
      .replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?[^;]*;?/gi, (all, _q, ref: string) => (remote(ref) ? "" : all))
      .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (all, _q, ref: string) => (remote(ref) ? "url(data:,)" : all))
      .replace(/((?:-webkit-)?image-set\()([^)]*(?:\([^)]*\)[^)]*)*)\)/gi, (_all, open: string, args: string) =>
        `${open}${args.replace(/(["'])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g, (str, _q, ref: string) => (remote(ref) ? '"data:,"' : str))})`);

  const doc = new DOMParser().parseFromString(input, "text/html");
  for (const el of [...doc.querySelectorAll("*")]) {
    if (!el.isConnected) continue;
    const name = el.localName.toLowerCase();
    const href = el.getAttribute("href") ?? "";
    if (name === "base") {
      if (isRemote(href)) hit();
      el.remove();
      continue;
    }
    if (name === "meta" && /^\s*refresh\s*$/i.test(el.getAttribute("http-equiv") ?? "")) {
      const to = (el.getAttribute("content") ?? "").match(/url\s*=\s*['"]?([^'"]*)/i)?.[1];
      if (to && isRemote(to) && hit()) el.remove();
      continue;
    }
    if ((name === "link" && isRemote(href)) || (name === "script" && isRemote(el.getAttribute("src") ?? ""))) {
      hit();
      el.remove();
      continue;
    }
    if (name === "style" && el.textContent) {
      const out = css(el.textContent);
      if (out !== el.textContent) el.textContent = out;
    }
    if (name === "iframe" && el.hasAttribute("srcdoc")) {
      const inner = blockRemote(el.getAttribute("srcdoc")!);
      blocked += inner.blocked;
      el.setAttribute("srcdoc", inner.html);
    }
    for (const at of [...el.attributes]) {
      const key = at.name.toLowerCase();
      const v = at.value;
      if (key === "style") {
        const out = css(v);
        if (out !== v) el.setAttribute(at.name, out);
      } else if (LOADS.has(key) || (key === "href" && /^(image|use|feimage)$/.test(name))) {
        if (!isRemote(v) || !hit()) continue;
        if (/^(img|input|image|use|feimage)$/.test(name) && key !== "poster") el.setAttribute(at.name, PLACEHOLDER);
        else if (/^i?frame$/.test(name)) el.setAttribute(at.name, "about:blank");
        else el.removeAttribute(at.name);
      } else if (key === "srcset" || key === "imagesrcset") {
        if (v.split(",").some((part) => isRemote(part.trim().split(/\s+/)[0] ?? "")) && hit()) el.removeAttribute(at.name);
      }
    }
  }
  const meta = doc.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", CSP);
  doc.head.prepend(meta);
  const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) : "";
  return { html: doctype + doc.documentElement.outerHTML, blocked };
}

// Page size, orientation, margins and the screen width the page is laid out
// at (scaled to fit the paper). The page's own @page rules still win: these
// come first.
const PAPER: Record<string, { css: string; w: number; h: number }> = {
  a4: { css: "A4", w: 210, h: 297 }, letter: { css: "letter", w: 215.9, h: 279.4 },
  a3: { css: "A3", w: 297, h: 420 }, a5: { css: "A5", w: 148, h: 210 },
};
const MARGINS: Record<string, number> = { none: 0, small: 12, large: 25 };

export function htmlPage(html: string, o: { pageSize?: string; orientation?: string; margin?: string; screenWidth?: string }) {
  const paper = PAPER[o.pageSize ?? ""] ?? PAPER.a4;
  const landscape = o.orientation === "landscape";
  const margin = MARGINS[o.margin ?? ""] ?? MARGINS.small;
  let css = `@page { size: ${paper.css} ${landscape ? "landscape" : "portrait"}; margin: ${margin ? `${margin}mm` : "0"}; }`;
  const screen = Number(o.screenWidth);
  if (screen > 0) {
    const printable = (((landscape ? paper.h : paper.w) - 2 * margin) / 25.4) * 96;
    css += ` @media print { html { width: ${screen}px; zoom: ${(printable / screen).toFixed(4)}; } }`;
  }
  return intoHead(html, `<style>${css}</style>`);
}

// Inside <head> when there is one, so the doctype stays first.
export function intoHead(html: string, snippet: string) {
  const head = html.match(/<head(?:\s[^>]*)?>/i) ?? html.match(/<html(?:\s[^>]*)?>/i);
  if (!head || head.index === undefined) return snippet + html;
  const at = head.index + head[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}
