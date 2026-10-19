// The byte-level image helpers in src/lib/pdf/imagebytes.ts: the TIFF
// directory-chain guard, freeing each TIFF page after it's read, and taking
// EXIF and other metadata out of JPEGs that are embedded as they are.
//
//   node tests/image-bytes.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import UTIF from "utif2";
import { stripJpegMetadata, tiffChainOk, tiffRaster } from "../src/lib/pdf/imagebytes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => new Uint8Array(readFileSync(join(root, "tests/fixtures/images", name)));
let failed = 0;
async function test(name, fn) {
  try {
    const note = await fn();
    console.log(`ok   ${name}${note ? ` (${note})` : ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text, "latin1"));

await test("good TIFFs pass the chain check", () => {
  for (const f of ["scan.tiff", "pages.tiff"]) if (!tiffChainOk(fixture(f))) throw new Error(`${f} rejected`);
});

await test("a TIFF whose directory links to itself is rejected", () => {
  if (tiffChainOk(fixture("loop.tiff"))) throw new Error("loop.tiff accepted");
});

await test("a two-directory cycle, an out-of-file link and a huge field count are rejected", () => {
  const two = Buffer.from(fixture("pages.tiff"));
  const first = two.readUInt32LE(4);
  const second = two.readUInt32LE(first + 2 + two.readUInt16LE(first) * 12);
  two.writeUInt32LE(first, second + 2 + two.readUInt16LE(second) * 12);
  if (tiffChainOk(two)) throw new Error("A → B → A accepted");
  const out = Buffer.from(fixture("scan.tiff"));
  out.writeUInt32LE(out.length + 100, 4);
  if (tiffChainOk(out)) throw new Error("directory past the end accepted");
  const big = Buffer.from(fixture("scan.tiff"));
  const ifd = big.readUInt32LE(4);
  big.writeUInt32LE(0x7fffffff, ifd + 2 + 4); // first entry's count
  if (tiffChainOk(big)) throw new Error("field of 2^31 values accepted");
});

await test("each TIFF page's raster is let go once it's read", () => {
  const buffer = fixture("pages.tiff").slice().buffer;
  const ifds = UTIF.decode(buffer);
  for (const ifd of ifds) {
    const rgba = tiffRaster(UTIF, buffer, ifd);
    if (rgba.length !== ifd.width * ifd.height * 4) throw new Error(`RGBA of ${rgba.length} bytes`);
    if (ifd.data) throw new Error("UTIF's raster is still held on the directory");
  }
  return `${ifds.length} pages`;
});

await test("EXIF, XMP and comments are taken out of a JPEG; pixels and ICC stay", async () => {
  const src = await sharp(fixture("orient-6.jpg"))
    .withIccProfile("srgb")
    .withExif({ IFD0: { Make: "CameraCo", Model: "SerialCam" }, IFD3: { GPSLatitudeRef: "N" } })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><secret>here</secret></x:xmpmeta>')
    .jpeg({ quality: 90 })
    .toBuffer();
  for (const t of ["Exif\0\0", "CameraCo", "http://ns.adobe.com/xap/1.0/", "ICC_PROFILE"]) if (!has(src, t)) throw new Error(`source lacks ${t}`);
  const out = stripJpegMetadata(new Uint8Array(src));
  for (const t of ["Exif\0\0", "CameraCo", "http://ns.adobe.com/xap/1.0/", "secret"]) if (has(out, t)) throw new Error(`output still has ${JSON.stringify(t)}`);
  if (!has(out, "ICC_PROFILE")) throw new Error("ICC profile dropped");
  const [a, b] = await Promise.all([sharp(src).raw().toBuffer(), sharp(Buffer.from(out)).raw().toBuffer()]);
  if (!a.equals(b)) throw new Error("pixels changed");
  return `${src.length} → ${out.length} bytes`;
});

await test("a JPEG with nothing to take out comes back as it is; a broken one too", async () => {
  const plain = new Uint8Array(await sharp(fixture("orient-1.jpg")).jpeg().toBuffer());
  if (stripJpegMetadata(plain) !== plain) throw new Error("plain JPEG was copied");
  const broken = fixture("orient-6.jpg").subarray(0, 40);
  if (stripJpegMetadata(broken) !== broken) throw new Error("truncated JPEG was changed");
});

await test("whatever follows the end of the image (a second JPEG, a motion photo's video) is cut off", async () => {
  const src = fixture("motion.jpg");
  for (const t of ["TrailingCam", "ftypisom"]) if (!has(src, t)) throw new Error(`source lacks ${t}`);
  const out = stripJpegMetadata(src);
  for (const t of ["TrailingCam", "ftypisom", "MotionPhotoVideo", "Exif\0\0"]) if (has(out, t)) throw new Error(`output still has ${JSON.stringify(t)}`);
  if (out[out.length - 2] !== 0xff || out[out.length - 1] !== 0xd9) throw new Error("output doesn't end at the end-of-image marker");
  if (!Buffer.from(out).equals(Buffer.from(stripJpegMetadata(fixture("orient-6.jpg"))))) throw new Error("output differs from the photo on its own");
  return `${src.length} → ${out.length} bytes`;
});

await test("a progressive JPEG keeps all its scans; trailing bytes still go", async () => {
  const base = await sharp(fixture("orient-1.jpg")).jpeg({ progressive: true, quality: 85 }).toBuffer();
  const src = Buffer.concat([base, Buffer.from("\xff\xd8\xff\xe1 trailing secret", "latin1")]);
  const out = stripJpegMetadata(new Uint8Array(src));
  if (!Buffer.from(out).equals(base)) throw new Error(`output is ${out.length} bytes, the image alone ${base.length}`);
  const scans = [...base.keys()].filter((i) => base[i] === 0xff && base[i + 1] === 0xda).length;
  return `${scans} scans kept`;
});

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
