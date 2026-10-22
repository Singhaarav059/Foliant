// Edit PDF metadata: a new title and author land in the document info and
// the XMP; clearing leaves neither.
import { PDFDocument } from "pdf-lib";
import { readFileSync } from "node:fs";
import { must } from "./lib.mjs";

const info = async (r) => {
  const b = readFileSync(r.path);
  const d = await PDFDocument.load(b, { updateMetadata: false });
  return { title: d.getTitle(), author: d.getAuthor(), xmp: /<x:xmpmeta/.test(b.toString("latin1")) };
};

const spec = {
  slug: "edit-pdf-metadata",
  files: ["report.pdf"],
  variants: {
    "new title": {
      set: async (h) => {
        await h.fill("metaTitle", "Quarterly review 2026");
        await h.fill("metaAuthor", "Finance team");
      },
      check: async (r) => {
        must(r.type === "pdf" && r.pages === 3, `${r.type} ${r.pages}p`);
        const m = await info(r);
        must(m.title === "Quarterly review 2026" && m.author === "Finance team", `title ${m.title}, author ${m.author}`);
        must(m.xmp, "no XMP written");
      },
    },
    "clear all": {
      set: (h) => h.radio("metaMode", 1),
      check: async (r) => {
        const m = await info(r);
        must(r.type === "pdf" && !m.title && !m.author && !m.xmp, `title ${m.title}, author ${m.author}, xmp ${m.xmp}`);
      },
    },
  },
};
export default spec;
