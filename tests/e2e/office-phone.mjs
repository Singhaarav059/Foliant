// Office → PDF on a phone (static build): Standard writes a real PDF file in
// the browser, with no print dialog and no LibreOffice download. The text can
// be extracted, and Word's page count stays within one of LibreOffice's.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/office-phone.mjs [chromium] [firefox] [webkit]
import pw from "playwright-core";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { suite, open, pick } from "./kit.mjs";

const downloads = mkdtempSync(join(tmpdir(), "e2e-office-phone-"));
// Page counts LibreOffice writes for the fixtures (its WASM build, as in tests/libreoffice.mjs).
const LIBREOFFICE_PAGES = { "brief.docx": 1, "rich.docx": 4 };

async function pdfPages(path) {
  const bytes = new Uint8Array(readFileSync(path));
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
  const doc = await getDocument({ data: bytes, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((t) => t.str).join(" ").replace(/\s+/g, " "));
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

  await ctx.close();
});
