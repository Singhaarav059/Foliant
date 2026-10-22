// Verify PDF signature: a report on the file as soon as it's in, with nothing
// to download. report.pdf isn't signed. (tests/e2e/pades.mjs checks signed files.)
import { must } from "./lib.mjs";

const spec = {
  slug: "verify-pdf-signature",
  files: ["report.pdf"],
  variants: {
    unsigned: {
      run: async ({ page }) => {
        const status = page.locator("main [role=status]").filter({ hasText: /\S/ }).first();
        await status.waitFor({ timeout: 30000 });
        await page.waitForFunction(() => !document.querySelector("main .animate-spin"), null, { timeout: 30000 });
        return { kind: "check", text: (await status.innerText()).trim(), downloads: await page.locator("main button.btn-primary svg.lucide-download").count() };
      },
      check: (r) => {
        must(r.text.length > 5 && r.downloads === 0, `report "${r.text}", ${r.downloads} downloads`);
        return r.text.split("\n")[0];
      },
    },
  },
};
export default spec;
