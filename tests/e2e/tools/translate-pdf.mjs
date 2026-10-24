// Translate PDF: with no translator in the browser and no model downloaded,
// it says so instead of returning the file untranslated, unless the site has
// server AI (functions/api/ai.ts, on Cloudflare Pages), which a device that
// can't run the models uses by default: then the PDF comes back in Spanish.
// (tests/e2e/ai.mjs translates with the model, tests/e2e/ai-cloud.mjs with a
// stand-in server AI.) Headless Chromium has the built-in Translator but
// crashes when one is created, so the page is made to go without it.
import { must } from "./lib.mjs";

let serverAi = false;

const spec = {
  slug: "translate-pdf",
  files: ["report.pdf"],
  variants: {
    "no model": {
      set: async (h) => {
        await h.page.evaluate(() => {
          delete globalThis.Translator;
          delete globalThis.LanguageDetector;
        });
        serverAi = await h.page.evaluate(async () => {
          try {
            const r = await fetch("/api/ai", { cache: "no-store" });
            const s = r.ok ? await r.json() : null;
            return !!(s?.anthropic || s?.cloudflare);
          } catch {
            return false;
          }
        });
      },
      check: (r) => {
        if (serverAi) {
          must(r.kind === "single" && /informe|ingresos/i.test(r.text ?? ""), `${r.kind}: ${(r.text ?? r.type ?? "").slice(0, 120)}`);
          return "translated by server AI";
        }
        must(r.kind === "error" && r.text.length > 20, `${r.kind}: ${r.text ?? r.type}`);
        return "asks for a translator";
      },
    },
  },
};
export default spec;
