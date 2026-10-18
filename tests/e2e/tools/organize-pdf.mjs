// Organize PDF: unchanged it gives back the 3 pages; with a second file added
// and its first page deleted it gives 5.
import { must } from "./lib.mjs";

const spec = {
  slug: "organize-pdf",
  files: ["report.pdf"],
  prepare: (h) => h.waitPages(3),
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 3 && /part 1.*part 2.*part 3/.test(r.text), `${r.type} ${r.pages}p`),
    },
    "add a file, delete a page": {
      set: async (h) => {
        await h.pick(["report-v2.pdf"]);
        await h.waitPages(6);
        const first = h.page.locator("main ul li:has(img)").first();
        await first.hover();
        await first.locator("button:has(svg.lucide-trash-2)").click({ force: true });
        await h.page.waitForFunction(() => document.querySelectorAll("main ul li img").length === 5, null, { timeout: 10000 });
      },
      check: (r) => must(r.type === "pdf" && r.pages === 5 && /2,500/.test(r.text), `${r.type} ${r.pages}p, expected 5 pages with the second file`),
    },
  },
};
export default spec;
