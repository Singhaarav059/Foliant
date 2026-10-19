// Add page numbers: page n gains a "n" by default, or "n … 3" (in the page language) with "n of total".
import { readFileSync } from "node:fs";
import { must, pageTexts } from "./lib.mjs";

const count = (text, re) => (text.match(re) ?? []).length;
const spec = {
  slug: "add-page-numbers",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: async (r, h) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        const before = await pageTexts(readFileSync(h.fx("report.pdf")));
        r.pageText.forEach((t, i) => {
          const n = new RegExp(`(?<![\\d,.])${i + 1}(?![\\d,.%])`, "g");
          must(count(t, n) > count(before[i], n), `page ${i + 1} has no "${i + 1}" added`);
        });
      },
    },
    "n of total": {
      set: (h) => h.select("numberFormat", "nOfTotal"),
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        // Right-to-left languages store it in visual order: "3 من 1".
        const of = (n) => new RegExp(`(?<![\\d,.])(${n}\\D{1,8}3|3\\D{1,8}${n})(?![\\d,.%])`);
        r.pageText.forEach((t, i) => must(of(i + 1).test(t), `page ${i + 1}: no "${i + 1} of 3"`));
      },
    },
  },
};
export default spec;
