// PDF attachments: a photo goes into the report, comes back out as itself,
// and Remove leaves a PDF with no embedded files.
import { readFileSync } from "node:fs";
import { must } from "./lib.mjs";

const embedded = (r) => /\/EmbeddedFile\b/.test(readFileSync(r.path).toString("latin1"));

const spec = {
  slug: "pdf-attachments",
  files: ["report.pdf", "photo.jpg"],
  variants: {
    add: {
      keep: "attached",
      set: (h) => h.radio("attachMode", 1),
      check: (r) => must(r.type === "pdf" && r.pages === 3 && embedded(r), `${r.type} ${r.pages}p embedded ${r.type === "pdf" && embedded(r)}`),
    },
    extract: {
      files: ["@attached"],
      check: (r) => must(r.type === "jpg" && r.bytes > 1000, `${r.type} ${r.bytes}B`),
    },
    remove: {
      files: ["@attached"],
      set: (h) => h.radio("attachMode", 2),
      check: (r) => must(r.type === "pdf" && !embedded(r), `${r.type} embedded ${embedded(r)}`),
    },
    "nothing to extract": {
      files: ["report.pdf"],
      check: (r) => must(r.kind === "error", `${r.kind} ${r.type}`),
    },
  },
};
export default spec;
