// Read PDF aloud: the report's text shows in reading order, headings first,
// ready to play (tests/e2e/listen.mjs plays it with a stand-in voice).
import { must } from "./lib.mjs";

const spec = {
  slug: "read-pdf-aloud",
  files: ["report.pdf"],
  variants: {
    defaults: {
      run: async ({ page }) => {
        // The reading view, or the note that this browser can't speak.
        await page.waitForSelector("main [data-passage], main [role=alert]", { timeout: 30000 });
        return page.evaluate(() => ({
          kind: "listen",
          passages: [...document.querySelectorAll("main [data-passage]")].map((p) => p.textContent ?? ""),
          speech: "speechSynthesis" in window,
        }));
      },
      check: (r) => {
        if (!r.speech) return "no speech synthesis in this browser";
        must(r.passages.length > 5 && /Quarterly/.test(r.passages[0]), `passages: ${r.passages.slice(0, 2).join(" | ")}`);
        return `${r.passages.length} passages`;
      },
    },
  },
};
export default spec;
