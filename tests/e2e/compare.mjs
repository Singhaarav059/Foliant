// Compare in the browser: a file that can't be read is named in an alert,
// never shown as "0 changes", and an inserted page is one change in every
// view.
//
//   node tests/e2e/compare.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const fill = (key, vars) => t[key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
const dir = mkdtempSync(join(tmpdir(), "compare-"));

async function pdf(name, pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) doc.addPage([420, 300]).drawText(text, { x: 20, y: 250, size: 12, font, maxWidth: 380, lineHeight: 16 });
  const path = join(dir, name);
  writeFileSync(path, await doc.save());
  return path;
}
const PAGES = [
  "Introduction to the quarterly report covering revenue growth across all regions",
  "Operating costs fell by eight percent as hosting contracts were renegotiated",
  "Hiring plans for next year include four engineers and two designers",
];
const original = await pdf("original.pdf", PAGES);
const oneWord = await pdf("one-word.pdf", [PAGES[0], PAGES[1].replace("eight", "nine"), PAGES[2]]);
const inserted = await pdf("inserted.pdf", ["Cover letter from the finance team summarising this edition", ...PAGES]);

// Pages with no text at all, like scans or drawings, that differ.
async function shapes(name, x) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([420, 300]).drawRectangle({ x: x + i * 10, y: 50, width: 150, height: 100, color: rgb(0, 0, 0) });
  const path = join(dir, name);
  writeFileSync(path, await doc.save());
  return path;
}
const drawingA = await shapes("drawing-a.pdf", 20);
const drawingB = await shapes("drawing-b.pdf", 220);

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const main = () => page.locator("main").innerText();

  for (const [file, key, fix] of [["locked-report.pdf", "err.encrypted", "tool.unlock.name"], ["text-file.pdf", "err.notPdf", null]]) {
    await test(`${file} + report.pdf: an alert names it`, async () => {
      await open(page, "/en/compare-pdf");
      await pick(page, [file, "report.pdf"]);
      const alert = page.getByRole("alert").filter({ hasText: t[key] });
      await alert.waitFor({ timeout: 15000 });
      if (!(await alert.innerText()).includes(file)) throw new Error("file not named");
      if (fix && !(await alert.getByRole("link", { name: t[fix] }).count())) throw new Error("no fix link");
      await page.waitForTimeout(500);
      const text = await main();
      if (text.includes(fill("cmp.changes", { n: 0 })) || text.includes(t["cmp.noChanges"])) throw new Error("shows no changes");
      return "alert, no '0 changes'";
    });
  }

  await test("files without text don't claim 0 changes", async () => {
    await open(page, "/en/compare-pdf");
    await pick(page, [drawingA, drawingB]);
    // Whichever the text view settles on.
    await page.getByText(t["cmp.noChanges"]).or(page.getByText(t["cmp.noText"] ?? "\u0000")).first().waitFor({ timeout: 15000 });
    const text = await main();
    if (text.includes(fill("cmp.changes", { n: 0 })) || text.includes(t["cmp.noChanges"])) throw new Error("shows no changes");
    if (!text.includes(t["cmp.noText"])) throw new Error("doesn't say there's no text");
    if ((await page.getByRole("link", { name: t["tool.ocr.name"] }).getAttribute("href")) !== "/en/ocr-pdf") throw new Error("no OCR link");
    return "says there's no text to compare";
  });

  await test("an inserted page is one change", async () => {
    await open(page, "/en/compare-pdf");
    await pick(page, [original, inserted]);
    await page.getByText(fill("cmp.changes", { n: 1 })).waitFor({ timeout: 15000 });
    const heading = fill("cmp.pageAdded", { n: 1 });
    await page.getByRole("heading", { name: new RegExp(`^${heading}`) }).waitFor({ timeout: 5000 });
    if ((await page.locator("main article").count()) !== 1) throw new Error(`${await page.locator("main article").count()} pages listed`);
    return heading;
  });

  await test("visual overlay and side by side follow the alignment", async () => {
    await page.getByRole("tab", { name: t["cmp.visual"] }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("data:image/png") && i.naturalWidth > 0), null, { timeout: 15000 });
    await page.getByText(fill("cmp.pageAdded", { n: 1 })).first().waitFor({ timeout: 5000 });
    await page.getByRole("tab", { name: t["cmp.side"] }).click();
    await page.getByText(t["cmp.noPage"]).waitFor({ timeout: 5000 });
    // Row 2: the original's first page beside the revised file's second.
    await page.getByRole("button", { name: t["ed.nextPage"] }).click();
    const captions = await page.locator("main figcaption").allInnerTexts();
    if (!captions[0].includes(fill("ws.page", { n: 1 })) || !captions[1].includes(fill("ws.page", { n: 2 }))) throw new Error(captions.join(" | "));
    return captions.map((c) => c.split("·").at(-1).trim()).join(" ↔ ");
  });

  // The differences as files: the revised PDF with one highlight over the
  // changed word, and a report with one change.
  await test("one word changed: an annotated PDF and a report to download", async () => {
    await open(page, "/en/compare-pdf");
    await pick(page, [original, oneWord]);
    await page.getByText(fill("cmp.changes", { n: 1 })).waitFor({ timeout: 15000 });
    const download = async (name) => {
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: t[name], exact: true }).click()]);
      const path = join(dir, `${name}-${dl.suggestedFilename()}`);
      await dl.saveAs(path);
      return { path, name: dl.suggestedFilename() };
    };
    const copy = await download("cmp.exportPdf");
    const doc = await PDFDocument.load(readFileSync(copy.path));
    const subtypes = doc.getPages().flatMap((p) => (p.node.Annots()?.asArray() ?? []).map((r) => doc.context.lookup(r).get(PDFName.of("Subtype")).toString()));
    if (copy.name !== "one-word-changes.pdf") throw new Error(`named ${copy.name}`);
    if (subtypes.join() !== "/Highlight") throw new Error(`annotations: ${subtypes.join() || "none"}`);
    const report = await download("cmp.exportReport");
    const html = readFileSync(report.path, "utf8");
    const sections = (html.match(/<section data-change/g) ?? []).length;
    if (sections !== 1 || !html.includes("<del>eight</del>") || !html.includes("<ins>nine</ins>")) throw new Error(`report: ${sections} changes`);
    return `${copy.name}: 1 highlight; ${report.name}: 1 change`;
  });

  await ctx.close();
});
