// Redact PDF: the e-mail preset, or a searched word at 300 dpi, is gone from the text.
import { must } from "./lib.mjs";

const spec = {
  slug: "redact-pdf",
  files: ["report.pdf"],
  timeout: 120000,
  prepare: (h) => h.waitStage(),
  variants: {
    "e-mail preset": {
      set: async (h) => {
        await h.page.locator("main aside .flex-wrap > button").first().click();
        await h.page.waitForFunction(() => document.querySelectorAll("main div.touch-none [data-mark], main div.touch-none div.absolute").length > 0, null, { timeout: 10000 }).catch(() => {});
      },
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        must(!/jane\.doe@example\.com/.test(r.text) && /Quarterly/.test(r.text), "e-mail still there, or all text gone");
      },
    },
    "search, 300 dpi": {
      set: async (h) => {
        await h.page.locator("main aside form input.field").fill("Revenue");
        await h.page.locator("main aside form button").click();
        await h.select("redactDpi", "300");
        await h.page.waitForTimeout(500);
      },
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        must(!/Revenue/.test(r.text) && /Quarterly/.test(r.text), "word still there, or all text gone");
      },
    },
  },
};
export default spec;
