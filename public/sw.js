// Offline support: pages are network-first with a cached fallback; build
// assets and /vendor files are cache-first (both have content-hashed URLs).
// API calls are never cached. Registered as /sw.js?v=<vendor version>, so a
// new version installs as a new worker with its own cache, and activating it
// deletes the old one.
//
// The static build writes /sw-manifest.json (scripts/static-extras.mjs): the
// app shell every page loads (scripts, styles, fonts), precached on install
// along with the visitor's language home page, and the full list of build
// files, used to drop the ones a newer deploy no longer has. It also stamps
// BUILD below, so each deploy installs afresh. The PDF engines (qpdf, the
// pdf.js worker…) aren't precached: a tool page fetches its own once it has
// loaded (src/lib/offline.ts), and this worker keeps them.
const VERSION = new URL(location.href).searchParams.get("v") ?? "dev";
const CACHE = `nopload-${VERSION}`;
const BUILD = "dev";

async function manifest() {
  try {
    const res = await fetch(`/sw-manifest.json?b=${BUILD}`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// The language of the page that registered this worker, from its URL (/fr/…).
async function clientLocale(locales) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of clients) {
    const lang = new URL(c.url).pathname.split("/")[1];
    if (locales.includes(lang)) return lang;
  }
  return null;
}

// Browsers refuse a redirected response as the answer to a navigation, so
// store what it redirected to as a plain response.
const plain = (res) => (res.redirected ? new Response(res.body, res) : res);

async function store(cache, url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (res.status === 200) await cache.put(url, plain(res));
}

const isBuildFile = (path) => path.startsWith("/_next/static/");
const isPage = (path) => !isBuildFile(path) && !path.startsWith("/vendor/") && !/\.\w+$/.test(path);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const m = await manifest();
    const lang = m ? await clientLocale(m.locales) : null;
    const urls = ["/icon.svg", ...(m?.shell ?? []), ...(lang ? [`/${lang}`] : [])];
    // Build files never change under the same URL; pages do. One missing
    // file shouldn't stop the worker installing.
    await Promise.all(urls.map(async (u) => {
      try {
        if (!isBuildFile(u) || !(await cache.match(u))) await store(cache, u);
      } catch {
        /* fetched again when it's next used */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // AI models the visitor downloaded (src/lib/ai/store.ts) stay across deploys.
    await Promise.all((await caches.keys()).filter((k) => k !== CACHE && k !== "nopload-models").map((k) => caches.delete(k)));
    // After a deploy: drop build files this build doesn't have, and fetch
    // the pages kept from before again, since they point at those files.
    const m = await manifest();
    if (m?.files) {
      const files = new Set(m.files);
      const cache = await caches.open(CACHE);
      await Promise.all((await cache.keys()).map(async (req) => {
        const url = new URL(req.url);
        if (isBuildFile(url.pathname) && !files.has(url.pathname)) await cache.delete(req);
        else if (url.searchParams.has("_rsc") || url.pathname.endsWith(".txt")) await cache.delete(req);
        else if (isPage(url.pathname)) await store(cache, url.pathname).catch(() => {});
      }));
    }
    await self.clients.claim();
  })());
});

// Cross-origin isolation (needed for LibreOffice's threads) on hosts that
// can't send headers, such as GitHub Pages: every response this worker hands
// back carries them. Hosts that read _headers already send the same values.
const ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };
function isolated(res) {
  if (!res || res.status === 0 || res.type === "opaque" || res.headers.get("Cross-Origin-Embedder-Policy")) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(ISOLATION)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// Keeps a copy of a response. The copy is taken now, before the response is
// handed back and its body read: cloning it later throws.
function keep(event, req, res) {
  if (res.status !== 200) return;
  const copy = plain(res.clone());
  event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // OCR language files are large and tesseract.js keeps its own IndexedDB copy.
  if (url.pathname.startsWith("/vendor/") && url.pathname.includes("/tessdata/")) return;
  // AI model weights (hundreds of MB) are kept in their own cache by src/lib/ai/store.ts.
  if (url.pathname.startsWith("/vendor/models/")) return;

  const assets = isBuildFile(url.pathname) || url.pathname.startsWith("/vendor/") || url.pathname.endsWith(".svg");
  if (assets) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        keep(event, req, res);
        return res;
      })).then(isolated),
    );
    return;
  }
  const navigation = req.mode === "navigate";
  if (navigation || req.headers.get("accept")?.includes("text/html") || url.searchParams.has("_rsc")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          keep(event, req, res);
          return res;
        })
        // Offline: the page as last seen, else the home page in its language.
        .catch(async () => {
          const hit = await caches.match(req);
          if (hit || !navigation) return hit ?? Response.error();
          return (await caches.match(`/${url.pathname.split("/")[1]}`)) ?? (await caches.match("/en")) ?? Response.error();
        })
        .then(isolated),
    );
  }
});
