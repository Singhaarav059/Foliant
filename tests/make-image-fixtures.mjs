// Writes the image fixtures in tests/fixtures/images/ that tests/e2e/images.mjs
// converts. Run once with `node tests/make-image-fixtures.mjs`; the output is
// committed. (photo.heic in tests/fixtures/ is 96 × 64.)
import sharp from "sharp";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "fixtures/images");
mkdirSync(out, { recursive: true });

// Four coloured quadrants, so a test can tell which way up an image landed.
export const QUADRANTS = { tl: [220, 30, 30], tr: [30, 160, 60], bl: [40, 70, 220], br: [240, 200, 20] };
const quadrants = (w, h) => {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = QUADRANTS[(y < h / 2 ? "t" : "b") + (x < w / 2 ? "l" : "r")];
      px.set(c, (y * w + x) * 3);
    }
  return sharp(px, { raw: { width: w, height: h, channels: 3 } });
};
const raw = (s) => s.raw().toBuffer({ resolveWithObject: true });
const same = (a, b) => a.info.width === b.info.width && a.info.height === b.info.height && a.data.equals(b.data);

// Aspect ratios differ per file: 96:64 (HEIC), 120:200, 160:90, 150:100.
writeFileSync(join(out, "photo.webp"), await quadrants(120, 200).webp({ lossless: true }).toBuffer());
// 300 DPI, so its page is 160 / 300 inches wide.
writeFileSync(join(out, "scan.tiff"), await quadrants(160, 90).withMetadata({ density: 300 }).tiff({ compression: "lzw" }).toBuffer());
writeFileSync(join(out, "photo.avif"), await quadrants(150, 100).avif({ lossless: true }).toBuffer());
// scan.tiff with its directory's next-directory link pointing back at itself:
// a corrupt or crafted file whose page chain never ends.
{
  const b = readFileSync(join(out, "scan.tiff"));
  const ifd = b.readUInt32LE(4);
  b.writeUInt32LE(ifd, ifd + 2 + b.readUInt16LE(ifd) * 12);
  writeFileSync(join(out, "loop.tiff"), b);
}

// An SVG of 200 × 100 CSS pixels.
{
  const rect = (x, y, c) => `<rect x="${x}" y="${y}" width="100" height="50" fill="rgb(${c})"/>`;
  const { tl, tr, bl, br } = QUADRANTS;
  writeFileSync(join(out, "drawing.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">${rect(0, 0, tl)}${rect(100, 0, tr)}${rect(0, 50, bl)}${rect(100, 50, br)}</svg>\n`);
}

// Two pages of 100 × 140, the second upside down.
{
  const one = await quadrants(100, 140).png().toBuffer();
  const two = await quadrants(100, 140).rotate(180).png().toBuffer();
  writeFileSync(join(out, "pages.tiff"), await sharp([one, two], { join: { animated: true } }).tiff({ compression: "deflate" }).toBuffer());
}

// A JPEG for each EXIF orientation, stored so that it displays as 120 × 200
// quadrants: the stored pixels are the displayed ones put through the inverse
// of the orientation.
const shown = await raw(quadrants(120, 200));
const ops = {
  none: (s) => s, flop: (s) => s.flop(), flip: (s) => s.flip(), r90: (s) => s.rotate(90), r180: (s) => s.rotate(180),
  r270: (s) => s.rotate(270), transpose: (s) => s.rotate(90).flop(), transverse: (s) => s.rotate(270).flop(),
};
const from = () => sharp(shown.data, { raw: { width: 120, height: 200, channels: 3 } });
for (let o = 1; o <= 8; o++) {
  let found = null;
  for (const [name, op] of Object.entries(ops)) {
    const stored = await op(from()).png().toBuffer();
    const tagged = await sharp(stored).withMetadata({ orientation: o }).png().toBuffer();
    if (same(await raw(sharp(tagged).rotate()), shown)) {
      found = name;
      writeFileSync(join(out, `orient-${o}.jpg`), await sharp(stored).withMetadata({ orientation: o }).jpeg({ quality: 95 }).toBuffer());
      break;
    }
  }
  if (!found) throw new Error(`no stored form for orientation ${o}`);
}

// A phone "motion photo": orient-6.jpg with a second JPEG (its own EXIF, as
// in an MPF or gain-map image) and a stand-in MP4 after the end-of-image
// marker. Viewers show the first image; the rest is data that rides along.
{
  const extra = await quadrants(40, 30).withExif({ IFD0: { Make: "TrailingCam" }, IFD3: { GPSLatitudeRef: "N" } }).jpeg().toBuffer();
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom\0\0\0\0isommp42MotionPhotoVideo", "latin1")]);
  writeFileSync(join(out, "motion.jpg"), Buffer.concat([readFileSync(join(out, "orient-6.jpg")), extra, mp4]));
}
console.log("written to", out);
