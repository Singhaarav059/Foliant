// Rewrites a WOFF 1.0 font so every glyph record in `glyf` starts on a 4-byte
// boundary, with a long-format `loca`. @pdf-lib/fontkit's subsetter copies
// glyph records as they are and then writes offsets that assume even lengths,
// so a font with odd-length glyphs (Noto Sans Arabic, Devanagari) embeds with
// corrupted glyphs. Other tables are copied unchanged.
import { deflateSync, inflateSync } from "node:zlib";

export function padWoff(woff) {
  const src = Buffer.from(woff);
  if (src.toString("latin1", 0, 4) !== "wOFF") throw new Error("not a WOFF 1.0 file");
  const flavor = src.readUInt32BE(4);
  const numTables = src.readUInt16BE(12);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const tag = src.toString("latin1", e, e + 4);
    const offset = src.readUInt32BE(e + 4), compLength = src.readUInt32BE(e + 8), origLength = src.readUInt32BE(e + 12);
    const raw = src.subarray(offset, offset + compLength);
    tables.set(tag, compLength < origLength ? inflateSync(raw) : Buffer.from(raw));
  }

  const head = Buffer.from(tables.get("head"));
  const glyf = tables.get("glyf"), loca = tables.get("loca");
  if (glyf && loca) {
    const numGlyphs = tables.get("maxp").readUInt16BE(4);
    const long = head.readInt16BE(50) === 1;
    const at = (i) => (long ? loca.readUInt32BE(i * 4) : loca.readUInt16BE(i * 2) * 2);
    const parts = [];
    const newLoca = Buffer.alloc((numGlyphs + 1) * 4);
    let pos = 0;
    for (let g = 0; g < numGlyphs; g++) {
      const data = glyf.subarray(at(g), at(g + 1));
      newLoca.writeUInt32BE(pos, g * 4);
      const padded = Buffer.alloc((data.length + 3) & ~3);
      data.copy(padded);
      parts.push(padded);
      pos += padded.length;
    }
    newLoca.writeUInt32BE(pos, numGlyphs * 4);
    tables.set("glyf", Buffer.concat(parts));
    tables.set("loca", newLoca);
    head.writeInt16BE(1, 50); // indexToLocFormat: long
  }
  head.writeUInt32BE(0, 8); // checkSumAdjustment, unused by font loaders
  tables.set("head", head);

  // Write WOFF 1.0 again: header, directory sorted by tag, then table data.
  const tags = [...tables.keys()].sort();
  const checksum = (b) => {
    const p = Buffer.alloc((b.length + 3) & ~3);
    b.copy(p);
    let sum = 0;
    for (let i = 0; i < p.length; i += 4) sum = (sum + p.readUInt32BE(i)) >>> 0;
    return sum;
  };
  const entries = tags.map((tag) => {
    const orig = tables.get(tag);
    const z = deflateSync(orig);
    return { tag, orig, data: z.length < orig.length ? z : orig };
  });
  let offset = 44 + tags.length * 20;
  const header = Buffer.alloc(offset);
  const blobs = [];
  let sfntSize = 12 + tags.length * 16;
  entries.forEach((t, i) => {
    const e = 44 + i * 20;
    header.write(t.tag, e, "latin1");
    header.writeUInt32BE(offset, e + 4);
    header.writeUInt32BE(t.data.length, e + 8);
    header.writeUInt32BE(t.orig.length, e + 12);
    header.writeUInt32BE(checksum(t.orig), e + 16);
    const padded = Buffer.alloc((t.data.length + 3) & ~3);
    t.data.copy(padded);
    blobs.push(padded);
    offset += padded.length;
    sfntSize += (t.orig.length + 3) & ~3;
  });
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(flavor, 4);
  header.writeUInt32BE(offset, 8);
  header.writeUInt16BE(tags.length, 12);
  header.writeUInt32BE(sfntSize, 16);
  return Buffer.concat([header, ...blobs]);
}
