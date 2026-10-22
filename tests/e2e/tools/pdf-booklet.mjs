// PDF booklet: 3 pages padded to 4, two to a side: [blank, 1] and [2, 3].
import { must } from "./lib.mjs";

const spec = {
  slug: "pdf-booklet",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => must(r.type === "pdf" && r.pages === 2 && r.size[0][0] > r.size[0][1] && /Quarterly/.test(r.pageText[0]), `${r.type} ${r.pages}p ${r.size?.[0]}`),
    },
  },
};
export default spec;
