// Draws the PNG and ICO icons in public/ from the SVG logos, for browsers,
// home screens and app stores that don't take SVG. The results are
// committed; run this again after changing public/icon.svg or
// public/icon-maskable.svg:
//
//   node scripts/icons.mjs
//
// Rendering uses Next's own ImageResponse (resvg), so nothing extra is needed.
import { ImageResponse } from "next/og.js";
import { createElement as h } from "react";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pub = join(process.cwd(), "public");
const svg = (text) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;

async function png(src, size) {
  const res = new ImageResponse(h("img", { src, width: size, height: size }), { width: size, height: size });
  return Buffer.from(await res.arrayBuffer());
}

// The rounded icon for tabs and installs. Android crops maskable icons to its
// own shape, keeping only the middle; Apple rounds the corners of a square.
const icon = readFileSync(join(pub, "icon.svg"), "utf8");
const plain = svg(icon);
const square = svg(icon.replace(/ rx="[\d.]+"/, ""));
const bleed = svg(readFileSync(join(pub, "icon-maskable.svg"), "utf8"));
const outputs = [
  ["icon-192.png", plain, 192],
  ["icon-512.png", plain, 512],
  ["icon-maskable-512.png", bleed, 512],
  ["apple-touch-icon.png", square, 180],
];
for (const [file, src, size] of outputs) writeFileSync(join(pub, file), await png(src, size));

// favicon.ico holds PNG images (supported by every current browser): a
// 6-byte header, a 16-byte entry per image, then the images.
const sizes = [16, 32, 48];
const images = await Promise.all(sizes.map((s) => png(plain, s)));
const head = Buffer.alloc(6 + 16 * images.length);
head.writeUInt16LE(0, 0);
head.writeUInt16LE(1, 2); // icon
head.writeUInt16LE(images.length, 4);
let offset = head.length;
images.forEach((img, i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(sizes[i], e);
  head.writeUInt8(sizes[i], e + 1);
  head.writeUInt16LE(1, e + 4); // colour planes
  head.writeUInt16LE(32, e + 6); // bits per pixel
  head.writeUInt32LE(img.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += img.length;
});
writeFileSync(join(pub, "favicon.ico"), Buffer.concat([head, ...images]));
console.log(`icons: ${outputs.map(([f]) => f).join(", ")}, favicon.ico (${sizes.join(", ")} px)`);
