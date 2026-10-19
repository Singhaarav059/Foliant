// High-accuracy OCR with PaddleOCR (paddle-engine.ts). In the browser it
// runs in a worker of its own (paddle-worker.ts), which keeps the page
// responsive and which Cancel terminates, memory and all; ONNX Runtime's own
// proxy worker can't be started again once terminated. Node has no workers:
// there it runs in-process.

import type { Gray } from "./ocrprep";
import { paddleFiles, readHere } from "./paddle-engine";

export { fixDigits, paddleFiles, PADDLE_LANGS } from "./paddle-engine";

export type PaddlePage = Awaited<ReturnType<typeof readHere>>;

// One page. `signal` stops it: the worker is terminated (the next page starts
// a new one), or in Node, the page stops between model runs.
export function paddlePage(image: Gray, signal?: AbortSignal): Promise<PaddlePage> {
  return paddleFiles.proxy() ? inWorker(image, signal) : readHere(image, signal);
}

type Remote = { worker: Worker; jobs: Map<number, { resolve: (p: PaddlePage) => void; reject: (e: unknown) => void }> };
let remote: Remote | null = null;
let jobId = 0;

function stopWorker(r: Remote, reason: unknown) {
  r.worker.terminate();
  for (const job of r.jobs.values()) job.reject(reason);
  if (remote === r) remote = null;
}

function inWorker(image: Gray, signal?: AbortSignal): Promise<PaddlePage> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!remote) {
    const r: Remote = { worker: new Worker(new URL("./paddle-worker.ts", import.meta.url), { type: "module" }), jobs: new Map() };
    r.worker.onmessage = ({ data }: MessageEvent<{ id: number; page?: PaddlePage; error?: string }>) => {
      const job = r.jobs.get(data.id);
      r.jobs.delete(data.id);
      if (data.page) job?.resolve(data.page);
      else job?.reject(new Error(data.error ?? "PaddleOCR failed"));
    };
    r.worker.onerror = (e) => stopWorker(r, new Error(`PaddleOCR's worker failed: ${e.message}`));
    remote = r;
  }
  const r = remote;
  const id = ++jobId;
  const stop = () => stopWorker(r, signal!.reason);
  signal?.addEventListener("abort", stop, { once: true });
  return new Promise<PaddlePage>((resolve, reject) => {
    r.jobs.set(id, { resolve, reject });
    r.worker.postMessage({ id, image });
  }).finally(() => signal?.removeEventListener("abort", stop));
}

