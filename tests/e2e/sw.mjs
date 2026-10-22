// Service-worker hygiene (P3-03) in real browsers: navigation preload is on,
// the pages cache keeps at most 60 pages after 200 visits, and a tab that
// asks for a /vendor file from a build that's gone is offered a reload.
//
//   node tests/e2e/sw.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { open, root, suite } from "./kit.mjs";

// 200 of the site's pages, from the sitemap.
const pages = [...readFileSync(join(root, "out/sitemap.xml"), "utf8").matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => new URL(m[1]).pathname).slice(0, 200);

await suite(async ({ browser, name, test }) => {
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await open(page, "/en");
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The worker controls pages from the next load on.
  await open(page, "/en");

  await test("navigation preload is on", async () => {
    const on = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.navigationPreload ? (await reg.navigationPreload.getState()).enabled : "unsupported";
    });
    if (on === "unsupported") return "not supported in this browser";
    if (on !== true) throw new Error(`navigation preload: ${on}`);
  });

  await test("after 200 pages, the pages cache holds at most 60", async () => {
    for (const path of pages) await page.goto(new URL(path, page.url()).href, { waitUntil: "domcontentloaded" });
    // Writes finish after each response; give the last ones a moment.
    await page.waitForTimeout(1500);
    const n = await page.evaluate(async () => {
      const name = (await caches.keys()).find((k) => k.startsWith("nopload-pages-"));
      return name ? (await (await caches.open(name)).keys()).length : -1;
    });
    if (n < 0) throw new Error("no pages cache");
    if (n > 60 || n < 40) throw new Error(`${n} pages kept after ${pages.length} visits`);
    return `${n} kept after ${pages.length} visits`;
  });

  await test("a /vendor file from a build that's gone: the page offers to reload", async () => {
    await open(page, "/en/merge-pdf");
    await page.evaluate(() => fetch("/vendor/000000000000/pdfium.wasm").catch(() => {}));
    await page.waitForSelector("[data-stale]", { timeout: 10000 });
  });
  void name;
  await ctx.close();
});
