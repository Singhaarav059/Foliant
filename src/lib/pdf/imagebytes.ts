// Byte-level checks and clean-ups for image files, kept free of DOM and
// library imports so Node can test them directly.

// Most pages a TIFF may have. A scanner's multi-page file has tens; a crafted
// one can claim millions.
export const TIFF_MAX_PAGES = 1000;

// Bytes per value of each TIFF field type (1–13); 0 for unknown types.
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

// Whether a TIFF's chain of image directories (IFDs) is safe to hand to
// UTIF.decode, which follows it without noticing a loop and fills memory
// until the tab dies. The chain must end, never revisit a directory, stay
// inside the file and hold at most TIFF_MAX_PAGES directories; no field may
// claim more values than the file has bytes (UTIF would allocate them all).
export function tiffChainOk(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return false;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (view.getUint16(2, le) !== 42) return false; // BigTIFF (43) isn't read by UTIF
  const seen = new Set<number>();
  let off = view.getUint32(4, le);
  for (let count = 0; off !== 0; count++) {
    if (seen.has(off) || count >= TIFF_MAX_PAGES || off + 2 > b.length) return false;
    seen.add(off);
    const n = view.getUint16(off, le);
    const end = off + 2 + n * 12;
    if (end + 4 > b.length) return false;
    for (let e = off + 2; e < end; e += 12) {
      const size = TIFF_TYPE_SIZE[view.getUint16(e + 2, le)] ?? 0;
      if (size && view.getUint32(e + 4, le) * size > b.length) return false;
    }
    off = view.getUint32(end, le);
  }
  return seen.size > 0;
}

// Decodes one TIFF directory to RGBA and lets go of UTIF's own copy of the
// raster, which decodeImage keeps on the directory for as long as it lives:
// without this, every page of a multi-page file stays in memory to the end.
type Utif = {
  decodeImage(buffer: ArrayBuffer, ifd: object): void;
  toRGBA8(ifd: object): Uint8Array;
};
export function tiffRaster(UTIF: Utif, buffer: ArrayBuffer, ifd: object): Uint8Array {
  try {
    UTIF.decodeImage(buffer, ifd);
    return UTIF.toRGBA8(ifd);
  } finally {
    delete (ifd as { data?: unknown }).data;
  }
}

// A JPEG without the metadata a camera or phone writes: EXIF (GPS position,
// camera serial, thumbnail), XMP, IPTC, maker notes and comments. Kept: JFIF
// (APP0), the ICC colour profile (APP2 "ICC_PROFILE") and Adobe's colour
// transform (APP14), which change how the pixels look. The image data is
// copied byte for byte. A file whose markers can't be followed is returned
// as it is.
export function stripJpegMetadata(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const keep: [number, number][] = [[0, 2]];
  let dropped = false;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { keep.push([i, i + 2]); i += 2; continue; }
    if (m === 0xd9) return b; // end of image before any scan
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return b;
    if (m === 0xda) {
      keep.push([i, b.length]); // the scan and everything after it
      break;
    }
    const app = m >= 0xe0 && m <= 0xef;
    const icc = m === 0xe2 && String.fromCharCode(...b.subarray(i + 4, i + 16)) === "ICC_PROFILE\0";
    if ((app && m !== 0xe0 && m !== 0xee && !icc) || m === 0xfe) dropped = true;
    else keep.push([i, i + 2 + len]);
    i += 2 + len;
  }
  if (i + 4 > b.length) return b;
  if (!dropped) return b;
  const out = new Uint8Array(keep.reduce((s, [a, z]) => s + z - a, 0));
  let o = 0;
  for (const [a, z] of keep) {
    out.set(b.subarray(a, z), o);
    o += z - a;
  }
  return out;
}
