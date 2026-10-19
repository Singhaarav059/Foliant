// JPG to PDF: two pictures make a two-page PDF, or two one-page PDFs.
import { must } from "./lib.mjs";

const spec = {
  slug: "jpg-to-pdf",
  files: ["photo.jpg", "logo.png"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 2, `${r.type} ${r.pages}p`);
        must(r.xobjects.every((n) => n > 0), "a page has no image");
      },
    },
    separate: {
      set: (h) => h.toggle("separate"),
      check: (r) => must(r.type === "zip" && r.entries.length === 2 && r.entries.every((e) => e.ext === "pdf" && e.pages === 1), `${r.type} ${JSON.stringify(r.entries)}`),
    },
  },
};
export default spec;
