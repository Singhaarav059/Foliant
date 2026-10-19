// PDF to JPG: one picture per page, JPEG by default or PNG.
import { must } from "./lib.mjs";

const pics = (ext) => (r) => {
  must(r.type === "zip" && r.entries.length === 3, `${r.type} with ${r.entries?.length} files, expected 3`);
  must(r.entries.every((e) => e.ext === ext && e.bytes > 1000), `not all ${ext}: ${r.entries.map((e) => e.name)}`);
};
const spec = {
  slug: "pdf-to-jpg",
  files: ["report.pdf"],
  variants: {
    defaults: { check: pics("jpg") },
    png: { set: (h) => h.radio("format", 1), check: pics("png") },
  },
};
export default spec;
