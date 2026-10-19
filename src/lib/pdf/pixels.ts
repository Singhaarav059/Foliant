// Raw image pixels for Compress: PNG predictors, resampling, palettes.
// Plain arrays, no canvas, so it runs anywhere and gives the same bytes everywhere.

// Packed 8-bit samples: grey, RGB or CMYK, no alpha.
export type Pixels = { w: number; h: number; ch: 1 | 3 | 4; data: Uint8Array };

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

export function toRGBA(p: Pixels & { ch: 1 | 3 }) {
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

// ── Sample formats: packed bits, 16-bit, palettes, inverted /Decode, CMYK.

// Rows of `comps` samples at 1, 2, 4, 8 or 16 bits (each row starts on a byte)
// as 8-bit samples. 16-bit keeps the high byte; 1-, 2- and 4-bit samples
// are scaled to 0–255 unless `raw` (palette indices stay indices).
export function unpack(src: Uint8Array, w: number, h: number, comps: number, bpc: number, raw = false): Uint8Array | null {
  const rowBytes = Math.ceil((w * comps * bpc) / 8);
  if (src.length < rowBytes * h) return null;
  const n = w * comps;
  const out = new Uint8Array(n * h);
  if (bpc === 8) {
    for (let y = 0; y < h; y++) out.set(src.subarray(y * rowBytes, y * rowBytes + n), y * n);
  } else if (bpc === 16) {
    for (let y = 0; y < h; y++) for (let i = 0; i < n; i++) out[y * n + i] = src[y * rowBytes + i * 2];
  } else if (bpc === 1 || bpc === 2 || bpc === 4) {
    const max = (1 << bpc) - 1;
    const scale = raw ? 1 : 255 / max;
    for (let y = 0; y < h; y++)
      for (let i = 0; i < n; i++) {
        const bit = i * bpc;
        out[y * n + i] = ((src[y * rowBytes + (bit >> 3)] >> (8 - bpc - (bit & 7))) & max) * scale;
      }
  } else return null;
  return out;
}

// Palette indices to colours; out-of-range indices clamp to the last entry, as viewers do.
export function expandPalette(idx: Uint8Array, w: number, h: number, lookup: Uint8Array, ch: 1 | 3 | 4): Pixels {
  const last = Math.max(0, Math.floor(lookup.length / ch) - 1);
  const data = new Uint8Array(w * h * ch);
  for (let i = 0; i < w * h; i++) {
    const k = Math.min(idx[i], last) * ch;
    for (let c = 0; c < ch; c++) data[i * ch + c] = lookup[k + c] ?? 0;
  }
  return { w, h, ch, data };
}

// /Decode [1 0 ...]: samples stored inverted (Adobe's CMYK JPEGs, some scans).
export function invert(p: Pixels): Pixels {
  const data = new Uint8Array(p.data.length);
  for (let i = 0; i < data.length; i++) data[i] = 255 - p.data[i];
  return { ...p, data };
}

// DeviceCMYK to sRGB with the polynomial fit to US Web Coated (SWOP) that
// pdf.js uses for DeviceCMYK (Apache-2.0, src/core/colorspace.js), so the
// result matches what the app's own preview showed.
export function cmykToRgb(p: Pixels): Pixels {
  const n = p.w * p.h;
  const out = new Uint8Array(n * 3);
  const s = p.data;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let i = 0; i < n; i++) {
    const c = s[i * 4] / 255, m = s[i * 4 + 1] / 255, y = s[i * 4 + 2] / 255, k = s[i * 4 + 3] / 255;
    out[i * 3] = clamp(255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747));
    out[i * 3 + 1] = clamp(255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578));
    out[i * 3 + 2] = clamp(255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367));
  }
  return { w: p.w, h: p.h, ch: 3, data: out };
}

// RGB images whose channels never differ by more than a step are grey.
export function asGray(p: Pixels): Pixels | null {
  if (p.ch === 1) return p;
  if (p.ch !== 3) return null;
  const out = new Uint8Array(p.w * p.h);
  for (let i = 0, q = 0; i < out.length; i++, q += 3) {
    const r = p.data[q], g = p.data[q + 1], b = p.data[q + 2];
    if (Math.abs(r - g) > 2 || Math.abs(g - b) > 2 || Math.abs(r - b) > 2) return null;
    out[i] = Math.round((r + g + b) / 3);
  }
  return { w: p.w, h: p.h, ch: 1, data: out };
}

// RGB as grey by Rec. 601 luma, for Compress to a size's greyscale step.
export function luma(p: Pixels): Pixels {
  const out = new Uint8Array(p.w * p.h);
  for (let i = 0, q = 0; i < out.length; i++, q += 3) out[i] = Math.round(0.299 * p.data[q] + 0.587 * p.data[q + 1] + 0.114 * p.data[q + 2]);
  return { w: p.w, h: p.h, ch: 1, data: out };
}

// Images with few colours (charts, screenshots, logos) as palette indices,
// packed at 1, 2, 4 or 8 bits. Lossless.
export function palette(p: Pixels, max = 256): { colors: Uint8Array; bits: 1 | 2 | 4 | 8; data: Uint8Array } | null {
  if (p.ch === 4) return null;
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
