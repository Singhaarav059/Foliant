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

import { baseName, type Output, type Progress } from "@/lib/pdf/common";
import { VENDOR } from "@/lib/vendor";

type Converter = InstanceType<typeof import("@matbee/libreoffice-converter/browser").WorkerBrowserConverter>;
type Manifest = { version: string; files: Record<"soffice.wasm" | "soffice.data", { parts: string[]; size: number }> };

const base = () => new URL(`${VENDOR}libreoffice/`, location.origin).href;

export class OfficeError extends Error {
  constructor(public code: "office_isolation" | "office_memory", message: string) {
    super(message);
  }
}

// Downloads one file's parts in order, reporting bytes, and returns an unzipped blob URL.
async function fetchParts(file: Manifest["files"]["soffice.wasm"], type: string, onBytes: (n: number) => void): Promise<string> {
  const parts: Blob[] = [];
  for (const part of file.parts) {
    const res = await fetch(base() + part);
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

let loading: Promise<Converter> | null = null;

function load(progress?: Progress): Promise<Converter> {
  loading ??= (async () => {
    const manifest = (await (await fetch(base() + "manifest.json")).json()) as Manifest;
    const total = manifest.files["soffice.wasm"].size + manifest.files["soffice.data"].size;
    let got = 0;
    // Downloading is most of the wait: count it as 90% of the bar, starting LibreOffice the rest.
    const onBytes = (n: number) => progress?.((got += n) * 0.9, total);
    const wasm = await fetchParts(manifest.files["soffice.wasm"], "application/wasm", onBytes);
    const data = await fetchParts(manifest.files["soffice.data"], "application/octet-stream", onBytes);
    const { WorkerBrowserConverter } = await import("@matbee/libreoffice-converter/browser");
    const converter = new WorkerBrowserConverter({
      sofficeJs: base() + "soffice.js",
      sofficeWorkerJs: base() + "soffice.worker.js",
      browserWorkerJs: base() + "browser.worker.js",
      sofficeWasm: wasm,
      sofficeData: data,
    });
    try {
      await converter.initialize();
    } catch (e) {
      if (/memory|Out of memory|RangeError/i.test(String(e))) throw new OfficeError("office_memory", String(e));
      throw e;
    } finally {
      // The worker has its copies now.
      URL.revokeObjectURL(wasm);
      URL.revokeObjectURL(data);
    }
    progress?.(total, total);
    return converter;
  })();
  // A failed load shouldn't stick: the next try starts over.
  loading.catch(() => (loading = null));
  return loading;
}

// Whether this page can run LibreOffice at all.
export const officeAvailable = () =>
  typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined";

export async function officeToPdf(file: File, progress?: Progress): Promise<Output> {
  if (!officeAvailable()) throw new OfficeError("office_isolation", "This page isn't cross-origin isolated");
  const converter = await load(progress);
  const result = await converter.convert(new Uint8Array(await file.arrayBuffer()), { outputFormat: "pdf" }, file.name);
  return { name: `${baseName(file.name)}.pdf`, blob: new Blob([result.data as BlobPart], { type: "application/pdf" }) };
}
