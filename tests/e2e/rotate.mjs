// Rotate PDF in real browsers: the file that comes back is turned by the
// chosen angle, the thumbnails show that turn before the file is made, and a
// page turned on its own adds its turn to the angle.
//
//   npm run build:static
//   node scripts/serve-static.mjs out 3202 &
//   node tests/e2e/rotate.mjs [chromium] [firefox] [webkit]
//
// BASE_URL and CHROME_PATH work as in tests/e2e.mjs.
import pw from "playwright-core";
import { PDFDocument } from "pdf-lib";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.BASE_URL ?? "http://localhost:3202";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const downloads = mkdtempSync(join(tmpdir(), "e2e-rotate-"));
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];
const results = [];

const angles = async (path) => (await PDFDocument.load(readFileSync(path))).getPages().map((p) => p.getRotation().angle);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

for (const name of engines) {
  let browser;
  try {
    browser = await pw[name].launch(name === "chromium" && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    results.push({ browser: name, label: "launch", ok: false, detail: e.message.split("\n")[0] });
    continue;
  }
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const test = async (label, fn) => {
    try {
      results.push({ browser: name, label, ok: true, detail: await fn() });
    } catch (e) {
      results.push({ browser: name, label, ok: false, detail: e.message.split("\n")[0].slice(0, 200) });
    }
  };

  // Opens the tool with report.pdf (3 pages) and waits for every thumbnail.
  const ready = async () => {
    await page.goto(base + "/en/rotate-pdf", { waitUntil: "load" });
    // Hydrated, including the file input: a file set before React listens is lost.
    await page.waitForFunction(() => {
      const live = (el) => !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
      return live(document.querySelector("input[type=file]")) && [...document.querySelectorAll("button")].some(live);
    }, null, { timeout: 20000 });
    await page.locator("input[type=file]").first().setInputFiles(join(fixtures, "report.pdf"));
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll("main ul li img")];
      return imgs.length === 3 && imgs.every((i) => i.src.startsWith("blob:") && i.naturalWidth > 0);
    }, null, { timeout: 30000 });
  };
  // The turn each thumbnail shows, read from its CSS transform.
  const shown = () => page.locator("main ul li img").evaluateAll((imgs) => imgs.map((i) => Number(/rotate\((-?\d+)deg\)/.exec(i.style.transform)?.[1] ?? 0)));
  const rotate = async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: "Rotate PDF", exact: true }).first().click()]);
    const path = join(downloads, `${name}-${Date.now()}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    return angles(path);
  };
  const expect = (what, got, want) => {
    if (!same(got, want)) throw new Error(`${what} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  };

  await test("default angle turns every page 90°", async () => {
    await ready();
    const thumbs = await shown();
    const got = await rotate();
    expect("pages", got, [90, 90, 90]);
    expect("thumbnails", thumbs, [90, 90, 90]);
    return JSON.stringify(got);
  });

  for (const angle of [180, 270, 0]) {
    await test(`angle ${angle}° turns every page ${angle}°`, async () => {
      await ready();
      await page.getByLabel("Rotate all by", { exact: true }).selectOption(String(angle));
      const thumbs = await shown();
      const got = await rotate();
      expect("pages", got, [angle, angle, angle]);
      expect("thumbnails", thumbs, [angle, angle, angle]);
      return JSON.stringify(got);
    });
  }

  await test("a page turned on its own adds to the angle", async () => {
    await ready();
    const second = page.locator("main ul li").nth(1);
    await second.hover();
    await second.getByRole("button", { name: "Rotate right", exact: true }).click();
    const thumbs = await shown();
    const got = await rotate();
    expect("pages", got, [90, 180, 90]);
    expect("thumbnails", thumbs, [90, 180, 90]);
    return JSON.stringify(got);
  });

  await test("with 0°, only the page turned on its own changes", async () => {
    await ready();
    await page.getByLabel("Rotate all by", { exact: true }).selectOption("0");
    const third = page.locator("main ul li").nth(2);
    await third.hover();
    await third.getByRole("button", { name: "Rotate left", exact: true }).click();
    const got = await rotate();
    expect("pages", got, [0, 0, 270]);
    return JSON.stringify(got);
  });

  await browser.close();
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.browser.padEnd(9)} ${r.label.padEnd(46)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
