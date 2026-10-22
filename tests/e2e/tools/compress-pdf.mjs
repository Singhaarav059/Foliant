// Compress PDF: a scan comes back as a smaller one-page PDF at both levels.
// In a batch where one file shrinks and another can't, the result line gives
// the total and each file's row says what happened to it.
import { statSync } from "node:fs";
import { must } from "./lib.mjs";

const check = (r, h) => {
  must(r.type === "pdf" && r.pages === 1, `${r.type} ${r.pages}p`);
  must(r.bytes <= statSync(h.fx("scanned.pdf")).size, `${r.bytes} bytes, larger than the input`);
};
const spec = {
  slug: "compress-pdf",
  files: ["scanned.pdf"],
  variants: {
    defaults: { check },
    extreme: { set: (h) => h.radio("level", 0), check },
    batch: {
      files: ["scanned.pdf", "report.pdf"],
      check: async (r, h) => {
        must(r.type === "zip" && r.entries.length === 2, `${r.type} ${r.entries?.length}`);
        const rows = await h.page.locator("main li:has([data-file-note])").allInnerTexts();
        const of = (name) => rows.find((x) => x.includes(name)) ?? "";
        must(/\d+%/.test(of("scanned")), `scanned row: ${of("scanned")}`);
        must(!/\d+%/.test(of("report")) && of("report").length > 0, `report row: ${of("report")}`);
        must(await h.page.locator("main p[data-saved]").count() === 1, "no total saving line");
      },
    },
  },
};
export default spec;
