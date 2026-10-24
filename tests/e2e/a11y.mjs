// Accessibility (P3-01) in real browsers: axe-core finds no unnamed inputs,
// unlabelled fields, nested interactive controls or low-contrast text on the
// home page and on the three stages of Compress PDF (choose, options,
// result), in light and dark mode; and with the keyboard alone, adding files
// to Merge PDF and running it leaves focus on the result's heading.
//
//   node tests/e2e/a11y.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { open, pick, root, suite } from "./kit.mjs";

// axe-core comes with eslint-plugin-jsx-a11y.
const axe = readFileSync(createRequire(join(root, "package.json")).resolve("axe-core/axe.min.js"), "utf8");
const RULES = ["aria-input-field-name", "label", "nested-interactive", "color-contrast"];

const audit = async (page) => {
  await page.addScriptTag({ content: axe });
  const found = await page.evaluate(async (rules) => {
    const r = await window.axe.run(document, { runOnly: { type: "rule", values: rules }, resultTypes: ["violations"] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")})`);
  }, RULES);
  if (found.length) throw new Error(found.join("; "));
};

await suite(async ({ name, browser, test }) => {
  // WebKit on macOS skips buttons on Tab unless Option is held, as Safari does by default.
  const TAB = name === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  for (const scheme of ["light", "dark"]) {
    // Reduced motion: contrast is measured on the settled page, not on text
    // part-way through fading in or waiting below the fold to be revealed.
    const ctx = await browser.newContext({ locale: "en-US", colorScheme: scheme, reducedMotion: "reduce", viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    await test(`${scheme}: /en`, async () => {
      await open(page, "/en");
      await audit(page);
    });
    await test(`${scheme}: compress, choosing a file`, async () => {
      await open(page, "/en/compress-pdf");
      await audit(page);
    });
    await test(`${scheme}: compress, options`, async () => {
      await pick(page, ["report.pdf"]);
      await page.waitForSelector("main aside.card");
      await audit(page);
    });
    await test(`${scheme}: compress, result`, async () => {
      await page.locator("main aside.card button.btn-primary").first().click();
      await page.waitForSelector("main h2[data-result]", { timeout: 60000 });
      await audit(page);
    });
    await ctx.close();
  }

  await test("radio groups: named by an existing label, one tab stop, arrow keys move the choice", async () => {
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    await open(page, "/en/compress-pdf");
    await pick(page, ["report.pdf"]);
    await page.waitForSelector("main aside.card [role=radiogroup]");
    const dangling = await page.evaluate(() => [...document.querySelectorAll("[role=radiogroup], label[for]")]
      .filter((el) => (el.matches("label") ? !document.getElementById(el.htmlFor) : !document.getElementById(el.getAttribute("aria-labelledby") ?? "")))
      .map((el) => el.outerHTML.slice(0, 80)));
    if (dangling.length) throw new Error(`dangling: ${dangling.join(" | ")}`);
    const group = page.locator("main aside.card [role=radiogroup]").first();
    const stops = await group.locator("[role=radio][tabindex='0']").count();
    if (stops !== 1) throw new Error(`${stops} tab stops in the group`);
    await group.locator("[role=radio][aria-checked=true]").focus();
    const before = await group.locator("[role=radio]").evaluateAll((rs) => rs.findIndex((r) => r.getAttribute("aria-checked") === "true"));
    await page.keyboard.press("ArrowDown");
    const after = await group.locator("[role=radio]").evaluateAll((rs) => rs.findIndex((r) => r.getAttribute("aria-checked") === "true"));
    const focused = await group.locator("[role=radio]").evaluateAll((rs) => rs.indexOf(document.activeElement));
    if (after !== (before + 1) % 3 || focused !== after) throw new Error(`checked ${before} → ${after}, focus on ${focused}`);
    await ctx.close();
  });

  await test("keyboard: add files and run Merge, focus ends on the result heading", async () => {
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 } });
    const page = await ctx.newPage();
    await open(page, "/en/merge-pdf");
    // The file input is reached by keyboard through the drop zone's button; setting files is the browser's part.
    await pick(page, ["report.pdf", "report-v2.pdf"]);
    await page.waitForFunction(() => document.activeElement?.matches("[data-files-heading]"), null, { timeout: 10000 })
      .catch(async () => { throw new Error(`after adding files, focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`); });
    // Tab to the action button and press Enter.
    for (let k = 0; k < 60; k++) {
      await page.keyboard.press(TAB);
      if (await page.evaluate(() => document.activeElement?.matches("main aside.card button.btn-primary"))) break;
    }
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.matches("h2[data-result]"), null, { timeout: 60000 })
      .catch(async () => { throw new Error(`after the result, focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))}`); });
    await ctx.close();
  });
});
