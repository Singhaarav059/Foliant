// Page cleanup before OCR, the steps OCRmyPDF and Tesseract's own docs
// recommend: even out the background (phone photos, yellowed paper), turn
// sideways pages upright, and straighten slightly skewed scans. Each step
// keeps the transform so word boxes can be mapped back onto the original page.
// Plain arrays, no canvas: the same code runs in tests.

import { zlibSync } from "fflate";
import { predictPng, resample, type Pixels } from "./pixels";

export type Gray = { w: number; h: number; data: Uint8Array };

export function grayOf(rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }): Gray {
  const { width: w, height: h, data } = rgba;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8;
  return { w, h, data: out };
}

const shrink = (g: Gray, maxSide: number): Gray => {
  const s = Math.min(1, maxSide / Math.max(g.w, g.h));
  if (s === 1) return g;
  const p = resample({ ...g, ch: 1 } as Pixels, Math.max(1, Math.round(g.w * s)), Math.max(1, Math.round(g.h * s)));
  return { w: p.w, h: p.h, data: p.data };
};

// ── Background

// Divides by a smooth estimate of the paper colour, so shadows and tints
// become white and text keeps its contrast. Text is removed from the estimate
// by taking the brightest pixel of each block.
export function flattenBackground(g: Gray): Gray {
  const B = 24;
  const bw = Math.ceil(g.w / B);
  const bh = Math.ceil(g.h / B);
  const max = new Float32Array(bw * bh);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const k = Math.floor(y / B) * bw + Math.floor(x / B);
      if (g.data[y * g.w + x] > max[k]) max[k] = g.data[y * g.w + x];
    }
  // Blocks inside pictures or big dark areas take their neighbours' paper colour.
  const smooth = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      let best = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < bh && xx >= 0 && xx < bw) best = Math.max(best, max[yy * bw + xx]);
        }
      smooth[y * bw + x] = best;
    }
  const out = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < g.w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const bg =
        (smooth[y0 * bw + x0] * (1 - tx) + smooth[y0 * bw + x1] * tx) * (1 - ty) +
        (smooth[y1 * bw + x0] * (1 - tx) + smooth[y1 * bw + x1] * tx) * ty;
      out[y * g.w + x] = bg < 40 ? g.data[y * g.w + x] : Math.min(255, Math.round((g.data[y * g.w + x] * 255) / bg));
    }
  }
  return { w: g.w, h: g.h, data: out };
}

// ── Skew and orientation

function otsu(g: Gray) {
  const hist = new Float64Array(256);
  for (const v of g.data) hist[v]++;
  const total = g.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB || wB === total) continue;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / (total - wB);
    const between = wB * (total - wB) * (mB - mF) ** 2;
    if (between > best) [best, threshold] = [between, t];
  }
  return threshold;
}

// Coordinates of dark pixels on a small copy of the page.
function inkPoints(g: Gray) {
  const small = shrink(g, 1000);
  const t = otsu(small);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < small.h; y++)
    for (let x = 0; x < small.w; x++)
      if (small.data[y * small.w + x] < t) { xs.push(x); ys.push(y); }
  // Mostly-dark pages (photos) have no text lines to measure.
  const dense = xs.length > small.w * small.h * 0.4;
  return { xs, ys, w: small.w, h: small.h, dense };
}

// How sharply ink falls into rows at this angle: text lines give tall peaks and empty gaps.
function profileScore(xs: number[], ys: number[], angle: number, size: number, vertical = false) {
  const bins = new Float64Array(size * 3);
  const s = Math.sin(angle), c = Math.cos(angle);
  for (let i = 0; i < xs.length; i++) {
    const [x, y] = vertical ? [ys[i], xs[i]] : [xs[i], ys[i]];
    const b = Math.round(y * c - x * s) + size;
    if (b >= 0 && b < bins.length) bins[b]++;
  }
  let score = 0;
  for (let i = 1; i < bins.length; i++) score += (bins[i] - bins[i - 1]) ** 2;
  return score;
}

// Skew of the text lines in radians (positive: lines fall to the right), within ±6°.
export function estimateSkew(g: Gray): number {
  const { xs, ys, w, h, dense } = inkPoints(g);
  if (xs.length < 200 || dense) return 0;
  const size = Math.max(w, h);
  const deg = Math.PI / 180;
  let best = 0, bestScore = -1;
  for (let a = -6; a <= 6; a += 0.5) {
    const sc = profileScore(xs, ys, a * deg, size);
    if (sc > bestScore) [best, bestScore] = [a, sc];
  }
  const coarse = best;
  for (let a = coarse - 0.5; a <= coarse + 0.5; a += 0.1) {
    const sc = profileScore(xs, ys, a * deg, size);
    if (sc > bestScore) [best, bestScore] = [a, sc];
  }
  return best * deg;
}

