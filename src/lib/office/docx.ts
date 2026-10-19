// Word → printable HTML in the browser with docx-preview (Apache-2.0), which
// keeps far more of the document than mammoth: page size and margins per
// section, headers and footers, columns, numbering, table styles, embedded
// fonts, and Word's own page breaks (the lastRenderedPageBreak marks Word
// saves). Needs a DOM, so the server keeps using mammoth (html.ts).

// docx-preview needs three fixes to the XML before it renders:
//  1. It starts a printed page only at page breaks, so a "next page" section
//     break (Word's default) would run on into the same page and keep the old
//     page size. Those become explicit page breaks.
//  2. A section without its own header or footer inherits the previous
//     section's in Word; docx-preview leaves it blank. References are copied forward.
//  3. It drops page-number fields. PAGE and NUMPAGES become markers that are
//     filled in per page after rendering.
const PAGE = "\u2063PAGE\u2063";
const PAGES = "\u2063NUMPAGES\u2063";

const token = (instr: string) => (/^\s*PAGE\b/i.test(instr) ? PAGE : /^\s*(NUMPAGES|SECTIONPAGES)\b/i.test(instr) ? PAGES : null);

function pageFields(xml: string) {
  // Complex fields: begin … instrText … separate … result … end, possibly across runs.
  xml = xml.replace(/<w:fldChar\b[^>]*w:fldCharType="begin"[^>]*\/>((?:(?!w:fldCharType="begin")[\s\S])*?)<w:fldChar\b[^>]*w:fldCharType="end"[^>]*\/>/g, (all, inner: string) => {
    const instr = [...inner.matchAll(/<w:instrText\b[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => m[1]).join("");
    const t = token(instr);
    return t ? `<w:t xml:space="preserve">${t}</w:t>` : all;
  });
  // Simple fields.
  return xml.replace(/<w:fldSimple\b[^>]*w:instr="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/w:fldSimple>)/g, (all, instr: string) => {
    const t = token(instr);
    return t ? `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>` : all;
  });
}

function inheritHeaders(xml: string) {
  const last: Record<string, string> = {};
  return xml.replace(/<w:sectPr\b([^>]*)>([\s\S]*?)<\/w:sectPr>/g, (all, attrs: string, inner: string) => {
    const own: Record<string, string> = {};
    for (const m of inner.matchAll(/<w:(header|footer)Reference\b[^>]*w:type="(\w+)"[^>]*\/>/g)) own[`${m[1]}:${m[2]}`] = m[0];
    const missing = Object.keys(last).filter((k) => !own[k]).map((k) => last[k]);
    Object.assign(last, own);
    return missing.length ? `<w:sectPr${attrs}>${missing.join("")}${inner}</w:sectPr>` : all;
  });
}

function breakSections(xml: string) {
  // A section that ends inside a paragraph's properties is followed by the next section's first paragraph.
  return xml.replace(/(<w:sectPr\b(?:(?!<\/w:sectPr>)[\s\S])*<\/w:sectPr>\s*<\/w:pPr>[\s\S]*?<\/w:p>)(\s*<w:p\b[^>]*?)(\/?>)/g, (all, end: string, open: string, close: string) => {
    if (/<w:type\s+w:val="continuous"/.test(end)) return all;
    // An empty paragraph (<w:p/>) needs opening up to hold the break.
    return close === "/>" ? `${end}${open}><w:r><w:br w:type="page"/></w:r></w:p>` : `${end}${open}><w:r><w:br w:type="page"/></w:r>`;
  });
}

async function prepare(data: Uint8Array): Promise<Uint8Array> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(data);
  let changed = false;
  for (const name of Object.keys(zip.files)) {
    const isBody = name === "word/document.xml";
    if (!isBody && !/^word\/(header|footer)\d*\.xml$/.test(name)) continue;
    const xml = await zip.file(name)!.async("string");
    let fixed = pageFields(xml);
    if (isBody) fixed = breakSections(inheritHeaders(fixed));
    if (fixed !== xml) {
      zip.file(name, fixed);
      changed = true;
    }
  }
  return changed ? zip.generateAsync({ type: "uint8array" }) : data;
}

