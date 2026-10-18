// Office → PDF on a phone (static build): Standard writes a real PDF file in
// the browser, with no print dialog and no LibreOffice download. The text can
// be extracted, and Word's page count stays within one of LibreOffice's.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/office-phone.mjs [chromium] [firefox] [webkit]
import pw from "playwright-core";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { suite, open, pick, fixture } from "./kit.mjs";

const downloads = mkdtempSync(join(tmpdir(), "e2e-office-phone-"));
// Page counts LibreOffice writes for the fixtures (its WASM build, as in tests/libreoffice.mjs).
const LIBREOFFICE_PAGES = { "brief.docx": 1, "rich.docx": 4 };

// brief.docx with `runs` (WordprocessingML <w:r> elements) as a paragraph after the heading.
function briefWith(name, runs, links = {}) {
  const files = unzipSync(new Uint8Array(readFileSync(fixture("brief.docx"))));
  const rels = strFromU8(files["word/_rels/document.xml.rels"]);
  const added = Object.entries(links).map(([id, url]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${url}" TargetMode="External"/>`).join("");
  files["word/_rels/document.xml.rels"] = strToU8(rels.replace("</Relationships>", `${added}</Relationships>`));
  const xml = strFromU8(files["word/document.xml"]);
  const at = xml.indexOf("</w:p>") + "</w:p>".length;
  files["word/document.xml"] = strToU8(xml.slice(0, at) + `<w:p>${runs}</w:p>` + xml.slice(at));
  const out = join(downloads, name);
  writeFileSync(out, zipSync(files));
  return out;
}
const run = (text, { font, italic } = {}) =>
  `<w:r><w:rPr>${font ? `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` : ""}${italic ? "<w:i/>" : ""}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;

// The BaseFont of every font the pages use.
async function pdfFonts(path) {
  const doc = await PDFDocument.load(readFileSync(path));
  const names = new Set();
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    for (const ref of fonts?.values() ?? []) {
      const base = doc.context.lookup(ref, PDFDict).get(PDFName.of("BaseFont"));
      if (base) names.add(String(base));
    }
  }
  return [...names];
}

async function pdfPages(path, between = " ") {
  const bytes = new Uint8Array(readFileSync(path));
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
  const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(between).replace(/\s+/g, " "));
  return pages;
}

await suite(async ({ name, browser, test }) => {
  // Firefox can't emulate isMobile; a phone's user agent and screen are enough for the route.
  const { isMobile, ...firefoxSafe } = pw.devices["Pixel 7"];
  const ctx = await browser.newContext({ ...(name === "firefox" ? firefoxSafe : { ...firefoxSafe, isMobile }), acceptDownloads: true, locale: "en-US" });
  const page = await ctx.newPage();
  let printed = 0;
  await page.exposeFunction("__printCalled", () => printed++);
  await page.addInitScript(() => {
    window.print = () => window.__printCalled();
  });

  // Converts one file and returns the downloaded PDF's pages, failing if a print preview shows instead.
  const convert = async (path, file) => {
    await open(page, path);
    await pick(page, [file]);
    const preview = page.getByRole("heading", { name: "Ready to save as PDF" }).waitFor({ timeout: 120000 }).then(() => { throw new Error("a print preview instead of a PDF file"); });
    const alert = page.locator("[role=alert]:not(#__next-route-announcer__)").filter({ hasText: /\S/ }).first();
    const error = alert.waitFor({ timeout: 120000 }).then(async () => { throw new Error(`alert: ${await alert.innerText()}`); });
    preview.catch(() => {});
    error.catch(() => {});
    const [dl] = await Promise.race([
      // A single result downloads by itself, as for every other tool.
      Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.getByRole("button", { name: "Convert to PDF", exact: true }).click()]),
      preview, error,
    ]);
    if (!/\.pdf$/.test(dl.suggestedFilename())) throw new Error(`downloaded ${dl.suggestedFilename()}`);
    const out = join(downloads, `${name}-${dl.suggestedFilename()}`);
    await dl.saveAs(out);
    if (printed) throw new Error("the print dialog was opened");
    return pdfPages(out);
  };

  for (const file of ["brief.docx", "rich.docx"]) {
    await test(`Word → PDF on a phone: ${file}`, async () => {
      const pages = await convert("/en/word-to-pdf", file);
      const text = pages.join("\n");
      const want = file === "brief.docx" ? "Project brief" : "Northwind Quarterly";
      if (!text.includes(want)) throw new Error(`"${want}" not in ${JSON.stringify(text.slice(0, 120))}`);
      const diff = Math.abs(pages.length - LIBREOFFICE_PAGES[file]);
      if (diff > 1) throw new Error(`${pages.length} pages, LibreOffice writes ${LIBREOFFICE_PAGES[file]}`);
      if (file === "rich.docx") {
        // Header on every page and live page numbers, as in the printed version.
        if (!pages.every((p) => p.includes("Northwind Quarterly"))) throw new Error("header missing from a page");
        const numbers = pages.map((p) => (p.match(/Page (\d+) of (\d+)/) ?? []).slice(1).join("/")).join(" ");
        const want = pages.map((_, i) => `${i + 1}/${pages.length}`).join(" ");
        if (numbers !== want) throw new Error(`page numbers ${numbers}, want ${want}`);
        // Word's list numbers are CSS counters in the layout; they have to reach the PDF as text.
        if (!text.includes("1. Collect the figures") || !text.includes("3. Send the report")) throw new Error("numbered list lost its numbers");
      }
      return `${pages.length} pages (LibreOffice ${LIBREOFFICE_PAGES[file]}), "${want}" found`;
    });
  }

  await test("PowerPoint → PDF on a phone", async () => {
    const pages = await convert("/en/powerpoint-to-pdf", "plan.pptx");
    if (!pages.join(" ").trim()) throw new Error("no text");
    return `${pages.length} pages`;
  });

  await test("Excel → PDF on a phone", async () => {
    const pages = await convert("/en/excel-to-pdf", "budget.xlsx");
    if (!pages.join(" ").includes("Hosting")) throw new Error(`"Hosting" not in ${JSON.stringify(pages.join(" ").slice(0, 120))}`);
    return `${pages.length} pages, "Hosting" found`;
  });

  // Offline before the fonts were cached: a PDF with no text is worse than
  // the print dialog, which still has the browser's own fonts.
  await test("Word → PDF with the fonts unavailable: text, or the print preview", async () => {
    const noFonts = await browser.newContext({ ...(name === "firefox" ? firefoxSafe : { ...firefoxSafe, isMobile }), acceptDownloads: true, locale: "en-US", serviceWorkers: "block" });
    try {
      await noFonts.route(/pdfa-fonts\//, (route) => route.abort());
      const page = await noFonts.newPage();
      await page.addInitScript(() => {
        window.print = () => {};
      });
      await open(page, "/en/word-to-pdf");
      await pick(page, ["brief.docx"]);
      const preview = page.getByRole("heading", { name: "Ready to save as PDF" });
      const shown = preview.waitFor({ timeout: 120000 }).then(() => "preview");
      const saved = Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.getByRole("button", { name: "Convert to PDF", exact: true }).click()]).then(([dl]) => dl);
      shown.catch(() => {});
      saved.catch(() => {});
      const outcome = await Promise.race([shown, saved]);
      if (outcome === "preview") return "print preview";
      const out = join(downloads, `${name}-nofonts-${outcome.suggestedFilename()}`);
      await outcome.saveAs(out);
      const text = (await pdfPages(out)).join(" ");
      if (!text.includes("Project brief")) throw new Error(`a PDF without its text: ${JSON.stringify(text.slice(0, 80))}`);
      return "PDF with text";
    } finally {
      await noFonts.close();
    }
  });

  // Polish, Czech, Turkish, Romanian, Vietnamese: the document's own font, not
  // Noto Sans word pieces, and italics stay italic.
  await test("Word → PDF on a phone: accented Latin in the document's font", async () => {
    const file = briefWith("accents.docx", run("Zażółć gęślą jaźń ", { font: "Times New Roman" }) + run("Şişli ăđươ", { font: "Times New Roman", italic: true }));
    await convert("/en/word-to-pdf", file);
    const out = join(downloads, `${name}-accents.pdf`);
    // Each subset is its own embedded font, so a word can be several text
    // items; they sit side by side, and the spaces are in the text.
    const text = (await pdfPages(out, "")).join(" ");
    for (const want of ["Zażółć gęślą jaźń", "Şişli ăđươ"]) if (!text.includes(want)) throw new Error(`"${want}" not in ${JSON.stringify(text.slice(0, 160))}`);
    const fonts = await pdfFonts(out);
    // (Noto's CJK slices draw the list bullets, which no Office stand-in has.)
    if (fonts.some((f) => /NotoSans-/i.test(f))) throw new Error(`fell back to Noto Sans: ${fonts.join(", ")}`);
    if (!fonts.some((f) => /Tinos.*Italic/i.test(f))) throw new Error(`no italic Tinos: ${fonts.join(", ")}`);
    return fonts.join(", ");
  });

  // Word's hyperlinks stay clickable, as they were when the browser printed the PDF.
  await test("Word → PDF on a phone: hyperlinks stay clickable", async () => {
    const link = `<w:hyperlink r:id="rIdDocs"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">Read the docs here</w:t></w:r></w:hyperlink>`;
    const file = briefWith("links.docx", run("See: ") + link, { rIdDocs: "https://example.com/docs?a=1&amp;b=(2)" });
    await convert("/en/word-to-pdf", file);
    const doc = await getDocument({ data: new Uint8Array(readFileSync(join(downloads, `${name}-links.pdf`))), verbosity: 0 }).promise;
    const links = [];
    for (let i = 1; i <= doc.numPages; i++) for (const a of await (await doc.getPage(i)).getAnnotations()) if (a.subtype === "Link") links.push(a.url ?? a.unsafeUrl);
    if (!links.includes("https://example.com/docs?a=1&b=(2)")) throw new Error(`links: ${JSON.stringify(links)}`);
    return `${links.length} link(s)`;
  });

  // Offline before the Noto slices were cached: Hindi (or any script the
  // Office stand-ins don't cover) must not silently drop out of the PDF.
  await test("Word → PDF with the Noto fonts unavailable: Hindi text, or the print preview", async () => {
    const file = briefWith("hindi.docx", run("परियोजना सारांश"));
    const noNoto = await browser.newContext({ ...(name === "firefox" ? firefoxSafe : { ...firefoxSafe, isMobile }), acceptDownloads: true, locale: "en-US", serviceWorkers: "block" });
    try {
      await noNoto.route(/\/vendor\/[^/]+\/fonts\//, (route) => route.abort());
      const page = await noNoto.newPage();
      await page.addInitScript(() => {
        window.print = () => {};
      });
      await open(page, "/en/word-to-pdf");
      await pick(page, [file]);
      const shown = page.getByRole("heading", { name: "Ready to save as PDF" }).waitFor({ timeout: 120000 }).then(() => "preview");
      const saved = Promise.all([page.waitForEvent("download", { timeout: 120000 }), page.getByRole("button", { name: "Convert to PDF", exact: true }).click()]).then(([dl]) => dl);
      shown.catch(() => {});
      saved.catch(() => {});
      const outcome = await Promise.race([shown, saved]);
      if (outcome === "preview") return "print preview";
      const out = join(downloads, `${name}-nonoto-${outcome.suggestedFilename()}`);
      await outcome.saveAs(out);
      const text = (await pdfPages(out)).join(" ");
      if (!/[\u0900-\u097F]/.test(text)) throw new Error(`a PDF without its Hindi text: ${JSON.stringify(text.slice(0, 80))}`);
      return "PDF with Hindi text";
    } finally {
      await noNoto.close();
    }
  });

  await ctx.close();
});
