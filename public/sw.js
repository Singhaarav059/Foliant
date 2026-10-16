// Offline support: pages are network-first with a cached fallback; build
// assets, the PDF worker and qpdf.wasm are cache-first (their URLs are versioned
// or change only on install). API calls are never cached.
const CACHE = "foliant-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["/vendor/pdf.worker.min.mjs", "/vendor/qpdf.wasm", "/icon.svg"])).then(() => self.skipWaiting()),
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
