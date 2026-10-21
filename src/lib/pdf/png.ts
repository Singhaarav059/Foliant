// PNG from raw pixels, without a canvas: grey or RGB, with an optional alpha
// channel. Extract images writes these, so a picture keeps its exact samples
// and its soft mask whatever the browser's canvas limits are.
import { zlibSync } from "fflate";
import { predictPng, type Pixels } from "./pixels";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 255] ^ (c >>> 8);
  v.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

// `alpha`: one byte a pixel, 255 opaque.
export function encodePng(p: Pixels & { ch: 1 | 3 }, alpha?: Uint8Array): Uint8Array {
  const ch = p.ch + (alpha ? 1 : 0);
  let data = p.data;
  if (alpha) {
    data = new Uint8Array(p.w * p.h * ch);
    for (let i = 0, o = 0, s = 0; i < p.w * p.h; i++) {
      for (let k = 0; k < p.ch; k++) data[o++] = p.data[s++];
      data[o++] = alpha[i];
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, p.w);
  v.setUint32(4, p.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = { 1: 0, 2: 4, 3: 2, 4: 6 }[ch]!; // grey, grey + alpha, RGB, RGBA
  const idat = zlibSync(predictPng(data, p.w * ch, ch, p.h), { level: 6 });
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}
