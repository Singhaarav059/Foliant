"use client";

// Fetches what a tool runs on once its page has settled, so the service
// worker (public/sw.js) keeps it and the tool works offline after a single
// visit. `code` loads the tool's modules through the same imports a real run
// uses: the bundler splits a module into different chunks depending on who
// imports it, so importing the engines from here would fetch the wrong ones.
// This adds the pdf.js worker and the WebAssembly the engines fetch. Only
// while a service worker controls the page, and not on Data Saver or 2G.
import { pdfjs } from "./pdf/common";
import { toolById, type ToolId } from "./tools";
import { VENDOR } from "./vendor";

const ENGINES: Partial<Record<ToolId, string[]>> = {
  compress: ["mozjpeg_enc.wasm", "mozjpeg_dec.wasm", "qpdf.wasm"],
  repair: ["qpdf.wasm"],
  protect: ["qpdf.wasm"],
  unlock: ["qpdf.wasm"],
  redact: ["pdfium.wasm"],
};

export async function warm(id: ToolId, code: () => Promise<unknown>) {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
  const connection = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (connection?.saveData || /2g/.test(connection?.effectiveType ?? "")) return;
  // On a first visit the worker is still installing; it claims the page when it activates.
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  }
  const pdf = toolById(id).accept.includes("pdf");
  await code().catch(() => {});
  if (pdf) await pdfjs().catch(() => {});
  // One at a time, so the page itself is never kept waiting.
  for (const file of [...(pdf ? ["pdf.worker.min.mjs"] : []), ...(ENGINES[id] ?? [])]) {
    await fetch(`${VENDOR}${file}`).then((r) => r.arrayBuffer()).catch(() => {});
  }
}
