// Exam Photo Resizer: a photo comes back as a JPEG at the preset's exact
// pixels and inside its KB range; the signature preset gives its own size.
import { readFileSync } from "node:fs";
import { must } from "./lib.mjs";

// Width and height from the JPEG's frame header.
const frame = (b) => {
  for (let i = 2; i + 9 < b.length; i += 2 + b.readUInt16BE(i + 2)) {
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
  }
  return "none";
};
const fits = (size, minKb, maxKb) => (r) => {
  must(r.type === "jpg", `${r.type}, expected jpg`);
  const got = frame(readFileSync(r.path));
  must(got === size, `${got}, expected ${size}`);
  must(r.bytes >= minKb * 1024 && r.bytes <= maxKb * 1024, `${r.bytes} bytes, expected ${minKb} to ${maxKb} KB`);
};
const spec = {
  slug: "exam-photo-resizer",
  files: ["photo.jpg"],
  variants: {
    defaults: { check: fits("200x230", 20, 50) },
    signature: { set: (h) => h.select("examPreset", "signature"), check: fits("140x60", 10, 20) },
  },
};
export default spec;
