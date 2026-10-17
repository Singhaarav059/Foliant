// High-accuracy OCR: PaddleOCR's PP-OCRv5 mobile models (Apache-2.0) on
// ONNX Runtime Web (MIT), all served from /vendor and downloaded only when
// this mode is chosen. Detection follows PaddleOCR's DB post-processing
// (threshold, connected regions, score filter, unclip); recognition is CTC
// with greedy decoding. Pages arrive already upright and deskewed
// (ocrprep.ts), so text boxes are axis-aligned and OpenCV isn't needed.
//
// Output has the same shape as Tesseract's, so ocr.ts treats both alike.

import type { InferenceSession, Tensor } from "onnxruntime-web";
import { VENDOR } from "../vendor";
import type { Gray } from "./ocrprep";

export { PADDLE_LANGS } from "../tools";

// Tests point these at files on disk.
export const paddleFiles = {
  url: (name: string) => new URL(`${VENDOR}paddle/${name}`, location.origin).href,
  load: async (name: string) => new Uint8Array(await (await fetch(paddleFiles.url(name))).arrayBuffer()),
  // A Web Worker keeps the page responsive; Node has none.
  proxy: () => typeof window !== "undefined",
};

type Ort = typeof import("onnxruntime-web");
type Engine = { ort: Ort; det: InferenceSession; rec: InferenceSession; chars: string[] };
let loading: Promise<Engine> | null = null;

function engine() {
  loading ??= (async () => {
    const ort = (await import("onnxruntime-web/wasm")) as unknown as Ort;
    ort.env.wasm.wasmPaths = { mjs: paddleFiles.url("ort-wasm-simd-threaded.mjs"), wasm: paddleFiles.url("ort-wasm-simd-threaded.wasm") };
    // Threads need cross-origin isolation, which a static host may not give.
    ort.env.wasm.numThreads = typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.wasm.proxy = paddleFiles.proxy();
    const [detBytes, recBytes, dictBytes] = await Promise.all(["det.ort", "rec.onnx", "dict.txt"].map((f) => paddleFiles.load(f)));
    const options: InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const det = await ort.InferenceSession.create(detBytes, options);
    const rec = await ort.InferenceSession.create(recBytes, options);
    // One character per line. This file has a stray empty line and already ends with the space.
    const dict = new TextDecoder().decode(dictBytes).split(/\r?\n/).filter((c) => c !== "");
    if (dict[dict.length - 1] !== " ") dict.push(" ");
    // Class 0 is the CTC blank.
    const chars = ["", ...dict];
    const classes = (rec.outputMetadata?.[0] as { shape?: (number | string)[] } | undefined)?.shape?.at(-1);
    if (typeof classes === "number" && classes !== chars.length) throw new Error(`OCR dictionary has ${chars.length} classes, model ${classes}`);
    return { ort, det, rec, chars };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

// One page at a time: a session can't run two jobs at once.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
};

// ── Detection

const DET_MAX_SIDE = 1600;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Rect = { x0: number; y0: number; x1: number; y1: number };

async function detect(e: Engine, g: Gray): Promise<Rect[]> {
  const scale = Math.min(1, DET_MAX_SIDE / Math.max(g.w, g.h));
  const W = Math.max(32, Math.round((g.w * scale) / 32) * 32);
  const H = Math.max(32, Math.round((g.h * scale) / 32) * 32);
  const sx = g.w / W, sy = g.h / H;
  const input = new Float32Array(3 * W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = sample(g, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5) / 255;
      for (let c = 0; c < 3; c++) input[c * W * H + y * W + x] = (v - MEAN[c]) / STD[c];
    }
  const out = await e.det.run({ [e.det.inputNames[0]]: new e.ort.Tensor("float32", input, [1, 3, H, W]) });
  const prob = out[e.det.outputNames[0]].data as Float32Array;

  // Connected regions above 0.3, each scored by its mean probability.
  const label = new Int32Array(W * H).fill(-1);
  const rects: Rect[] = [];
  const stack: number[] = [];
  for (let i = 0; i < W * H; i++) {
    if (prob[i] <= 0.3 || label[i] >= 0) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, sum = 0, n = 0;
    label[i] = rects.length;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W, y = (p - x) / W;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      sum += prob[p];
      n++;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || label[q] >= 0 || prob[q] <= 0.3) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        label[q] = rects.length;
        stack.push(q);
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (Math.min(w, h) < 3 || sum / n < 0.6) { rects.push({ x0: -1, y0: -1, x1: -1, y1: -1 }); continue; }
    // Unclip: DB predicts shrunk regions; grow by area × 1.5 / perimeter.
    const d = (w * h * 1.5) / (2 * (w + h));
    rects.push({
      x0: Math.max(0, (x0 - d) * sx), y0: Math.max(0, (y0 - d) * sy),
      x1: Math.min(g.w, (x1 + 1 + d) * sx), y1: Math.min(g.h, (y1 + 1 + d) * sy),
    });
  }
  return rects.filter((r) => r.x0 >= 0 && r.x1 - r.x0 >= 4 && r.y1 - r.y0 >= 4);
}

function sample(g: Gray, x: number, y: number) {
  const x0 = Math.max(0, Math.min(g.w - 1, Math.floor(x))), y0 = Math.max(0, Math.min(g.h - 1, Math.floor(y)));
  const x1 = Math.min(g.w - 1, x0 + 1), y1 = Math.min(g.h - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0)), ty = Math.max(0, Math.min(1, y - y0));
  const d = g.data;
  return (d[y0 * g.w + x0] * (1 - tx) + d[y0 * g.w + x1] * tx) * (1 - ty) + (d[y1 * g.w + x0] * (1 - tx) + d[y1 * g.w + x1] * tx) * ty;
}