// docx-preview doesn't paginate: a page holds everything up to the next break,
// however long. Move trailing blocks onto copies of the page (same header,
// footer and columns) until every page fits its height. A single block taller
// than a page stays put; the browser splits it when printing.
async function paginate(root: HTMLElement) {
  await document.fonts.ready;
  const px = (v: string) => (v.endsWith("pt") ? (parseFloat(v) * 96) / 72 : v.endsWith("mm") ? (parseFloat(v) * 96) / 25.4 : parseFloat(v));
  const queue = [...root.querySelectorAll<HTMLElement>(":scope > section.docx")];
  for (let guard = 0; queue.length && guard < 2000; guard++) {
    const page = queue.shift()!;
    const limit = px(page.style.minHeight || page.style.height) + 1;
    if (!limit || page.getBoundingClientRect().height <= limit) continue;
    const articles = [...page.querySelectorAll<HTMLElement>(":scope > article")];
    const blocks = () => articles.reduce((n, a) => n + a.children.length, 0);
    if (blocks() < 2) continue;
    // The next page: same section box, header and footer, empty articles.
    const next = page.cloneNode(false) as HTMLElement;
    for (const child of page.children) {
      const tag = child.tagName.toLowerCase();
      next.append(tag === "article" ? child.cloneNode(false) : child.cloneNode(true));
    }
    const nextArticles = [...next.querySelectorAll<HTMLElement>(":scope > article")];
    page.after(next);
    while (page.getBoundingClientRect().height > limit && blocks() > 1) {
      const k = articles.findLastIndex((a) => a.lastElementChild);
      nextArticles[k].prepend(articles[k].lastElementChild!);
    }
    // Articles left empty on either page would still take up space.
    for (const a of [...articles, ...nextArticles]) if (!a.children.length) a.remove();
    queue.unshift(next);
  }
}

// Renders the document off screen in this document and hands the laid-out
// pages (one section.docx per printed page) to `withPages`. `faces`: @font-face
// rules for fonts the document names (faces.ts).
export async function renderDocx<T>(input: Uint8Array, withPages: (body: HTMLElement, sections: HTMLElement[], styles: HTMLElement) => Promise<T>, faces = ""): Promise<T> {
  const { renderAsync } = await import("docx-preview");
  const data = await prepare(input);
  const body = document.createElement("div");
  const styles = document.createElement("div");
  // Nothing inherited from this site's styles: text without a font of its own
  // gets Word's defaults (BASE), here and in the printed page.
  body.style.cssText = `all:initial;display:block;position:fixed;left:-100000px;top:0;${BASE}`;
  // The styles have to be live too, or pages measure wrong while paginating.
  document.body.append(styles, body);
  try {
    await renderAsync(data, body, styles, {
      className: "docx",
      inWrapper: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      experimental: true, // tab stops
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      renderChanges: false,
    });
    // Office fonts most devices lack (Calibri, Cambria…) lay out in their
    // metric-compatible stand-ins, so lines and pages break as in Word.
    // First, so fonts embedded in the document still win.
    const fonts = document.createElement("style");
    fonts.textContent = faces;
    styles.prepend(fonts);
    void body.offsetHeight; // lay out, so the fonts it uses start loading

    await paginate(body);

    // Page numbers: after pagination each section is one printed page.
    const sections = [...body.querySelectorAll<HTMLElement>(":scope > section.docx")];
    sections.forEach((section, i) => {
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n.nodeValue?.includes("\u2063")) n.nodeValue = n.nodeValue.split(PAGE).join(String(i + 1)).split(PAGES).join(String(sections.length));
    });
    return await withPages(body, sections, styles);
  } finally {
    body.remove();
    styles.remove();
  }
}

// What Word uses when a document names no font or size.
const BASE = 'font-family:"Times New Roman";font-size:10pt;color:#000;';

export async function docxPreviewHtml(input: Uint8Array, faces = ""): Promise<string> {
  // Serialised: images and fonts are inlined as data URLs so the HTML stands
  // on its own in the print frame.
  return renderDocx(input, async (body, _sections, styles) => {
    // One named @page per page size, so landscape sections print landscape.
    const sizes = new Map<string, string>();
    for (const section of body.querySelectorAll<HTMLElement>("section.docx")) {
      const size = `${section.style.width || "210mm"} ${section.style.minHeight || section.style.height || "297mm"}`;
      if (!sizes.has(size)) sizes.set(size, `p${sizes.size}`);
      section.style.setProperty("page", sizes.get(size)!);
    }
    const pages = [...sizes].map(([size, name]) => `@page ${name} { size: ${size}; margin: 0; }`).join("\n");
    return `<!doctype html><html><head><meta charset="utf-8">${styles.innerHTML}<style>
      ${pages}
      @page { margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; ${BASE} }
      /* Each section is one or more printed pages; drop the on-screen page look. */
      section.docx { margin: 0 !important; box-shadow: none !important; break-after: page; }
      section.docx:last-of-type { break-after: auto; }
      * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    </style></head><body>${body.innerHTML}</body></html>`;
  }, faces);
}
