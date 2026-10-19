// High-fidelity Office → PDF in the browser: LibreOffice compiled to
// WebAssembly (@matbee/libreoffice-converter, MPL-2.0), the same engine the
// server build uses when LibreOffice is installed. Reads Word, Excel,
// PowerPoint and OpenDocument files, old binary formats included, and writes
// a real PDF without the print dialog.
//
// About 79 MB, fetched from /vendor only when this mode is used, in parts the
// browser joins and unzips (scripts/vendor.mjs). LibreOffice runs threads, so
// the page must be cross-origin isolated (COOP/COEP headers; the service
// worker adds them on hosts that can't), and it needs about 1 GB of memory.

import { abortable, baseName, type Output, type Progress } from "@/lib/pdf/common";
import { VENDOR } from "@/lib/vendor";

type Converter = InstanceType<typeof import("@matbee/libreoffice-converter/browser").WorkerBrowserConverter>;
type Manifest = { version: string; files: Record<"soffice.wasm" | "soffice.data", { parts: string[]; size: number }> };

const base = () => new URL(`${VENDOR}libreoffice/`, location.origin).href;

export class OfficeError extends Error {
  constructor(public code: "office_isolation" | "office_memory" | "office_stalled", message: string) {
    super(message);
  }
}

// Downloads one file's parts in order, reporting bytes, and returns an unzipped blob URL.
async function fetchParts(file: Manifest["files"]["soffice.wasm"], type: string, onBytes: (n: number) => void, signal?: AbortSignal): Promise<string> {
  const parts: Blob[] = [];
  for (const part of file.parts) {
    const res = await fetch(base() + part, { signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${part} (${res.status})`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      onBytes(value.length);
    }
    parts.push(new Blob(chunks as BlobPart[]));
  }
  const unzipped = new Blob(parts).stream().pipeThrough(new DecompressionStream("gzip"));
  return URL.createObjectURL(new Blob([await new Response(unzipped).arrayBuffer()], { type }));
}

// LibreOffice can die without a word: in WebKit its worker aborts and the
// promise it was asked for never settles. A start or a conversion that takes
// longer than this has failed, so Automatic can print instead.
export const officeLimits = { startMs: 120_000, convertMs: 120_000, perMbMs: 60_000 };

// Stops a converter whose worker may be dead. Its destroy() waits for the
// worker to answer, which a dead one never does, so the worker goes directly.
function abandon(converter: Converter) {
  (converter as unknown as { worker?: Worker | null }).worker?.terminate();
}

// A started LibreOffice, and a promise that rejects if its worker reports an error.
type Office = { converter: Converter; died: Promise<never> };

// LibreOffice's worker died or went quiet: whatever it was doing won't finish.
const stalled = (why: string) => new OfficeError("office_stalled", why);
const isStalled = (e: unknown) => e instanceof OfficeError && e.code === "office_stalled";

// `work`, or an office_stalled rejection when the worker reports an error or
// `ms` pass first, or the abort's reason when `signal` fires.
function settle<T>(work: Promise<T>, died: Promise<never>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(stalled("LibreOffice stopped responding")), ms);
  });
  const dead = died.catch((e) => Promise.reject(stalled(`LibreOffice stopped: ${e}`)));
  return abortable(Promise.race([work, dead, late]), signal).finally(() => clearTimeout(timer));
}

let loading: Promise<Office> | null = null;

// Cancelling (`signal`) while it downloads or starts stops it, worker and
// all, and the next job starts over.
function load(progress?: Progress, signal?: AbortSignal): Promise<Office> {
  loading ??= (async () => {
    const manifest = (await (await fetch(base() + "manifest.json", { signal })).json()) as Manifest;
    const total = manifest.files["soffice.wasm"].size + manifest.files["soffice.data"].size;
    let got = 0;
    // Downloading is most of the wait: count it as 90% of the bar, starting LibreOffice the rest.
    const onBytes = (n: number) => progress?.((got += n) * 0.9, total);
    const wasm = await fetchParts(manifest.files["soffice.wasm"], "application/wasm", onBytes, signal);
    const data = await fetchParts(manifest.files["soffice.data"], "application/octet-stream", onBytes, signal).catch((e) => {
      URL.revokeObjectURL(wasm);
      throw e;
    });
    const { WorkerBrowserConverter } = await import("@matbee/libreoffice-converter/browser");
    if (signal?.aborted) {
      URL.revokeObjectURL(wasm);
      URL.revokeObjectURL(data);
      throw signal.reason;
    }
    let die: (e: Error) => void = () => {};
    const died = new Promise<never>((_, reject) => (die = reject));
    died.catch(() => {});
    const converter = new WorkerBrowserConverter({
      sofficeJs: base() + "soffice.js",
      sofficeWorkerJs: base() + "soffice.worker.js",
      browserWorkerJs: base() + "browser.worker.js",
      sofficeWasm: wasm,
      sofficeData: data,
      onError: die,
    });
    try {
      await settle(converter.initialize(), died, officeLimits.startMs, signal);
    } catch (e) {
      abandon(converter);
      if (!isStalled(e) && /memory|Out of memory|RangeError/i.test(String(e))) throw new OfficeError("office_memory", String(e));
      throw e;
    } finally {
      // The worker has its copies now.
      URL.revokeObjectURL(wasm);
      URL.revokeObjectURL(data);
    }
    progress?.(total, total);
    return { converter, died };
  })();
  // A failed load shouldn't stick: the next try starts over.
  loading.catch(() => (loading = null));
  return loading;
}

// Whether this page can run LibreOffice at all.
export const officeAvailable = () =>
  typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";

// `signal` cancels: a conversion under way can't be stopped any other way,
// so LibreOffice's worker (and its threads) is terminated, and the next job
// starts it again.
export async function officeToPdf(file: File, progress?: Progress, signal?: AbortSignal): Promise<Output> {
  if (!officeAvailable()) throw new OfficeError("office_isolation", "This page isn't cross-origin isolated");
  signal?.throwIfAborted();
  const current = load(progress, signal);
  const { converter, died } = await abortable(current, signal);
  const input = new Uint8Array(await file.arrayBuffer());
  let result;
  try {
    result = await settle(converter.convert(input, { outputFormat: "pdf" }, file.name), died, officeLimits.convertMs + (input.length / 1e6) * officeLimits.perMbMs, signal);
  } catch (e) {
    // A LibreOffice that hung, died or was stopped is no use to the next job: that one starts afresh.
    if (isStalled(e) || signal?.aborted) {
      abandon(converter);
      if (loading === current) loading = null;
    }
    throw e;
  }
  return { name: `${baseName(file.name)}.pdf`, blob: new Blob([result.data as BlobPart], { type: "application/pdf" }) };
}
