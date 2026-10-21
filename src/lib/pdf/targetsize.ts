"use client";

// ── Compress to a size
// Portals for exams, visas and KYC cap uploads at 100 or 200 KB. This runs
// Compress (./optimize.ts) at a sliding setting, from 30 dpi at JPEG quality
// 20 up to 300 dpi at quality 85, and keeps the best-looking result that
// fits. When even the lowest colour setting is too big and greyscale is
// allowed, it tries that last. Text and vector drawings are never rasterised,
// so the text layer survives; that also means a file of mostly text can have
// a floor it can't go under, and then the result says so.

import { baseName, bytesOf, pdfBlob, type Output, type Progress } from "./common";
import { shrink, type PixelCache, type Settings } from "./optimize";

const MIN_DPI = 30;
const MAX_DPI = 300;
const MIN_Q = 20;
const MAX_Q = 85;
// Passes after the first; each re-encodes every image.
const STEPS = 6;
// Close enough: stop once a result uses this much of the target.
const NEAR = 0.9;

// Position t from 0 (smallest) to 1 (best). Resolution moves on a log scale,
// so each step changes the pixel count by a similar factor.
export function settingsAt(t: number, gray: boolean): Settings {
  const dpi = Math.round(MIN_DPI * (MAX_DPI / MIN_DPI) ** t);
  return {
    dpi,
    quality: Math.round(MIN_Q + (MAX_Q - MIN_Q) * t),
    // Images that are never drawn: about an A4 page's long side.
    maxSide: Math.round(dpi * 11.7),
    keepCmyk: false,
    gray,
    // Small steps count here: a size cap is all about the last few KB.
    resampleBelow: 0.97,
  };
}

// Notes on the result (src/components/workspace/Results.tsx):
//   underTarget:{target}:{size}                    already fits, returned as it is
//   target:{target}:{original}:{size}:{dpi}:{grey}  fits; dpi and grey (0/1) used
//   targetMissed:{target}:{original}:{size}         can't fit; the smallest result
export async function compressToSize(file: File, o: { targetBytes: number; gray: boolean }, progress?: Progress, signal?: AbortSignal): Promise<Output[]> {
  const original = await bytesOf(file);
  const target = Math.max(1, Math.floor(o.targetBytes));
  const name = `${baseName(file.name)}-${Math.round(target / 1024)}kb.pdf`;
  if (original.length <= target) return [{ name, blob: pdfBlob(original), note: `underTarget:${target}:${original.length}` }];

  // Decoded images are reused between passes, up to 256 MB of samples.
  const cache: PixelCache = { map: new Map(), bytes: 0, limit: 256 << 20 };
  const total = STEPS + 2;
  let pass = 0;
  const run = async (t: number, gray: boolean) => {
    const bytes = await shrink(file, settingsAt(t, gray), (d, n) => progress?.(pass + d / Math.max(1, n), total), cache, signal);
    progress?.(++pass, total);
    return bytes;
  };

  // The bottom first: if it doesn't fit, nothing will.
  let gray = false;
  let low = await run(0, false);
  if (low.length > target && o.gray) {
    const g = await run(0, true);
    if (g.length < low.length) {
      low = g;
      gray = true;
    }
  }
  if (low.length > target) {
    const smallest = low.length < original.length ? low : original;
    return [{ name, blob: pdfBlob(smallest), note: `targetMissed:${target}:${original.length}:${smallest.length}` }];
  }

  // Then in between: guess where the target falls from the log of the sizes
  // at both ends, and narrow down. The top is never run (at full resolution
  // it is the slowest pass by far); the original's size stands in for it,
  // since no pass makes an image bigger than it was.
  let best = { t: 0, bytes: low };
  let lo = { t: 0, size: low.length };
  let hi = { t: 1, size: original.length };
  for (let i = 0; i < STEPS && best.bytes.length < target * NEAR && hi.t - lo.t > 0.01; i++) {
    const want = Math.log(target * 0.97);
    const guess = lo.t + ((want - Math.log(lo.size)) / (Math.log(hi.size) - Math.log(lo.size))) * (hi.t - lo.t);
    // Never too close to either end, so the bracket keeps shrinking.
    const span = hi.t - lo.t;
    const t = Math.min(hi.t - span * 0.05, Math.max(lo.t + span * 0.05, Number.isFinite(guess) ? guess : lo.t + span / 2));
    const bytes = await run(t, gray);
    if (bytes.length <= target) {
      lo = { t, size: bytes.length };
      if (bytes.length > best.bytes.length) best = { t, bytes };
    } else hi = { t, size: bytes.length };
  }
  progress?.(total, total);
  const { dpi } = settingsAt(best.t, gray);
  return [{ name, blob: pdfBlob(best.bytes), note: `target:${target}:${original.length}:${best.bytes.length}:${dpi}:${gray ? 1 : 0}` }];
}
