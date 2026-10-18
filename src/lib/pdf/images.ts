"use client";

// Reads the images Images → PDF and Scan accept, in every browser:
//  JPEG             kept as it is (no re-encoding), with its EXIF orientation
//                   applied when it's drawn on the page
//  TIFF             UTIF.js (MIT), one image per page of the file
//  HEIC/HEIF        the browser where it can (Safari), else libheif (LGPL-3.0)
//                   in a worker, loaded from /vendor/…/heif/ only when needed
//  SVG              drawn at a high resolution through an <img>, which never
//                   fetches anything the SVG links to
//  PNG, WebP, AVIF, GIF, BMP   the browser's own decoder
// Anything the browser can't read becomes an "image_unsupported" error.

import { VENDOR } from "../vendor";
import { bytesOf, canvasToBlob } from "./common";
import { PdfError, toPdfError } from "./errors";

// One image ready for pdf-lib. `width`/`height` are the pixels as they show,
// `points` the size at the image's resolution (96 DPI unless the file says),
// `orientation` the EXIF orientation still to apply to `bytes` (1: none).
export type PdfImage = {
  bytes: Uint8Array;
  kind: "jpg" | "png";
  width: number;
  height: number;
  points: [number, number];
  orientation: number;
};

type Kind = "jpeg" | "png" | "tiff" | "heif" | "avif" | "svg" | "other";

// By content where it can, as file names and types are often wrong.
async function kindOf(blob: Blob): Promise<Kind> {
  const b = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") return "tiff";
  if (ascii(4, 8) === "ftyp") {
    // The major brand, then the compatible ones.
    const size = Math.min(b.length, (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]);
    const brands = [ascii(8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, i + 4));
    if (brands.some((x) => x === "avif" || x === "avis")) return "avif";
    if (brands.some((x) => /^(hei[cxms]|hev[cxms]|mif[12]|msf1)$/.test(x))) return "heif";
  }
  const name = (blob as File).name ?? "";
  if (blob.type === "image/svg+xml" || /\.svgz?$/i.test(name) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(svg|!DOCTYPE svg)/i.test(ascii(0, 64))) return "svg";
  return "other";
}

const unsupported = (blob: Blob, cause?: unknown) => new PdfError("image_unsupported", (blob as File).name ?? "", cause);

// ── JPEG: size and EXIF orientation from the markers, without decoding.
export function jpegInfo(b: Uint8Array): { width: number; height: number; components: number; orientation: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && String.fromCharCode(...b.subarray(i + 4, i + 10)) === "Exif\0\0") {
      orientation = exifOrientation(b.subarray(i + 10, i + 2 + len)) ?? orientation;
    }
    // Start of frame (not DHT, JPG or DAC, which share the range).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 10 > b.length) return null;
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], components: b[i + 9], orientation };
    }
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

