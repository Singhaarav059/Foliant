// A compact sRGB ICC v2 display profile, built in code for the PDF/A output
// intent: D50-adapted sRGB primaries and a 1024-point sRGB tone curve.

const D50 = [0.9642, 1.0, 0.8249];
const PRIMARIES = {
  rXYZ: [0.4360747, 0.2225045, 0.0139322],
  gXYZ: [0.3850649, 0.7168786, 0.0971045],
  bXYZ: [0.1430804, 0.0606169, 0.7141733],
};

class Writer {
  bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 255); }
  u16(v: number) { this.u8(v >> 8); this.u8(v); }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  s15(v: number) { this.u32(Math.round(v * 65536) | 0); }
  sig(s: string) { for (const ch of s) this.u8(ch.charCodeAt(0)); }
  pad() { while (this.bytes.length % 4) this.u8(0); }
}

function xyzTag(v: number[]) {
  const w = new Writer();
  w.sig("XYZ ");
  w.u32(0);
  v.forEach((n) => w.s15(n));
  return w.bytes;
}

function textTag(s: string) {
  const w = new Writer();
  w.sig("text");
  w.u32(0);
  w.sig(s);
  w.u8(0);
  return w.bytes;
}

function descTag(s: string) {
  const w = new Writer();
  w.sig("desc");
  w.u32(0);
  w.u32(s.length + 1);
  w.sig(s);
  w.u8(0);
  w.u32(0); // unicode language
  w.u32(0); // unicode count
  w.u16(0); // scriptcode code
  w.u8(0); // scriptcode count
  for (let i = 0; i < 67; i++) w.u8(0);
  return w.bytes;
}

function curveTag() {
  const w = new Writer();
  w.sig("curv");
  w.u32(0);
  const n = 1024;
  w.u32(n);
  for (let i = 0; i < n; i++) {
    const v = i / (n - 1);
    const lin = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    w.u16(Math.round(lin * 65535));
  }
  return w.bytes;
}

let cached: Uint8Array | null = null;

export function srgbProfile(): Uint8Array {
  if (cached) return cached;
  const curve = curveTag();
  const tags: [string, number[]][] = [
    ["desc", descTag("sRGB IEC61966-2.1")],
    ["cprt", textTag("No copyright, use freely")],
    ["wtpt", xyzTag(D50)],
    ["rXYZ", xyzTag(PRIMARIES.rXYZ)],
    ["gXYZ", xyzTag(PRIMARIES.gXYZ)],
    ["bXYZ", xyzTag(PRIMARIES.bXYZ)],
    ["rTRC", curve],
    ["gTRC", curve],
    ["bTRC", curve],
  ];
  const tableSize = 4 + tags.length * 12;
  const offset = 128 + tableSize;
  const data = new Writer();
  const entries: { sig: string; off: number; size: number }[] = [];
  let curveOffset = -1;
  for (const [sig, bytes] of tags) {
    // The three TRC tags share one data block.
    if (bytes === curve && curveOffset >= 0) {
      entries.push({ sig, off: curveOffset, size: bytes.length });
      continue;
    }
    while ((offset + data.bytes.length) % 4) data.u8(0);
    const off = offset + data.bytes.length;
    if (bytes === curve) curveOffset = off;
    entries.push({ sig, off, size: bytes.length });
    bytes.forEach((b) => data.u8(b));
  }
  data.pad();
  const total = 128 + tableSize + data.bytes.length;

  const h = new Writer();
  h.u32(total);
  h.u32(0); // preferred CMM
  h.u32(0x02100000); // version 2.1
  h.sig("mntr");
  h.sig("RGB ");
  h.sig("XYZ ");
  [2026, 1, 1, 0, 0, 0].forEach((v) => h.u16(v));
  h.sig("acsp");
  h.u32(0); // platform
  h.u32(0); // flags
  h.u32(0); // manufacturer
  h.u32(0); // model
  h.u32(0); h.u32(0); // attributes
  h.u32(0); // perceptual intent
  D50.forEach((v) => h.s15(v));
  h.u32(0); // creator
  while (h.bytes.length < 128) h.u8(0);
  h.u32(tags.length);
  for (const e of entries) {
    h.sig(e.sig);
    h.u32(e.off);
    h.u32(e.size);
  }
  cached = new Uint8Array([...h.bytes, ...data.bytes]);
  return cached;
}
