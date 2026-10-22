// Live previews (P2-12) in real browsers: Add watermark, Add page numbers and
// Add header and footer show the first page they draw on with the marks over
// it; the watermark's opacity slider changes the preview within 200 ms, and a
// new position or text is drawn again. (tests/preview.mjs checks that the
// preview's geometry matches the output.)
//
//   node tests/e2e/preview.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { open, pick, suite } from "./kit.mjs";

const ready = (page, timeout = 20000) =>
  page.waitForSelector("[data-preview] img[data-marks=ready]", { timeout });
// The marks layer's pixels: a cheap fingerprint to tell two drawings apart.
const layerSrc = (page) => page.locator("[data-preview] img[data-marks]").getAttribute("src");

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);

  await test("watermark: preview shows; opacity follows the slider within 200 ms", async () => {
    await open(page, "/en/add-watermark");
    await pick(page, ["report.pdf"]);
    await ready(page);
    const slider = page.locator('main input[type=range][id$="-opacity"]').first();
    const ms = await slider.evaluate(async (el) => {
      const img = document.querySelector("[data-preview] img[data-marks]");
      const before = img.style.opacity;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const t0 = performance.now();
      set.call(el, el.value === "20" ? "80" : "20");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      while (img.style.opacity === before) {
        if (performance.now() - t0 > 2000) return -1;
        await new Promise((r) => requestAnimationFrame(r));
      }
      return performance.now() - t0;
    });
    if (ms < 0 || ms > 200) throw new Error(`opacity took ${ms < 0 ? "over 2000" : Math.round(ms)} ms`);
    return `${Math.round(ms)} ms`;
  });

  await test("watermark: new text is drawn again", async () => {
    const before = await layerSrc(page);
    await page.locator('main input[id$="-markText"]').first().fill("SECRET COPY");
    await page.waitForFunction((b) => {
      const img = document.querySelector("[data-preview] img[data-marks=ready]");
      return img && img.getAttribute("src") !== b;
    }, before, { timeout: 10000 });
  });

  await test("page numbers: preview shows, and moves with the position", async () => {
    await open(page, "/en/add-page-numbers");
    await pick(page, ["report.pdf"]);
    await ready(page);
    const before = await layerSrc(page);
    await page.locator('main [role=radiogroup] [role=radio]').first().click();
    await page.waitForFunction((b) => {
      const img = document.querySelector("[data-preview] img[data-marks=ready]");
      return img && img.getAttribute("src") !== b;
    }, before, { timeout: 10000 });
  });

  await test("header and footer: preview starts after the skipped pages", async () => {
    await open(page, "/en/add-header-footer");
    await pick(page, ["report.pdf"]);
    await ready(page);
    await page.locator('main input[id$="-hfSkipFirst"]').first().fill("1");
    await page.waitForSelector("[data-preview][data-page='1'] img[data-marks=ready]", { timeout: 10000 });
  });

  await ctx.close();
});
