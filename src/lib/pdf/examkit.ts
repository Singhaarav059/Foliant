"use client";

// ── Exam photo and signature kit
// Application forms (exams, scholarships, KYC) want a photo or signature at
// exact pixel dimensions and inside a range of kilobytes. This crops (or
// pads) to the size, then finds the highest MozJPEG quality under the
// maximum. A simple image that stays under the minimum even at top quality
// is padded with a JPEG comment, which viewers ignore, and the result says
// so. The presets are examples only: each portal publishes its own rules.

import { baseName, type Output, type Progress } from "./common";
import { encodeJpeg } from "./jpeg";
import { fromRGBA, luma, resample, type Pixels } from "./pixels";

export type ExamSpec = { w: number; h: number; minKb: number; maxKb: number };

// Typical of what portals ask for; not any one portal's official rules.
export const EXAM_PRESETS = {
  photo: { w: 200, h: 230, minKb: 20, maxKb: 50 },
  signature: { w: 140, h: 60, minKb: 10, maxKb: 20 },
  // 35 x 45 mm at 300 dpi, the common passport-photo shape.
  passport: { w: 413, h: 531, minKb: 20, maxKb: 100 },
} satisfies Record<string, ExamSpec>;

export type Fit = "crop" | "pad";

// The middle of `p` at the aspect ratio of w x h ("crop"), or all of it on
// white ("pad"), resampled to exactly w x h.
function frame(p: Pixels & { ch: 1 | 3 }, w: number, h: number, fit: Fit): Pixels {
  if (fit === "crop") {
    const cw = Math.min(p.w, Math.round((p.h * w) / h));
    const chh = Math.min(p.h, Math.round((p.w * h) / w));
    const x0 = Math.floor((p.w - cw) / 2);
    const y0 = Math.floor((p.h - chh) / 2);
    const data = new Uint8Array(cw * chh * p.ch);
    for (let y = 0; y < chh; y++) data.set(p.data.subarray(((y0 + y) * p.w + x0) * p.ch, ((y0 + y) * p.w + x0 + cw) * p.ch), y * cw * p.ch);
    return resample({ w: cw, h: chh, ch: p.ch, data }, w, h);
  }
  const s = Math.min(w / p.w, h / p.h);
  const inner = resample(p, Math.max(1, Math.round(p.w * s)), Math.max(1, Math.round(p.h * s)));
  const data = new Uint8Array(w * h * p.ch).fill(255);
  const x0 = Math.floor((w - inner.w) / 2);
  const y0 = Math.floor((h - inner.h) / 2);
  for (let y = 0; y < inner.h; y++) data.set(inner.data.subarray(y * inner.w * p.ch, (y + 1) * inner.w * p.ch), ((y0 + y) * w + x0) * p.ch);
  return { w, h, ch: p.ch, data };
}

// Comment segments (FF FE) right after the start marker, adding `extra` bytes.
function pad(jpg: Uint8Array, extra: number): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let left = extra; left > 0; ) {
    // A segment holds at most 65,533 bytes of data, and needs at least 1.
    const n = Math.min(65533, Math.max(1, left - 4));
    const seg = new Uint8Array(4 + n).fill(0x20);
    seg.set([0xff, 0xfe, (n + 2) >> 8, (n + 2) & 0xff]);
    parts.push(seg);
    left -= seg.length;
  }
  const size = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(jpg.length + size);
  out.set(jpg.subarray(0, 2));
  let at = 2;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(jpg.subarray(2), at);
  return out;
}

// fits: inside the range. padded: brought up to the minimum with a comment.
// tooBig: over the maximum even at the lowest quality.
export type FitNote = "fits" | "padded" | "tooBig";

export async function fitImage(src: Pixels, o: ExamSpec & { fit: Fit; gray: boolean }): Promise<{ bytes: Uint8Array; quality: number; note: FitNote }> {
  const w = Math.max(1, Math.round(o.w));
  const h = Math.max(1, Math.round(o.h));
  const maxBytes = Math.floor(o.maxKb * 1024);
  const minBytes = Math.ceil(Math.min(o.minKb, o.maxKb) * 1024);
  let px = src.ch === 4 ? null : (src as Pixels & { ch: 1 | 3 });
  if (!px) throw new Error("CMYK pixels");
  if (o.gray && px.ch === 3) px = luma(px) as Pixels & { ch: 1 };
  const out = frame(px, w, h, o.fit) as Pixels & { ch: 1 | 3 };

  // The highest quality from 10 to 95 that fits under the maximum.
  const at = new Map<number, Uint8Array>();
  const enc = async (q: number) => at.get(q) ?? at.set(q, await encodeJpeg(out, q)).get(q)!;
  let lo = 10;
  let hi = 95;
  if ((await enc(lo)).length > maxBytes) return { bytes: at.get(lo)!, quality: lo, note: "tooBig" };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((await enc(mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const bytes = at.get(lo)!;
  if (bytes.length >= minBytes) return { bytes, quality: lo, note: "fits" };
  // Aim a little over the minimum, never past the maximum.
  const want = Math.min(maxBytes - 4, minBytes + 512);
  return { bytes: pad(bytes, want - bytes.length), quality: lo, note: "padded" };
}

// The spec an options panel describes: a preset, or custom numbers.
export function examSpec(o: { preset: string; w: number; h: number; minKb: number; maxKb: number }): ExamSpec {
  const preset = EXAM_PRESETS[o.preset as keyof typeof EXAM_PRESETS];
  return preset ?? { w: o.w, h: o.h, minKb: o.minKb, maxKb: o.maxKb };
}

// Browser side: every image file, upright and flattened on white, then fitted.
// Very large photos are first drawn at most four times the target size, which
// keeps memory low; the final resampling is fitImage's own.
// Notes: exam:{fits|padded|tooBig}:{w}:{h}:{bytes}:{minKb}:{maxKb}
export async function examKit(files: File[], o: { spec: ExamSpec; fit: Fit; gray: boolean }, progress?: Progress): Promise<Output[]> {
  const { loadImage } = await import("./images");
  const out: Output[] = [];
  for (let i = 0; i < files.length; i++) {
    const bmp = await loadImage(files[i]);
    const s = Math.min(1, (4 * Math.max(o.spec.w, o.spec.h)) / Math.min(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * s));
    canvas.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const px = fromRGBA(ctx.getImageData(0, 0, canvas.width, canvas.height), 3);
    canvas.width = canvas.height = 0;
    const r = await fitImage(px, { ...o.spec, fit: o.fit, gray: o.gray });
    out.push({
      name: `${baseName(files[i].name)}-${o.spec.w}x${o.spec.h}.jpg`,
      blob: new Blob([r.bytes as BlobPart], { type: "image/jpeg" }),
      note: `exam:${r.note}:${o.spec.w}:${o.spec.h}:${r.bytes.length}:${o.spec.minKb}:${o.spec.maxKb}`,
    });
    progress?.(i + 1, files.length);
  }
  return out;
}
