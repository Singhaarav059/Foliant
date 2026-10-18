// The OCR language picker in the static build: every language is listed by
// name, English and Hindi picked together read a page that mixes them, only
// the picked languages' models are downloaded, and the choice is remembered.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/ocr-langs.mjs [chromium] [firefox] [webkit]
import { readFileSync } from "node:fs";
import { suite, open, pick, base } from "./kit.mjs";

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const models = [];
  page.on("request", (r) => {
    const m = /\/tessdata\/([\w]+)\.traineddata\.gz$/.exec(r.url());
    if (m) models.push(m[1]);
  });
  const list = () => page.getByRole("group", { name: "Document language" });

  await test("every language is listed by name", async () => {
    await open(page, "/en/ocr-pdf");
    await pick(page, ["mixed-script.pdf"]);
    const names = await list().getByRole("checkbox").evaluateAll((els) => els.map((e) => e.closest("label").textContent.trim()));
    if (names.length < 100) throw new Error(`${names.length} languages`);
    const raw = names.filter((n) => /^[a-z_]+$/.test(n));
    if (raw.length) throw new Error(`codes shown as names: ${raw.slice(0, 5).join(", ")}`);
    return `${names.length} languages`;
  });

  await test("search finds Hindi by its name in either language", async () => {
    await page.getByPlaceholder("Search languages").fill("हिन्दी");
    const hits = await list().getByRole("checkbox").count();
    await page.getByPlaceholder("Search languages").fill("hindi");
    if (hits !== 1 || (await list().getByRole("checkbox").count()) !== 1) throw new Error(`${hits} matches`);
    return "1 match each way";
  });

  await test("English and Hindi read a page that mixes them", async () => {
    await list().getByRole("checkbox", { name: /Hindi/ }).check();
    await page.getByPlaceholder("Search languages").fill("");
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 240000 }), page.getByRole("button", { name: "Run OCR", exact: true }).click()]);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(await dl.path())) }).promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join(" ").replace(/\s+/g, " ");
    if (!/ration card/.test(text) || !/राशन/.test(text)) throw new Error(`text was "${text.slice(0, 80)}"`);
    const fetched = [...new Set(models)].sort().join();
    if (fetched !== "eng,hin") throw new Error(`models downloaded: ${fetched}`);
    return `models: ${fetched}`;
  });

  await test("the choice is remembered, up to three languages", async () => {
    await open(page, "/en/ocr-pdf");
    await pick(page, ["mixed-script.pdf"]);
    const checked = () => list().getByRole("checkbox", { checked: true }).evaluateAll((els) => els.map((e) => e.closest("label").textContent.trim()));
    // Restored just after the picker first shows.
    await list().getByRole("checkbox", { name: /^Hindi/, checked: true }).waitFor({ timeout: 5000 }).catch(() => {});
    const kept = await checked();
    if (!kept.some((n) => n.startsWith("Hindi")) || !kept.some((n) => n.startsWith("English"))) throw new Error(`picked after reload: ${kept.join(", ")}`);
    await list().getByRole("checkbox", { name: /^Marathi/ }).check();
    const disabled = await list().getByRole("checkbox", { name: /^Bangla|^Bengali/ }).isDisabled();
    if (!disabled) throw new Error("a fourth language could be picked");
    await page.getByRole("button", { name: /Remove Marathi/ }).click();
    return (await checked()).join(" + ");
  });

  await test("fits a phone screen", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await open(page, "/en/ocr-pdf");
    await pick(page, ["mixed-script.pdf"]);
    await list().waitFor();
    const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (over > 0) throw new Error(`${over}px overflow`);
    return "no overflow";
  });

  await ctx.close();
  return base;
});