// Tag 0x0112 of IFD0 in an EXIF (TIFF-structured) block.
function exifOrientation(t: Uint8Array): number | null {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => view.getUint16(o, le);
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > t.length) return null;
  for (let n = u16(ifd), e = ifd + 2; n > 0 && e + 12 <= t.length; n--, e += 12) {
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

// Where pixel (x, y) of an image stored with EXIF orientation `o` shows, as a
// canvas transform. 5–8 swap width and height; `w`/`h` are the shown size.
export function orientationTransform(o: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2: return [-1, 0, 0, 1, w, 0];
    case 3: return [-1, 0, 0, -1, w, h];
    case 4: return [1, 0, 0, -1, 0, h];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, w, 0];
    case 7: return [0, -1, -1, 0, w, h];
    case 8: return [0, -1, 1, 0, 0, h];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

// The PDF matrix that draws an image XObject (the unit square, its top row
// at v = 1) stored with EXIF orientation `o` upright into the box at (x, y),
// w × h points. `sw`/`sh` are the stored pixel size.
export function pdfImageMatrix(o: number, sw: number, sh: number, x: number, y: number, w: number, h: number): [number, number, number, number, number, number] {
  const [dw, dh] = o >= 5 ? [sh, sw] : [sw, sh];
  const [a, b, c, d, e, f] = orientationTransform(o, dw, dh);
  // Stored pixel → shown pixel → page point.
  const at = (px: number, py: number): [number, number] => {
    const sx = a * px + c * py + e;
    const sy = b * px + d * py + f;
    return [x + (sx / dw) * w, y + (1 - sy / dh) * h];
  };
  const origin = at(0, sh); // u = 0, v = 0: the stored image's bottom left
  const u = at(sw, sh);
  const v = at(0, 0);
  return [u[0] - origin[0], u[1] - origin[1], v[0] - origin[0], v[1] - origin[1], origin[0], origin[1]];
}

// ── HEIC/HEIF through libheif, in a worker kept for a while between files.
type Heif = { worker: Worker; jobs: Map<number, { resolve: (d: ImageData) => void; reject: (e: unknown) => void }>; next: number; idle?: ReturnType<typeof setTimeout> };
let heif: Heif | null = null;

function decodeHeif(buffer: ArrayBuffer): Promise<ImageData> {
  if (!heif) {
    const worker = new Worker(`${VENDOR}heif/worker.js`);
    const state: Heif = { worker, jobs: new Map(), next: 0 };
    const finish = () => {
      if (state.jobs.size) return;
      clearTimeout(state.idle);
      state.idle = setTimeout(() => {
        worker.terminate();
        if (heif === state) heif = null;
      }, 30_000);
    };
    worker.onmessage = ({ data }: MessageEvent<{ id: number; width: number; height: number; data: ArrayBuffer; error?: string }>) => {
      const job = state.jobs.get(data.id);
      state.jobs.delete(data.id);
      if (data.error) job?.reject(new Error(data.error));
      else job?.resolve(new ImageData(new Uint8ClampedArray(data.data), data.width, data.height));
      finish();
    };
    // The worker or libheif failed to load.
    worker.onerror = (e) => {
      e.preventDefault();
      for (const job of state.jobs.values()) job.reject(new Error(`Failed to fetch the HEIC decoder: ${e.message}`));
      worker.terminate();
      if (heif === state) heif = null;
    };
    heif = state;
  }
  const state = heif;
  clearTimeout(state.idle);
  const id = state.next++;
  return new Promise((resolve, reject) => {
    state.jobs.set(id, { resolve, reject });
    state.worker.postMessage({ id, buffer }, [buffer]);
  });
}

// ── TIFF through UTIF.js.
async function* tiffPages(blob: Blob): AsyncGenerator<{ image: ImageBitmap; dpi: [number, number]; lossless: boolean }> {
  const mod = await import("utif2");
  const UTIF = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof mod;
  const buffer = await blob.arrayBuffer();
  let ifds: ReturnType<typeof UTIF.decode>;
  try {
    ifds = UTIF.decode(buffer);
  } catch (e) {
    throw unsupported(blob, e);
  }
  const tag = (ifd: (typeof ifds)[number], t: number) => {
    // Rationals come as [numerator, denominator].
    const v = (ifd[`t${t}`] as (number | number[])[] | undefined)?.[0];
    const n = Array.isArray(v) ? v[0] / v[1] : v;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  };
  // Reduced-resolution copies (thumbnails) aren't pages.
  const pages = ifds.filter((ifd) => !((tag(ifd, 254) ?? 0) & 1));
  if (!pages.length) throw unsupported(blob);
  for (const ifd of pages) {
    let rgba: Uint8Array;
    try {
      UTIF.decodeImage(buffer, ifd);
      rgba = UTIF.toRGBA8(ifd);
    } catch (e) {
      throw unsupported(blob, e);
    }
    const { width, height } = ifd;
    if (!width || !height || rgba.length < width * height * 4) throw unsupported(blob);
    const raw = await createImageBitmap(new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, width * height * 4), width, height));
    const image = await upright(raw, tag(ifd, 274) ?? 1);
    // Resolution: inches (2, the default) or centimetres (3). None, or an
    // implausible one (libvips writes 25.4 when it has none), means 96 DPI.
    const unit = tag(ifd, 296) ?? 2;
    const per = unit === 3 ? 2.54 : unit === 2 ? 1 : 0;
    const rx = (tag(ifd, 282) ?? 0) * per;
    const ry = (tag(ifd, 283) ?? tag(ifd, 282) ?? 0) * per;
    const dpi: [number, number] = rx >= 50 && ry >= 50 && rx <= 4800 && ry <= 4800 ? ((tag(ifd, 274) ?? 1) >= 5 ? [ry, rx] : [rx, ry]) : [96, 96];
    // One sample per pixel (bilevel or grey scans) stays lossless.
    yield { image, dpi, lossless: (tag(ifd, 277) ?? 1) === 1 };
  }
}

