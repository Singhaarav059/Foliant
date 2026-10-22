// Translate PDF: with no translator in the browser and no model downloaded,
// it says so instead of returning the file untranslated. (tests/e2e/ai.mjs
// translates with the model.) Headless Chromium has the built-in Translator
// but crashes when one is created, so the page is made to go without it.
import { must } from "./lib.mjs";

const spec = {
  slug: "translate-pdf",
  files: ["report.pdf"],
  variants: {
    "no model": {
      set: (h) => h.page.evaluate(() => {
        delete globalThis.Translator;
        delete globalThis.LanguageDetector;
      }),
      check: (r) => {
        must(r.kind === "error" && r.text.length > 20, `${r.kind}: ${r.text ?? r.type}`);
        return "asks for a translator";
      },
    },
  },
};
export default spec;
