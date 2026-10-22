// PDF to PDF/A: an archival file (PDF/A identification in its metadata), at
// the default level and at 1b. Pages that need no rasterising keep their real
// text, and the in-browser check reports no problem.
import { must } from "./lib.mjs";

const passed = async (h) => must(await h.page.locator("main [data-report] svg.lucide-clipboard-check").count() === 1, "no passing PDF/A check report");

const spec = {
  slug: "pdf-to-pdfa",
  files: ["report.pdf"],
  timeout: 120000,
  variants: {
    defaults: {
      check: async (r, h) => {
        must(r.type === "pdf" && r.pages === 3 && r.pdfa, `${r.type} ${r.pages}p pdfa=${r.pdfa}`);
        must(/Quarterly report part 1/.test(r.text), "text not kept");
        await passed(h);
      },
    },
    // The DPI and text-layer options only show when a page must become an
    // image; report.pdf needs none, so the level is what changes here.
    "PDF/A-1b": {
      set: (h) => h.select("pdfaLevel", "1b"),
      check: async (r, h) => {
        must(r.type === "pdf" && r.pages === 3 && r.pdfa, `${r.type} ${r.pages}p pdfa=${r.pdfa}`);
        must(/Quarterly report part 3/.test(r.text), "real text lost");
        await passed(h);
      },
    },
  },
};
export default spec;
