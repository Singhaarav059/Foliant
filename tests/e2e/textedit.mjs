// Editing a PDF's own text in a real browser (P1-15): the Edit text tool shows
// the page's text objects, one is changed in a font that has the letters
// (kept) and one in a subset that lacks them (falls back to Tinos, which the
// side panel and the result say). Two added rectangles have their layer order
// swapped. The saved file is read back with pdf.js.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3870 &
//   BASE_URL=http://localhost:3870 node tests/e2e/textedit.mjs chromium
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFName, StandardFonts, decodePDFRawStream, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, root, suite } from "./kit.mjs";

const t = dict("en");
const downloads = mkdtempSync(join(tmpdir(), "e2e-textedit-"));
const vendor = join(root, "public/vendor", readdirSync(join(root, "public/vendor")).find((d) => d !== "licenses"));

const reportPdf = join(downloads, "report.pdf");
{
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const tinos = await doc.embedFont(readFileSync(join(vendor, "pdfa-fonts/tinos-latin-400-normal.woff")), { subset: true });
  const p = doc.addPage([612, 792]);
  p.drawRectangle({ x: 60, y: 560, width: 200, height: 30, color: rgb(0.9, 0.9, 0.2) });
  p.drawText("Revenue grew 12%", { x: 72, y: 700, size: 16, font: helv });
  p.drawText("Revenue fell", { x: 72, y: 640, size: 16, font: tinos });
  writeFileSync(reportPdf, await doc.save());
}

const textOf = async (path) => {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  return (await (await pdf.getPage(1)).getTextContent()).items.map((i) => i.str).join("|");
};
const contentOf = async (path) => {
  const doc = await PDFDocument.load(readFileSync(path));
  const c = doc.getPages()[0].node.Contents();
  const refs = c && "asArray" in c ? c.asArray() : [doc.getPages()[0].node.get(PDFName.of("Contents"))];
  return refs.map((r) => Buffer.from(decodePDFRawStream(doc.context.lookup(r)).decode()).toString("latin1")).join("\n");
};

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const panel = () => page.locator("aside");

  // The step under way, named in failures.
  let step = "";
  await test("changed text keeps its font, or falls back and says so; layers reorder", async () => {
   try {
    step = "open";
    await open(page, "/en/edit-pdf");
    await pick(page, [reportPdf]);
    await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), null, { timeout: 30000 });
    await page.getByRole("button", { name: t["ed.editText"], exact: true }).click();

    step = "Helvetica text";
    // Text in Helvetica, which has every letter: kept.
    await page.getByRole("button", { name: `${t["ed.editText"]}: Revenue grew 12%`, exact: true }).click();
    const input = page.getByRole("textbox", { name: t["ed.editText"], exact: true });
    await input.fill("Income grew 12%");
    await input.press("Enter");
    await panel().getByText(t["ed.fontKept"].replace("{font}", "Helvetica")).waitFor();

    step = "Tinos text";
    // Text in a Tinos subset without I, c, o or m: set in the full Tinos instead.
    await page.getByRole("button", { name: `${t["ed.editText"]}: Revenue fell`, exact: true }).click();
    await input.fill("Income fell");
    await input.press("Enter");
    const fallback = panel().getByText(/Tinos instead/);
    await fallback.waitFor();

    step = "rectangles";
    // Two rectangles; the second (blue) is sent under the first (red).
    const img = page.locator("main img").first();
    await img.scrollIntoViewIfNeeded();
    // Mouse events outside the viewport are lost: draw near the top of the page.
    const box = await img.boundingBox();
    const draw = async (color, x, y) => {
      // Nothing selected, so the colour and fill are for the new rectangle.
      // (Escape is ignored while a form control, like the Fill box, has focus.)
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: t["ed.rect"], exact: true }).first().click(); // the toolbar's, not a drawn one
      await panel().getByRole("button", { name: color, exact: true }).click();
      const fill = page.getByRole("checkbox", { name: t["ed.fill"] });
      await fill.uncheck();
      await fill.check();
      await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * (x + 0.2), box.y + box.height * (y + 0.1), { steps: 4 });
      await page.mouse.up();
    };
    await draw(t["color.red"], 0.4, 0.3);
    await draw(t["color.blue"], 0.5, 0.35);
    await panel().getByRole("button", { name: t["ed.sendBackward"] }).click();

    step = "save";
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.getByRole("button", { name: t["tool.edit.action"], exact: true }).locator("visible=true").first().click(),
    ]);
    const saved = join(downloads, `${name}-${dl.suggestedFilename()}`);
    await dl.saveAs(saved);

    const text = await textOf(saved);
    for (const want of ["Income grew 12%", "Income fell"]) if (!text.includes(want)) throw new Error(`no "${want}" in ${text}`);
    if (text.includes("Revenue")) throw new Error(`old text still there: ${text}`);
    const content = await contentOf(saved);
    const blue = content.search(/0\.18\d* 0\.43\d* 0\.92\d* rg/), red = content.search(/0\.82\d* 0\.24\d* 0\.41\d* rg/);
    if (blue < 0 || red < 0 || blue > red) throw new Error(`rectangles not in order blue, red: ${blue}, ${red}`);
    step = "result";
    await page.getByText(/another font/).waitFor();
    return text;
   } catch (e) {
    throw new Error(`${step}: ${e.message}`);
   }
  });
  await ctx.close();
});
