// The home page's promise, which links its proof, fits a phone, and the
// README tells schools and offices how to host their own copy.
//
//   node tests/e2e/promise.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { open, root, suite } from "./kit.mjs";

const readme = readFileSync(join(root, "README.md"), "utf8");

await suite(async ({ browser, test }) => {
  await test("the home page states the promise and links the proof", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await open(page, "/en");
      const promise = page.locator("[data-promise]");
      const items = await promise.locator("li").allTextContents();
      if (items.length !== 4) throw new Error(`${items.length} promises: ${items.join(" | ")}`);
      const check = await promise.locator('a[href="/en/security#check"]').count();
      if (!check) throw new Error("no link to the security page's check section");
      return items.join(" | ");
    } finally {
      await ctx.close();
    }
  });

  await test("the home page fits a phone without widening the page", async () => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    try {
      await open(page, "/en");
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (over > 0) throw new Error(`${over}px horizontal overflow`);
      return "no overflow at 375px";
    } finally {
      await ctx.close();
    }
  });

  await test("the README has a deploy-your-own section", async () => {
    const section = readme.split(/^## /m).find((s) => /^Deploy your own on Cloudflare Pages/.test(s));
    if (!section) throw new Error("no '## Deploy your own on Cloudflare Pages'");
    for (const must of ["npm run build:static", "out", "_headers"]) if (!section.includes(must)) throw new Error(`section lacks ${must}`);
    if (!/^## (?:Limitations|Honest limitations)/m.test(readme)) throw new Error("no limitations section");
    return "deploy-your-own and limitations sections";
  });
});
