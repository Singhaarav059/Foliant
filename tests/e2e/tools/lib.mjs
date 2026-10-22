// Helpers for the per-tool smoke specs in this folder (see run.mjs).
//
// Every selector here avoids translated text, so the same steps run in every
// language: options are found by the id suffix Options.tsx gives them
// (`…-<key>`), buttons by their lucide icon class, and the workspace by its
// layout (main > aside.card holds the options and the action button).
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import JSZip from "jszip";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { root, fixtures } from "../kit.mjs";

// The workspace helpers one spec gets. `fx` resolves a fixture name: the
// checked-in ones in tests/fixtures, or the ones makeFixtures() writes.
export const helpers = (page, fx) => ({
  page,
  fx,
  pick: (files, nth = 0) => page.locator("input[type=file]").nth(nth).setInputFiles(files.map(fx)),
  action: () => page.locator("main aside.card button.btn-primary").first(),
  toggle: (key) => page.locator(`main label[for$="-${key}"]`).first().click(),
  radio: (key, i) => page.locator(`main label[for$="-${key}"] + [role=radiogroup] [role=radio]`).nth(i).click(),
  select: (key, v) => page.locator(`main select[id$="-${key}"]`).first().selectOption(v),
  fill: (key, v) => page.locator(`main input[id$="-${key}"]`).first().fill(v),
  icon: (name, scope = "main") => page.locator(`${scope} button:has(svg.lucide-${name})`).first(),
  stage: () => page.locator("main div.touch-none.select-none.bg-white").first(),
  async drag(x0, y0, x1, y1) {
    const box = await this.stage().boundingBox();
    await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(box.x + box.width * (x0 + ((x1 - x0) * k) / 8), box.y + box.height * (y0 + ((y1 - y0) * k) / 8));
    await page.mouse.up();
  },
  async clickStage(x, y) {
    const box = await this.stage().boundingBox();
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  },
  // Page thumbnails (pages mode), drawn; in Extract and Remove each has a select button with aria-pressed.
  waitPages: (n) => page.waitForFunction((n) => {
    const imgs = [...document.querySelectorAll("main ul li img")];
    return imgs.length >= n && imgs.every((i) => i.naturalWidth > 0);
  }, n, { timeout: 30000 }),
  thumb: (i) => page.locator("main ul li button[aria-pressed]").nth(i),
  waitStage: () => page.waitForFunction(() => !!document.querySelector("main div.touch-none img"), null, { timeout: 30000 }),
});

// Waits until the workspace shows an error, a result, or a print preview.
export async function outcome(page, timeout) {
  const h = await page.waitForFunction(() => {
    const alert = document.querySelector("main div[role=alert]");
    if (alert) return { kind: "error", text: alert.textContent.trim().slice(0, 300) };
    const restart = [...document.querySelectorAll("main button")].find((b) => b.querySelector("svg.lucide-refresh-cw"));
    if (!restart) return null;
    const iframe = document.querySelector("main iframe[sandbox]");
    const zip = [...document.querySelectorAll("main button.btn-primary")].find((b) => b.querySelector("svg.lucide-file-archive"));
    return { kind: iframe ? "print" : zip ? "multi" : "single" };
  }, null, { timeout, polling: 200 });
  return h.jsonValue();
}

