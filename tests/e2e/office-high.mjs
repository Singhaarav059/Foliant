// Word → PDF with Fidelity set to High (LibreOffice in the browser), the way a
// returning visitor runs it: the service worker is installed, the page is
// reloaded under it, High is chosen by name, and brief.docx comes back as a
// PDF that LibreOffice wrote. Chromium only (LibreOffice needs about 1 GB).
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/office-high.mjs chromium
//
// BASE_URL and CHROME_PATH work as in tests/e2e.mjs.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const downloads = mkdtempSync(join(tmpdir(), "e2e-office-high-"));
const label = (key) => t[key].split(":")[0];

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await test("High fidelity: brief.docx becomes a PDF written by LibreOffice", async () => {
      await open(page, "/en/word-to-pdf");
      await page.evaluate(() => navigator.serviceWorker.ready);
      await open(page, "/en/word-to-pdf", { waitUntil: "load" });
      if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) throw new Error("not controlled by the service worker after reload");
      if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error("not cross-origin isolated");
      await pick(page, ["brief.docx"]);
      await page.getByRole("radio", { name: new RegExp(`^${label("choice.fidelity.high")}`) }).click();
      const consent = page.getByRole("button", { name: t["ws.officeConsentYes"], exact: true });
      const [dl] = await Promise.all([
        page.waitForEvent("download", { timeout: 300000 }),
        (async () => {
          await page.getByRole("button", { name: t["tool.wordToPdf.action"], exact: true }).first().click();
          await consent.click({ timeout: 15000 }).catch(() => {}); // asked only once per browser
        })(),
      ]);
      const path = join(downloads, dl.suggestedFilename());
      await dl.saveAs(path);
      if (!path.endsWith(".pdf")) throw new Error(`downloaded ${dl.suggestedFilename()}`);
      const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join(" ");
      const producer = String((await pdf.getMetadata()).info?.Producer ?? "");
      if (!text.includes("Project brief")) throw new Error(`text was ${JSON.stringify(text.slice(0, 80))}`);
      if (!/LibreOffice/.test(producer)) throw new Error(`written by ${producer || "?"}`);
      return `${pdf.numPages} page(s), written by ${producer}`;
    });
  } finally {
    await ctx.close();
  }
});
