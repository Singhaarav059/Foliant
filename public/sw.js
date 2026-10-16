// Offline support: pages are network-first with a cached fallback; build
// assets and /vendor files are cache-first (both have content-hashed URLs).
// API calls are never cached. Registered as /sw.js?v=<vendor version>, so a
// new version installs as a new worker with its own cache, and activating it
// deletes the old one.
const VERSION = new URL(location.href).searchParams.get("v") ?? "dev";
const VENDOR = `/vendor/${VERSION}/`;
const CACHE = `foliant-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll([`${VENDOR}pdf.worker.min.mjs`, `${VENDOR}qpdf.wasm`, "/icon.svg"])).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // OCR language files are large and tesseract.js keeps its own IndexedDB copy.
  if (url.pathname.startsWith("/vendor/") && url.pathname.includes("/tessdata/")) return;

  const assets = url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/vendor/") || url.pathname.endsWith(".svg");
  if (assets) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
    return;
  }
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html") || url.searchParams.has("_rsc")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("/en"))),
    );
  }
});
