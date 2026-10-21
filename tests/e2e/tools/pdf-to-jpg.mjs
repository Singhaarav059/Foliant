// PDF to JPG: one picture per page, JPEG by default, PNG or WebP; a page
// range, a custom resolution and a clear background.
import { must } from "./lib.mjs";

const pics = (ext, n = 3) => (r) => {
  must(r.type === "zip" && r.entries.length === n, `${r.type} with ${r.entries?.length} files, expected ${n}`);
  must(r.entries.every((e) => e.ext === ext && e.bytes > 1000), `not all ${ext}: ${r.entries.map((e) => e.name)}`);
};
const spec = {
  slug: "pdf-to-jpg",
  files: ["report.pdf"],
  variants: {
    defaults: { check: pics("jpg") },
    png: { set: (h) => h.radio("format", 1), check: pics("png") },
    "webp, pages 2-3 at 200 dpi, transparent": {
      set: async (h) => {
        await h.radio("format", 2);
        await h.select("dpi", "custom");
        await h.fill("customDpi", "200");
        await h.fill("pageRange", "2-3");
        await h.toggle("transparent");
      },
      check: pics("webp", 2),
    },
  },
};
export default spec;