let pdfjs;
// Each page's text, as pdf.js reads it.
export async function pageTexts(bytes) {
  pdfjs ??= await import(pathToFileURL(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(" ").replace(/\s+/g, " ").trim());
  await doc.cleanup();
  return out;
}
export const pdfText = async (bytes) => (await pageTexts(bytes)).join(" ");

const xmlText = (xml) => xml.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

// Reads a downloaded file and describes it: type, page count, text, and what
// the specs check for each format. Throws when the bytes aren't the format
// the name says.
export async function inspect(path) {
  const b = readFileSync(path);
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "pdf") {
    if (b.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF header");
    let doc;
    try {
      doc = await PDFDocument.load(b);
    } catch (e) {
      if (/encrypt/i.test(e.message)) return { type: "pdf", encrypted: true, bytes: b.length };
      throw new Error("pdf-lib: " + e.message.slice(0, 120));
    }
    const pages = doc.getPages();
    const pageText = await pageTexts(b);
    return {
      text: pageText.join(" "),
      type: "pdf",
      bytes: b.length,
      encrypted: false,
      pages: pages.length,
      rot: pages.map((p) => p.getRotation().angle),
      size: pages.map((p) => { const s = p.getSize(); return [Math.round(s.width), Math.round(s.height)]; }),
      crop: pages.map((p) => { const c = p.getCropBox(); return [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)]; }),
      fields: (() => { try { return doc.getForm().getFields().map((f) => f.getName()); } catch { return []; } })(),
      // Field values: a text field's text, a checkbox's state.
      values: (() => {
        const out = {};
        try {
          for (const f of doc.getForm().getFields()) out[f.getName()] = f.getText?.() ?? f.isChecked?.() ?? f.getSelected?.();
        } catch { /* no form */ }
        return out;
      })(),
      // Images and forms drawn on each page (signatures, stamps, scans).
      xobjects: pages.map((p) => p.node.Resources()?.lookup(PDFName.of("XObject"))?.keys().length ?? 0),
      outline: !!doc.catalog.get(PDFName.of("Outlines")),
      pdfa: /pdfaid:part/.test(b.toString("latin1")),
      pageText,
    };
  }
  if (["zip", "docx", "pptx", "xlsx"].includes(ext)) {
    if (b[0] !== 0x50 || b[1] !== 0x4b) throw new Error("not a ZIP container");
    const z = await JSZip.loadAsync(b);
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
    const read = async (re) => (await Promise.all(names.filter((n) => re.test(n)).sort().map((n) => z.file(n).async("string")))).join(" ");
    const info = { type: ext, bytes: b.length, names };
    if (ext === "zip") {
      info.entries = [];
      for (const n of names) {
        const ib = await z.file(n).async("nodebuffer");
        const ie = n.split(".").pop().toLowerCase();
        const e = { name: n, ext: ie, bytes: ib.length };
        if (ie === "pdf") {
          const d = await PDFDocument.load(ib);
          e.pages = d.getPageCount();
          e.crop = d.getPages().map((p) => { const c = p.getCropBox(); return [c.x, c.y, c.width, c.height].map(Math.round); });
          e.text = await pdfText(ib);
        }
        if (ie === "jpg" && !(ib[0] === 0xff && ib[1] === 0xd8)) throw new Error(`${n} is not a JPEG`);
        if (ie === "png" && ib.subarray(1, 4).toString("latin1") !== "PNG") throw new Error(`${n} is not a PNG`);
        if (ie === "webp" && ib.subarray(8, 12).toString("latin1") !== "WEBP") throw new Error(`${n} is not a WebP`);
        info.entries.push(e);
      }
    } else if (ext === "docx") {
      if (!z.file("word/document.xml")) throw new Error("missing word/document.xml");
      info.xml = await z.file("word/document.xml").async("string");
      info.text = xmlText(info.xml);
    } else if (ext === "xlsx") {
      if (!z.file("xl/workbook.xml")) throw new Error("missing xl/workbook.xml");
      info.sheets = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length;
      info.text = xmlText(await read(/^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/));
    } else {
      if (!z.file("ppt/presentation.xml")) throw new Error("missing ppt/presentation.xml");
      info.slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
      info.text = xmlText(await read(/^ppt\/slides\/slide\d+\.xml$/));
    }
    return info;
  }
  if (ext === "md" || ext === "txt") return { type: ext, bytes: b.length, text: b.toString("utf8") };
  return { type: ext, bytes: b.length };
}

// Fixtures the checked-in set lacks, written fresh for each run: a photo and
// a transparent logo (drawn in the browser under test), a fillable form, a
// truncated PDF, and an HTML page with a script that must not run.
export async function makeFixtures(browser, dir) {
  mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 1600 } });
  const p = await ctx.newPage();
  await p.setContent(`<body style="margin:0;background:#fff;font:28px Georgia"><div style="padding:80px"><h1>Receipt 7731</h1><p>Paid to Acme Corp on 2026-10-01. Total due 412.50 USD.</p><div style="width:400px;height:300px;background:linear-gradient(45deg,#e66,#36c)"></div><p>Signed and approved by the finance team.</p></div></body>`);
  writeFileSync(join(dir, "photo.jpg"), await p.screenshot({ type: "jpeg", quality: 85 }));
  await p.setViewportSize({ width: 600, height: 400 });
  await p.setContent(`<body style="margin:0;background:transparent"><div style="width:600px;height:400px;display:grid;place-items:center;font:bold 80px sans-serif;color:#2a6">LOGO</div></body>`);
  writeFileSync(join(dir, "logo.png"), await p.screenshot({ type: "png", omitBackground: true }));
  await ctx.close();

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Application form", { x: 50, y: 780, size: 22, font });
  page.drawText("Full name:", { x: 50, y: 720, size: 12, font });
  const form = doc.getForm();
  form.createTextField("fullName").addToPage(page, { x: 130, y: 710, width: 250, height: 24 });
  page.drawText("I agree:", { x: 50, y: 670, size: 12, font });
  form.createCheckBox("agree").addToPage(page, { x: 130, y: 665, width: 18, height: 18 });
  const dd = form.createDropdown("country");
  dd.addOptions(["India", "Kenya", "Peru"]);
  dd.addToPage(page, { x: 130, y: 620, width: 150, height: 22 });
  writeFileSync(join(dir, "form.pdf"), await doc.save());

  const report = readFileSync(join(fixtures, "report.pdf"));
  writeFileSync(join(dir, "truncated.pdf"), report.subarray(0, Math.floor(report.length * 0.6)));
  writeFileSync(join(dir, "page.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Test page</title></head><body><h1>Hello HTML fixture</h1><p>Paragraph with <b>bold</b> text.</p><table border=1><tr><td>A</td><td>B</td></tr></table><script>document.body.insertAdjacentHTML('beforeend','<p id=ran>SCRIPT RAN</p>')</script></body></html>`);
}

// Throws `msg` unless `cond` holds; specs use it in their checks.
export function must(cond, msg) {
  if (!cond) throw new Error(msg);
}
