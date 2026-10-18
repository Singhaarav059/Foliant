// MozJPEG (via jSquash, Apache-2.0): trellis quantisation and optimised
// Huffman tables give smaller files than the browser's encoder at the same
// quality, and it writes true greyscale JPEGs. The WASM comes from /vendor.

import { VENDOR } from "../vendor";
import { fromRGBA, toRGBA, type Pixels } from "./pixels";

// Tests swap this for a file read.
export const wasm = {
  load: (name: string) => WebAssembly.compileStreaming(fetch(`${VENDOR}${name}`)),
};

let encoder: Promise<typeof import("@jsquash/jpeg/encode.js").default> | null = null;
let decoder: Promise<typeof import("@jsquash/jpeg/decode.js").default> | null = null;

// One place each glue module is imported from, so warming it up (see
// prepareJpeg) loads the same chunks a real run does.
const encodeModule = () => import("@jsquash/jpeg/encode.js");
const decodeModule = () => import("@jsquash/jpeg/decode.js");
// pdf.js's own JPEG decoder (Apache-2.0) for four-component (CMYK/YCCK)
// JPEGs, which MozJPEG's decoder can't return as samples.
type JpegImage = { width: number; height: number; numComponents: number; parse(b: Uint8Array): void; getData(o: { width: number; height: number; isSourcePDF?: boolean }): Uint8Array | Uint8ClampedArray };
const pdfjsDecoders = () =>
  // @ts-expect-error -- pdfjs-dist ships no typings for its image decoders
  import("pdfjs-dist/image_decoders/pdf.image_decoders.mjs") as Promise<{ JpegImage: new (o?: { colorTransform?: number }) => JpegImage }>;

const getEncoder = () =>
  (encoder ??= (async () => {
    const mod = await encodeModule();
    await mod.init(await wasm.load("mozjpeg_enc.wasm"));
    return mod.default;
  })());

const getDecoder = () =>
  (decoder ??= (async () => {
    const mod = await decodeModule();
    await mod.init(await wasm.load("mozjpeg_dec.wasm"));
    return mod.default;
  })());

export async function encodeJpeg(p: Pixels & { ch: 1 | 3 }, quality: number): Promise<Uint8Array> {
  const encode = await getEncoder();
  const buf = await encode(toRGBA(p) as ImageData, {
    quality,
    // 1 = greyscale, 3 = YCbCr (see MozJpegColorSpace).
    color_space: p.ch === 1 ? 1 : 3,
    progressive: true,
    optimize_coding: true,
    trellis_multipass: true,
    trellis_opt_zero: true,
    trellis_opt_table: true,
  });
  return new Uint8Array(buf);
}

// Returns RGB pixels, or grey when the JPEG has one component.
export async function decodeJpeg(bytes: Uint8Array): Promise<Pixels> {
  const decode = await getDecoder();
  const img = await decode(bytes.slice().buffer);
  return fromRGBA(img, jpegComponents(bytes) === 1 ? 1 : 3);
}

// CMYK samples of a four-component JPEG, as stored (YCCK converted to CMYK,
// Adobe's inversion left for the PDF's /Decode to undo).
export async function decodeJpegCmyk(bytes: Uint8Array): Promise<Pixels | null> {
  const { JpegImage } = await pdfjsDecoders();
  const img = new JpegImage();
  img.parse(bytes);
  if (img.numComponents !== 4) return null;
  const data = img.getData({ width: img.width, height: img.height, isSourcePDF: true });
  return { w: img.width, h: img.height, ch: 4, data: data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

// Number of colour components from the JPEG's frame header; 0 if not found.
export function jpegComponents(b: Uint8Array): number {
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) return 0;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return b[i + 9];
    i += 2 + len;
  }
  return 0;
}

// Loads the encoder and decoder code without starting them (src/lib/offline.ts).
export const prepareJpeg = () => Promise.all([encodeModule(), decodeModule(), pdfjsDecoders()]);