// ── Recognition

const REC_H = 48;
const REC_MAX_W = 3200;
const BATCH = 6;

type Read = { rect: Rect; text: string; confidence: number; chars: { ch: string; x0: number; x1: number; p: number }[] };

async function recognise(e: Engine, g: Gray, rects: Rect[]): Promise<Read[]> {
  const items = rects.map((rect) => {
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    return { rect, width: Math.max(8, Math.min(REC_MAX_W, Math.round((REC_H * w) / h))) };
  });
  // Similar widths batch together, so little of each batch is padding.
  const order = items.map((_, i) => i).sort((a, b) => items[a].width - items[b].width);
  const reads: Read[] = new Array(items.length);
  for (let b = 0; b < order.length; b += BATCH) {
    const batch = order.slice(b, b + BATCH);
    const W = Math.max(...batch.map((i) => items[i].width));
    const input = new Float32Array(batch.length * 3 * REC_H * W); // padding stays 0, as in PaddleOCR
    batch.forEach((i, k) => {
      const { rect, width } = items[i];
      const sx = (rect.x1 - rect.x0) / width, sy = (rect.y1 - rect.y0) / REC_H;
      for (let y = 0; y < REC_H; y++)
        for (let x = 0; x < width; x++) {
          const v = (sample(g, rect.x0 + (x + 0.5) * sx - 0.5, rect.y0 + (y + 0.5) * sy - 0.5) / 255 - 0.5) / 0.5;
          for (let c = 0; c < 3; c++) input[((k * 3 + c) * REC_H + y) * W + x] = v;
        }
    });
    const out = (await e.rec.run({ [e.rec.inputNames[0]]: new e.ort.Tensor("float32", input, [batch.length, 3, REC_H, W]) }))[e.rec.outputNames[0]] as Tensor;
    const [, T, C] = out.dims as number[];
    const probs = out.data as Float32Array;
    batch.forEach((i, k) => {
      const { rect, width } = items[i];
      const step = W / T; // input pixels per timestep
      const toPage = (px: number) => rect.x0 + (px / width) * (rect.x1 - rect.x0);
      const chars: Read["chars"] = [];
      let prev = -1;
      for (let t = 0; t < T; t++) {
        let best = 0, p = -1;
        for (let c = 0; c < C; c++) {
          const v = probs[(k * T + t) * C + c];
          if (v > p) [p, best] = [v, c];
        }
        if (best !== 0 && best !== prev && e.chars[best] !== undefined) chars.push({ ch: e.chars[best], x0: toPage(t * step), x1: toPage((t + 1) * step), p });
        prev = best;
      }
      const kept = chars.filter((c) => c.ch !== " ");
      reads[i] = { rect, chars, text: chars.map((c) => c.ch).join("").trim(), confidence: kept.length ? (kept.reduce((s, c) => s + c.p, 0) / kept.length) * 100 : 0 };
    });
  }
  return reads;
}

// ── Tesseract-shaped result

type Box = { x0: number; y0: number; x1: number; y1: number };
type Word = { text: string; confidence: number; bbox: Box };

// PP-OCR reads a serif zero as "o" now and then. In a word that's mostly
// digits (amounts, references, phone numbers), an o next to a digit is a zero.
export function fixDigits(word: string) {
  const digits = (word.match(/\d/g) ?? []).length;
  const letters = (word.match(/\p{L}/gu) ?? []).length;
  if (digits < 2 || letters > digits) return word;
  return word.replace(/[oO](?=\d)|(?<=\d[.,]?)[oO]/g, "0");
}

// Characters between spaces become words, each spanning its own characters'
// timesteps, so the gap between words stays visible to text extraction.
// Only the ends of the line reach out to the detected box.
function words(r: Read): Word[] {
  const groups: Read["chars"][] = [[]];
  for (const c of r.chars) {
    if (c.ch === " ") groups.push([]);
    else groups[groups.length - 1].push(c);
  }
  const full = groups.filter((g) => g.length);
  return full.map((g, i) => ({
    text: fixDigits(g.map((c) => c.ch).join("")),
    confidence: (g.reduce((s, c) => s + c.p, 0) / g.length) * 100,
    bbox: {
      x0: i === 0 ? r.rect.x0 : g[0].x0,
      y0: r.rect.y0,
      x1: i === full.length - 1 ? r.rect.x1 : g[g.length - 1].x1,
      y1: r.rect.y1,
    },
  }));
}

export async function paddlePage(image: Gray) {
  return serial(async () => {
    const e = await engine();
    const rects = (await detect(e, image)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const reads = (await recognise(e, image, rects)).filter((r) => r.text);
    const lines = reads.map((r) => {
      // Detected boxes cover descenders and padding; the baseline sits about 3/4 down.
      const base = r.rect.y0 + (r.rect.y1 - r.rect.y0) * 0.76;
      return { words: words(r), baseline: { x0: r.rect.x0, y0: base, x1: r.rect.x1, y1: base, has_baseline: true } };
    });
    const conf = reads.length ? reads.reduce((s, r) => s + r.confidence, 0) / reads.length : 0;
    return { confidence: conf, blocks: [{ paragraphs: [{ lines }] }] };
  });
}
