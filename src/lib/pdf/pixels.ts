// Raw image pixels for Compress: PNG predictors, resampling, palettes.
// Plain arrays, no canvas, so it runs anywhere and gives the same bytes everywhere.

// Packed 8-bit samples, one or three channels, no alpha.
export type Pixels = { w: number; h: number; ch: 1 | 3; data: Uint8Array };

export function fromRGBA(rgba: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }, ch: 1 | 3): Pixels {
  const { width: w, height: h, data } = rgba;
  const out = new Uint8Array(w * h * ch);
  for (let p = 0, q = 0; p < w * h; p++, q += ch) {
    out[q] = data[p * 4];
    if (ch === 3) {
      out[q + 1] = data[p * 4 + 1];
      out[q + 2] = data[p * 4 + 2];
    }
  }
  return { w, h, ch, data: out };
}

export function toRGBA(p: Pixels) {
  const data = new Uint8ClampedArray(p.w * p.h * 4);
  for (let i = 0, q = 0; i < p.w * p.h; i++, q += p.ch) {
    data[i * 4] = p.data[q];
    data[i * 4 + 1] = p.data[q + (p.ch === 3 ? 1 : 0)];
    data[i * 4 + 2] = p.data[q + (p.ch === 3 ? 2 : 0)];
    data[i * 4 + 3] = 255;
  }
  return { width: p.w, height: p.h, data, colorSpace: "srgb" as const };
}

// ── PNG predictors (PDF Predictor 10–15): a filter-type byte starts each row.

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function unpredictPng(src: Uint8Array, rowBytes: number, bpp: number, rows: number): Uint8Array | null {
  const out = new Uint8Array(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const s = y * (rowBytes + 1);
    if (s + rowBytes >= src.length + 1) return null;
    const type = src[s];
    const o = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = src[s + 1 + x];
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[o - rowBytes + x] : 0;
      const c = x >= bpp && y > 0 ? out[o - rowBytes + x - bpp] : 0;
      out[o + x] = (raw + (type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : 0)) & 255;
    }
  }
  return out;
}

// Picks each row's filter by the smallest sum of absolute differences (libpng's heuristic).
export function predictPng(src: Uint8Array, rowBytes: number, bpp: number, rows: number): Uint8Array {
  const out = new Uint8Array((rowBytes + 1) * rows);
  const trial = new Uint8Array(rowBytes);
  for (let y = 0; y < rows; y++) {
    const o = y * rowBytes;
    let bestScore = Infinity;
    for (let type = 0; type <= 4; type++) {
      let score = 0;
      for (let x = 0; x < rowBytes; x++) {
        const v = src[o + x];
        const a = x >= bpp ? src[o + x - bpp] : 0;
        const b = y > 0 ? src[o - rowBytes + x] : 0;
        const c = x >= bpp && y > 0 ? src[o - rowBytes + x - bpp] : 0;
        const f = (v - (type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : type === 4 ? paeth(a, b, c) : 0)) & 255;
        trial[x] = f;
        score += f < 128 ? f : 256 - f;
        if (score >= bestScore) break;
      }
      if (score < bestScore) {
        bestScore = score;
        out[y * (rowBytes + 1)] = type;
        out.set(trial, y * (rowBytes + 1) + 1);
      }
    }
  }
  return out;
}

// ── Resampling: area averaging, the right filter for shrinking.

export function resample(p: Pixels, nw: number, nh: number): Pixels {
  if (nw === p.w && nh === p.h) return p;
  const { w, h, ch, data } = p;
  const out = new Uint8Array(nw * nh * ch);
  const sx = w / nw;
  const sy = h / nh;
  const acc = new Float64Array(nw * ch);
  for (let ny = 0; ny < nh; ny++) {
    acc.fill(0);
    const y0 = ny * sy;
    const y1 = y0 + sy;
    for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      for (let nx = 0; nx < nw; nx++) {
        const x0 = nx * sx;
        const x1 = x0 + sx;
        for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
          const wgt = (Math.min(x + 1, x1) - Math.max(x, x0)) * wy;
          const i = (y * w + x) * ch;
          for (let c = 0; c < ch; c++) acc[nx * ch + c] += data[i + c] * wgt;
        }
      }
    }
    const area = sx * sy;
    for (let k = 0; k < nw * ch; k++) out[ny * nw * ch + k] = Math.round(acc[k] / area);
  }
  return { w: nw, h: nh, ch, data: out };
}

// RGB images whose channels never differ by more than a step are grey.
export function asGray(p: Pixels): Pixels | null {
  if (p.ch === 1) return p;
  const out = new Uint8Array(p.w * p.h);
  for (let i = 0, q = 0; i < out.length; i++, q += 3) {
    const r = p.data[q], g = p.data[q + 1], b = p.data[q + 2];
    if (Math.abs(r - g) > 2 || Math.abs(g - b) > 2 || Math.abs(r - b) > 2) return null;
    out[i] = Math.round((r + g + b) / 3);
  }
  return { w: p.w, h: p.h, ch: 1, data: out };
}

// Images with few colours (charts, screenshots, logos) as palette indices,
// packed at 1, 2, 4 or 8 bits. Lossless.
export function palette(p: Pixels, max = 256): { colors: Uint8Array; bits: 1 | 2 | 4 | 8; data: Uint8Array } | null {
  const index = new Map<number, number>();
  const n = p.w * p.h;
  const idx = new Uint8Array(n);
  for (let i = 0, q = 0; i < n; i++, q += p.ch) {
    const key = p.ch === 3 ? (p.data[q] << 16) | (p.data[q + 1] << 8) | p.data[q + 2] : p.data[q];
    let k = index.get(key);
    if (k === undefined) {
      if (index.size >= max) return null;
      k = index.size;
      index.set(key, k);
    }
    idx[i] = k;
  }
  const colors = new Uint8Array(index.size * p.ch);
  for (const [key, k] of index) {
    if (p.ch === 3) colors.set([key >> 16, (key >> 8) & 255, key & 255], k * 3);
    else colors[k] = key;
  }
  const bits = index.size <= 2 ? 1 : index.size <= 4 ? 2 : index.size <= 16 ? 4 : 8;
  if (bits === 8) return { colors, bits, data: idx };
  const rowBytes = Math.ceil((p.w * bits) / 8);
  const packed = new Uint8Array(rowBytes * p.h);
  const per = 8 / bits;
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++)
      packed[y * rowBytes + Math.floor(x / per)] |= idx[y * p.w + x] << (8 - bits * ((x % per) + 1));
  return { colors, bits, data: packed };
}
