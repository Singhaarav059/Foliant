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

const getEncoder = () =>
  (encoder ??= (async () => {
    const mod = await import("@jsquash/jpeg/encode.js");
    await mod.init(await wasm.load("mozjpeg_enc.wasm"));
    return mod.default;
  })());

const getDecoder = () =>
  (decoder ??= (async () => {
    const mod = await import("@jsquash/jpeg/decode.js");
    await mod.init(await wasm.load("mozjpeg_dec.wasm"));
    return mod.default;
  })());

export async function encodeJpeg(p: Pixels, quality: number): Promise<Uint8Array> {
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
