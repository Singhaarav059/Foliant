// Add watermark: CONFIDENTIAL in text on every page by default; a tiled logo with the image option.
import { must } from "./lib.mjs";

const spec = {
  slug: "add-watermark",
  files: ["report.pdf"],
  variants: {
    defaults: {
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        must(r.pageText.every((t) => /CONFIDENTIAL/.test(t.replace(/\s/g, ""))), "not every page has the text");
      },
    },
    "image, mosaic": {
      set: async (h) => {
        await h.radio("markType", 1);
        await h.page.locator("main aside input[type=file][accept='image/*']").setInputFiles(h.fx("logo.png"));
        await h.toggle("mosaic");
      },
      check: (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        must(r.xobjects.every((n) => n > 0), "a page has no image");
      },
    },
  },
};
export default spec;
