"use client";

import { handOff } from "./handoff";

// The receiving end of the "Open in Nopload" browser add-on (extension/).
// The add-on opens the site at /#nopload-extension and its content script,
// which shares this page's window, posts the PDF it downloaded once the page
// says it is ready. The file then goes the way "Continue with …" results go
// (handOff), so the next tool picked starts with it. Nothing leaves the tab.
export const EXTENSION_HASH = "#nopload-extension";

type Offered = { name?: unknown; data?: unknown };

export function listenForExtension(onFiles: (files: File[]) => void): () => void {
  if (location.hash !== EXTENSION_HASH) return () => {};
  const ready = () => window.postMessage({ source: "nopload-site", type: "ready" }, location.origin);
  const onMessage = (e: MessageEvent) => {
    // Only this window: the content script shares it, other pages and frames don't.
    if (e.source !== window || e.origin !== location.origin || e.data?.source !== "nopload-extension") return;
    if (e.data.type === "hello") return ready();
    if (e.data.type !== "files" || !Array.isArray(e.data.files)) return;
    const files = (e.data.files as Offered[])
      .filter((f) => typeof f.name === "string" && f.data instanceof ArrayBuffer)
      .map((f) => new File([f.data as ArrayBuffer], f.name as string, { type: "application/pdf" }));
    if (!files.length) return;
    window.removeEventListener("message", onMessage);
    history.replaceState(history.state, "", location.pathname + location.search);
    handOff(files);
    onFiles(files);
  };
  window.addEventListener("message", onMessage);
  ready();
  return () => window.removeEventListener("message", onMessage);
}