// A bitmap turned the way EXIF orientation `o` says.
async function upright(bmp: ImageBitmap, o: number): Promise<ImageBitmap> {
  if (o < 2 || o > 8) return bmp;
  const [w, h] = o >= 5 ? [bmp.height, bmp.width] : [bmp.width, bmp.height];
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(...orientationTransform(o, w, h));
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return createImageBitmap(canvas);
}

// ── SVG, drawn by the browser at up to 4096 px on the long side.
async function svgImage(blob: Blob): Promise<{ image: ImageBitmap; points: [number, number] }> {
  const url = URL.createObjectURL(blob.type === "image/svg+xml" ? blob : new Blob([blob], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch (e) {
      throw unsupported(blob, e);
    }
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (!w || !h) {
      // No width and height: the viewBox's proportions, at 300 px wide.
      const box = /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(await blob.slice(0, 4096).text());
      const [bw, bh] = box ? [Number(box[1]), Number(box[2])] : [300, 150];
      [w, h] = bw > 0 && bh > 0 ? [300, (300 * bh) / bw] : [300, 150];
    }
    const scale = Math.min(4096 / Math.max(w, h), Math.max(1, 2400 / Math.max(w, h)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { image: await createImageBitmap(canvas), points: [w * 0.75, h * 0.75] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function browserDecode(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch (e) {
    throw toPdfError(e, (blob as File).name ?? "");
  }
}

async function heifImage(blob: Blob): Promise<ImageBitmap> {
  // Safari decodes HEIC itself.
  try {
    return await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    // libheif below.
  }
  let data: ImageData;
  try {
    data = await decodeHeif(await blob.arrayBuffer());
  } catch (e) {
    const err = toPdfError(e, (blob as File).name ?? "");
    throw err.code === "download_failed" || err.code === "out_of_memory" ? err : unsupported(blob, e);
  }
  return createImageBitmap(data);
}

type Frame = { image: ImageBitmap; points?: [number, number]; dpi?: [number, number]; lossless: boolean };

// Every image in a file, upright, one at a time (a TIFF can hold hundreds).
async function* frames(blob: Blob, kind: Kind): AsyncGenerator<Frame> {
  if (kind === "tiff") yield* tiffPages(blob);
  else if (kind === "svg") yield { ...(await svgImage(blob)), lossless: true };
  else if (kind === "heif") yield { image: await heifImage(blob), lossless: false };
  else yield { image: await browserDecode(blob), lossless: kind === "png" };
}

// The first image of a file, upright (Scan's filters).
export async function loadImage(blob: Blob): Promise<ImageBitmap> {
  const kind = await kindOf(blob);
  for await (const f of frames(blob, kind)) return f.image;
  throw unsupported(blob);
}

// Every image in a file as JPEG or PNG bytes pdf-lib can embed.
// `upright`: never leave an orientation to apply (callers that can't turn it).
export async function* pdfImages(file: Blob, o: { upright?: boolean } = {}): AsyncGenerator<PdfImage> {
  const kind = await kindOf(file);
  if (kind === "jpeg") {
    const bytes = await bytesOf(file);
    const info = jpegInfo(bytes);
    // CMYK JPEGs go through the browser, which knows Adobe's inverted CMYK.
    if (info && info.width && info.height && (info.components === 1 || info.components === 3) && !(o.upright && info.orientation !== 1)) {
      // Decoded once, so a broken file fails here rather than in the PDF.
      (await browserDecode(file)).close();
      const swap = info.orientation >= 5;
      const [width, height] = swap ? [info.height, info.width] : [info.width, info.height];
      yield { bytes, kind: "jpg", width, height, points: [width * 0.75, height * 0.75], orientation: info.orientation };
      return;
    }
  }
  for await (const f of frames(file, kind)) {
    const { image, lossless } = f;
    const { width, height } = image;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    if (!lossless) {
      // JPEG has no transparency: show it on white, as on the page.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(image, 0, 0);
    image.close();
    const blob = await canvasToBlob(canvas, lossless ? "image/png" : "image/jpeg", 0.92);
    canvas.width = canvas.height = 0;
    const points: [number, number] = f.points ?? (f.dpi ? [(width * 72) / f.dpi[0], (height * 72) / f.dpi[1]] : [width * 0.75, height * 0.75]);
    yield { bytes: await bytesOf(blob), kind: lossless ? "png" : "jpg", width, height, points, orientation: 1 };
  }
}
