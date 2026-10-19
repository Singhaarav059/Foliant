// Sign PDF: a drawn signature, or today's date, placed on page 1.
import { must } from "./lib.mjs";

const spec = {
  slug: "sign-pdf",
  files: ["report.pdf"],
  prepare: (h) => h.waitStage(),
  variants: {
    "drawn signature": {
      set: async (h) => {
        const { page } = h;
        await h.icon("signature", "main aside").click();
        const c = page.locator("dialog[open] canvas");
        const b = await c.boundingBox();
        await page.mouse.move(b.x + 20, b.y + b.height / 2);
        await page.mouse.down();
        for (let k = 0; k < 20; k++) await page.mouse.move(b.x + 20 + k * 12, b.y + b.height / 2 + Math.sin(k) * 20);
        await page.mouse.up();
        await page.locator("dialog[open] button.btn-primary").click();
        await h.clickStage(0.6, 0.3);
      },
      check: (r) => must(r.type === "pdf" && r.pages === 3 && r.xobjects[0] > 0, `${r.type} ${r.pages}p, page 1 images ${r.xobjects?.[0]}`),
    },
    date: {
      set: async (h) => { await h.icon("calendar-days", "main aside").click(); await h.clickStage(0.6, 0.3); },
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        // A date such as 18/10/2026, 2026/10/18 or 18.10.2026, in whatever form the language writes it.
        must(/\d{1,4}\s*[./\-年]\s*\d{1,2}\s*[./\-月]\s*\d{1,4}/.test(r.pageText[0]), `no date on page 1: …${r.pageText?.[0].slice(-60)}`);
      },
    },
  },
};
export default spec;
