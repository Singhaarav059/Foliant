// Compare PDF: the text view lists the 3 changed pages and marks 2,210 → 2,500; the
// visual view draws an overlay.
import { must } from "./lib.mjs";

const spec = {
  slug: "compare-pdf",
  files: ["report.pdf", "report-v2.pdf"],
  variants: {
    text: {
      run: async ({ page }) => {
        await page.waitForSelector("main article ins, main article del", { timeout: 30000 });
        return page.evaluate(() => ({
          kind: "compare",
          pages: document.querySelectorAll("main article").length,
          ins: [...document.querySelectorAll("main article ins")].map((x) => x.textContent).join(" "),
          del: [...document.querySelectorAll("main article del")].map((x) => x.textContent).join(" "),
        }));
      },
      check: (r) => {
        must(r.pages === 3, `${r.pages} pages listed, expected 3 (every page differs)`);
        // Marked inside the number: 2,[210→500].
        must(/\b500\b/.test(r.ins) && /\b210\b/.test(r.del), `ins "${r.ins}" del "${r.del}"`);
        must(/new customers/.test(r.ins) && /renewals/.test(r.del), `ins "${r.ins}" del "${r.del}"`);
        return `${r.pages} changed pages`;
      },
    },
    visual: {
      run: async ({ page }) => {
        await page.waitForSelector("main [role=tab]", { timeout: 30000 });
        await page.locator("main [role=tab]").nth(1).click();
        await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.naturalWidth > 300), null, { timeout: 30000 });
        return { kind: "compare" };
      },
      check: () => "overlay drawn",
    },
  },
};
export default spec;
