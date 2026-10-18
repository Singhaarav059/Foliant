// The home page's promise and its comparison with other PDF sites' free
// tiers: every competitor figure links its source and says when it was
// checked (src/lib/comparison.ts), and the README tells schools and offices
// how to host their own copy.
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

  await test("the comparison sources and dates every competitor figure", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await open(page, "/en");
      const rows = await page.locator("[data-comparison] tbody tr[data-competitor]").evaluateAll((trs) =>
        trs.map((tr) => ({
          service: tr.dataset.competitor,
          cells: tr.querySelectorAll("td, th").length,
          source: tr.querySelector("a[href^='https://']")?.href ?? null,
          rel: tr.querySelector("a[href^='https://']")?.rel ?? "",
          checked: tr.querySelector("time")?.getAttribute("datetime") ?? null,
          images: tr.querySelectorAll("img, svg image").length,
        })),
      );
      if (rows.length < 5) throw new Error(`${rows.length} competitor rows`);
      const domains = { iLovePDF: "ilovepdf.com", Sejda: "sejda.com", Smallpdf: "smallpdf.com", PDF24: "pdf24.org" };
      for (const r of rows) {
        if (!r.source || !new URL(r.source).hostname.endsWith(domains[r.service] ?? "?")) throw new Error(`${r.service}: source ${r.source}`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.checked ?? "")) throw new Error(`${r.service}: checked ${r.checked}`);
        if (!/noreferrer/.test(r.rel)) throw new Error(`${r.service}: link sends a referrer`);
        if (r.images) throw new Error(`${r.service}: uses an image`);
      }
      const own = await page.locator("[data-comparison] tbody tr[data-own]").count();
      if (own !== 1) throw new Error(`${own} rows for this site`);
      return `${rows.length} sourced rows (${[...new Set(rows.map((r) => r.service))].join(", ")})`;
    } finally {
      await ctx.close();
    }
  });

  await test("the comparison fits a phone without widening the page", async () => {
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