// True when ink lines up in columns far better than in rows: the page is on its side.
// Each direction gets its best angle within ±6°, so a skewed page still reads as upright.
export function looksSideways(g: Gray): boolean {
  const { xs, ys, w, h, dense } = inkPoints(g);
  if (xs.length < 200 || dense) return false;
  const size = Math.max(w, h);
  const best = (vertical: boolean) => {
    let top = 0;
    for (let a = -6; a <= 6; a += 0.5) top = Math.max(top, profileScore(xs, ys, (a * Math.PI) / 180, size, vertical));
    return top;
  };
  return best(true) > best(false) * 1.6;
}

// ── Transforms

// Quarter turns clockwise.
export function rotate90(g: Gray, k: number): Gray {
  k = ((k % 4) + 4) % 4;
  if (!k) return g;
  const w = k === 2 ? g.w : g.h;
  const h = k === 2 ? g.h : g.w;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const v = g.data[y * g.w + x];
      if (k === 1) out[x * w + (g.h - 1 - y)] = v;
      else if (k === 2) out[(g.h - 1 - y) * w + (g.w - 1 - x)] = v;
      else out[(g.w - 1 - x) * w + y] = v;
    }
  return { w, h, data: out };
}

// Rotates by -angle about the centre (undoing a skew of `angle`), white outside, bilinear.
export function deskew(g: Gray, angle: number): Gray {
  if (!angle) return g;
  const out = new Uint8Array(g.w * g.h).fill(255);
  const cx = g.w / 2, cy = g.h / 2;
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const sx = cx + dx * c - dy * s - 0.5;
      const sy = cy + dx * s + dy * c - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= g.w || y0 + 1 >= g.h) continue;
      const tx = sx - x0, ty = sy - y0;
      const i = y0 * g.w + x0;
      out[y * g.w + x] = Math.round(
        (g.data[i] * (1 - tx) + g.data[i + 1] * tx) * (1 - ty) + (g.data[i + g.w] * (1 - tx) + g.data[i + g.w + 1] * tx) * ty,
      );
    }
  return { w: g.w, h: g.h, data: out };
}

// Maps a point in the prepared image back to the original render.
export type Unmap = (x: number, y: number) => [number, number];

export function unmapper(orig: { w: number; h: number }, turns: number, angle: number): Unmap {
  const k = ((turns % 4) + 4) % 4;
  const rw = k % 2 ? orig.h : orig.w;
  const rh = k % 2 ? orig.w : orig.h;
  const c = Math.cos(angle), s = Math.sin(angle);
  return (x, y) => {
    // Undo the deskew: rotate by +angle about the centre.
    const dx = x - rw / 2, dy = y - rh / 2;
    const rx = rw / 2 + dx * c - dy * s;
    const ry = rh / 2 + dx * s + dy * c;
    // Undo the quarter turns.
    if (k === 1) return [ry, orig.h - rx];
    if (k === 2) return [orig.w - rx, orig.h - ry];
    if (k === 3) return [orig.w - ry, rx];
    return [rx, ry];
  };
}

// ── PNG for Tesseract

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) crc = CRC[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}

export function grayPng(g: Gray): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, g.w);
  v.setUint32(4, g.h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const idat = zlibSync(predictPng(g.data, g.w, 1, g.h), { level: 1 });
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── Noise

// Standard deviation of the noise (Immerkær 1996: one pass of a Laplacian-difference kernel).
export function noiseLevel(g: Gray): number {
  let sum = 0;
  for (let y = 1; y < g.h - 1; y++)
    for (let x = 1; x < g.w - 1; x++) {
      const i = y * g.w + x, d = g.data;
      sum += Math.abs(
        d[i - g.w - 1] - 2 * d[i - g.w] + d[i - g.w + 1] - 2 * d[i - 1] + 4 * d[i] - 2 * d[i + 1] + d[i + g.w - 1] - 2 * d[i + g.w] + d[i + g.w + 1],
      );
    }
  return (Math.sqrt(Math.PI / 2) * sum) / (6 * (g.w - 2) * (g.h - 2));
}

// 3×3 median: removes speckle while keeping the edges of strokes.
export function median3(g: Gray): Gray {
  const out = new Uint8Array(g.data.length);
  const v = new Uint8Array(9);
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) v[k++] = g.data[Math.min(g.h - 1, Math.max(0, y + dy)) * g.w + Math.min(g.w - 1, Math.max(0, x + dx))];
      v.sort();
      out[y * g.w + x] = v[4];
    }
  return { w: g.w, h: g.h, data: out };
}
