"use client";

// Fetches what a tool runs on once its page has settled, so the service
// worker (public/sw.js) keeps it and the tool works offline after a single
// visit. `code` loads the tool's modules through the same imports a real run
// uses: the bundler splits a module into different chunks depending on who
// imports it, so importing the engines from here would fetch the wrong ones.
// This adds the pdf.js worker and the WebAssembly the engines fetch, and the
// page itself when it was reached by a link. Only while a service worker controls the page, and not on
// Data Saver or 2G.
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
  // A page reached by a link inside the app was never loaded as a page: the
  // browser fetched only its data, and the code that page loads on its own
  // (offline, after a reload) comes in different chunks from the ones this
  // visit used. Loading it once, hidden, keeps exactly what a reload needs.
  const visited = !!(await caches.match(location.pathname).catch(() => null));
  const pdf = toolById(id).accept.includes("pdf");
  await code().catch(() => {});
  if (pdf) await pdfjs().catch(() => {});
  // One at a time, so the page itself is never kept waiting.
  // qpdf opens PDFs for editing (pdf/open.ts); without it they open as they are.
  for (const file of new Set([...(pdf ? ["pdf.worker.min.mjs", "qpdf.wasm"] : []), ...(ENGINES[id] ?? [])])) {
    await fetch(`${VENDOR}${file}`).then((r) => r.arrayBuffer()).catch(() => {});
  }
  if (window.parent !== window) window.parent.postMessage(WARMED, location.origin);
  else if (!visited) await inFrame(location.pathname);
}

const WARMED = "nopload:warmed";

// Loads a page in a hidden frame and waits for its own warm() to finish.
function inFrame(path: string) {
  return new Promise<void>((resolve) => {
    const frame = document.createElement("iframe");
    frame.src = path;
    frame.hidden = true;
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      frame.remove();
      resolve();
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.contentWindow && e.data === WARMED) done();
    };
    // A frame that never reports back (an error, a slow link) isn't kept.
    const timer = setTimeout(done, 120_000);
    window.addEventListener("message", onMessage);
    document.body.append(frame);
  });
}
