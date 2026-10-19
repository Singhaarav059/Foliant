// HTML to PDF in the static build: a zipped page renders with its own CSS and
// images, pasted HTML works, a remote image is never requested (and the page
// says so), and the tool's page doesn't promise "any web page".
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/html.mjs [chromium] [firefox] [webkit]
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { suite, open, pick, base } from "./kit.mjs";

const dir = mkdtempSync(join(tmpdir(), "e2e-html-"));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const site = join(dir, "site.zip");
writeFileSync(site, zipSync({
  "index.html": strToU8('<!doctype html><html><head><title>Zipped</title><link rel="stylesheet" href="style.css"></head><body><h1>Zipped page</h1><img id="logo" src="logo.png" alt="logo"></body></html>'),
  "style.css": strToU8("h1 { color: rgb(255, 0, 0); }"),
  "logo.png": PNG,
}));
const remote = join(dir, "remote.html");
writeFileSync(remote, '<!doctype html><html><head><title>Remote</title></head><body><p>Has a remote image</p><img src="https://example.com/tracker.png" alt=""></body></html>');
// Pages that once got past the filter: a <header> but no <head> (the CSP
// landed in the body), a ">" inside a quoted value, and "/" instead of a space
// before an attribute.
const tricky = {
  "header.html": '<header><h1>Report</h1></header><p>Has a header</p><img alt="a > b" src="https://example.com/leak-header.png">',
  "slash.html": '<!doctype html><html><body><header>Top</header><p>Has a slash</p><img/src="https://example.com/leak-slash.png"></body></html>',
  "scheme.html": '<p>Has odd URLs</p><img src="https:example.com/leak-scheme.png"><img src="\\\\example.com\\leak-backslash.png">',
};
for (const [n, body] of Object.entries(tricky)) writeFileSync(join(dir, n), body);

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  // Anything not for the test server counts, and is stopped before it leaves the machine.
  const offOrigin = [];
  await ctx.route((url) => url.origin !== new URL(base).origin && !/^(blob|data|about):/.test(url.protocol), (route) => {
    offOrigin.push(route.request().url());
    return route.abort();
  });
  const page = await ctx.newPage();
  const preview = () => page.frameLocator("iframe[sandbox]").first();

  await test("the page describes what the static tool takes", async () => {
    await open(page, "/en/html-to-pdf");
    const text = await page.locator("main").innerText();
    if (/any web page/i.test(text)) throw new Error('still says "any web page"');
    return "no promise of any web page";
  });

  await test("a zip renders with its CSS and image", async () => {
    await open(page, "/en/html-to-pdf");
    await pick(page, [site]);
    await page.getByRole("button", { name: "Convert to PDF", exact: true }).click();
    const h1 = preview().locator("h1");
    await h1.waitFor({ timeout: 30000 });
    const color = await h1.evaluate((el) => getComputedStyle(el).color);
    if (color !== "rgb(255, 0, 0)") throw new Error(`h1 colour ${color}: stylesheet not applied`);
    const width = await preview().locator("#logo").evaluate(async (img) => {
      if (!img.complete) await new Promise((ok) => img.addEventListener("load", ok, { once: true }));
      return img.naturalWidth;
    });
    if (width !== 1) throw new Error(`image width ${width}`);
    return "CSS applied, image shown";
  });

  await test("a remote image is never requested, and the page says so", async () => {
    offOrigin.length = 0;
    await open(page, "/en/html-to-pdf");
    await pick(page, [remote]);
    await page.getByRole("button", { name: "Convert to PDF", exact: true }).click();
    await preview().getByText("Has a remote image").waitFor({ timeout: 30000 });
    await page.waitForTimeout(1000);
    if (offOrigin.length) throw new Error(`requested ${offOrigin.join(", ")}`);
    await page.getByText(/left out/).first().waitFor({ timeout: 5000 });
    return "0 off-origin requests, notice shown";
  });

  for (const [n, body] of Object.entries(tricky)) {
    await test(`no remote request: ${n}`, async () => {
      offOrigin.length = 0;
      await open(page, "/en/html-to-pdf");
      await pick(page, [join(dir, n)]);
      await page.getByRole("button", { name: "Convert to PDF", exact: true }).click();
      await preview().getByText(body.match(/<p>([^<]+)/)[1]).waitFor({ timeout: 30000 });
      await page.waitForTimeout(1000);
      if (offOrigin.length) throw new Error(`requested ${offOrigin.join(", ")}`);
      return "0 off-origin requests";
    });
  }

  await test("pasted HTML", async () => {
    await open(page, "/en/html-to-pdf");
    await page.getByLabel("Or paste HTML").fill("<h2>Pasted heading</h2>");
    await page.getByRole("button", { name: "Use this HTML", exact: true }).click();
    await page.getByRole("button", { name: "Convert to PDF", exact: true }).click();
    await preview().getByText("Pasted heading").waitFor({ timeout: 30000 });
    return "rendered";
  });

  await ctx.close();
});
