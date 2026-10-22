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
//
// Files shared to the installed app from a phone's share sheet arrive as a
// POST to /share (the manifest's share_target). This worker keeps them in
// IndexedDB and sends the page on to /{lang}/open, which offers the tools
// that take them (src/lib/handoff.ts reads them). No server sees them.
//
// Pages visited are kept in a cache of their own, the most recently used
// PAGE_LIMIT of them, and fetched with navigation preload so the worker's
// start-up doesn't delay them. A tab still running an older build that asks
// for one of its /vendor files after a deploy gets a 404 (only this build's
// files are served); its pages are told, and offer to reload (ServiceWorker.tsx).
const VERSION = new URL(location.href).searchParams.get("v") ?? "dev";
const CACHE = `nopload-${VERSION}`;
const PAGES = `nopload-pages-${VERSION}`;
const PAGE_LIMIT = 60;
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
    // /en/open is where "Open with" lands (the manifest's file_handlers).
    const urls = ["/icon.svg", ...(m?.shell ?? []), "/en/open", ...(lang ? [`/${lang}`, `/${lang}/open`] : [])];
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
    await Promise.all((await caches.keys()).filter((k) => k !== CACHE && k !== PAGES && k !== "nopload-models").map((k) => caches.delete(k)));
    await self.registration.navigationPreload?.enable().catch(() => {});
    // After a deploy: drop build files this build doesn't have, and fetch
    // the pages kept from before again, since they point at those files.
    const m = await manifest();
    if (m?.files) {
      const files = new Set(m.files);
      for (const name of [CACHE, PAGES]) {
        const cache = await caches.open(name);
        await Promise.all((await cache.keys()).map(async (req) => {
          const url = new URL(req.url);
          if (isBuildFile(url.pathname) && !files.has(url.pathname)) await cache.delete(req);
          else if (url.searchParams.has("_rsc") || url.pathname.endsWith(".txt")) await cache.delete(req);
          else if (isPage(url.pathname)) await store(cache, url.pathname).catch(() => {});
        }));
      }
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

// A page's copy goes to the pages cache, as its newest entry; the oldest go
// past PAGE_LIMIT. (Cache keys come back in the order they were put.)
function keepPage(event, req, res) {
  if (res.status !== 200) return;
  const copy = plain(res.clone());
  event.waitUntil((async () => {
    const cache = await caches.open(PAGES);
    await cache.delete(req);
    await cache.put(req, copy);
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - PAGE_LIMIT)).map((k) => cache.delete(k)));
  })().catch(() => {}));
}

// A /vendor file from another build than this worker's (a tab left open
// across a deploy) that's gone: that tab's pages should reload.
function staleBuild(event, url, res) {
  const build = url.pathname.split("/")[2];
  if (res.status !== 404 || !url.pathname.startsWith("/vendor/") || build === VERSION || VERSION === "dev") return;
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "nopload:stale" });
  })());
}

// The same database and keys as src/lib/handoff.ts.
const INBOX = { db: "nopload-inbox", store: "files", shared: "shared" };

// Kept as bytes, as src/lib/handoff.ts reads them (WebKit can't always store a File).
async function stashShared(shared) {
  const files = await Promise.all(shared.map(async (f) =>
    ({ name: f.name, type: f.type, lastModified: f.lastModified, data: await f.arrayBuffer() })));
  return new Promise((resolve) => {
    const open = indexedDB.open(INBOX.db, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(INBOX.store);
    open.onerror = () => resolve();
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(INBOX.store, "readwrite");
      tx.objectStore(INBOX.store).put({ files, at: Date.now() }, INBOX.shared);
      tx.oncomplete = tx.onerror = tx.onabort = () => {
        db.close();
        resolve();
      };
    };
  });
}

// The language to show shared files in: an open window's, else that of a
// home page kept here. The page itself then follows the language used last.
async function shareLocale() {
  const lang = (path) => path.match(/^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/)?.[1];
  for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
    const l = lang(new URL(c.url).pathname);
    if (l) return l;
  }
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (/^\/[a-z]{2}(?:-[a-z]{2})?$/.test(path)) return lang(path);
  }
  return "en";
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll("files").filter((f) => typeof f !== "string" && f.size > 0);
    if (files.length) await stashShared(files);
  } catch {
    /* nothing readable was shared: the page offers to choose files */
  }
  return Response.redirect(new URL(`/${await shareLocale()}/open`, location.origin).href, 303);
}

// The privacy chip (src/lib/egress.ts): tells the site's open tabs about
// every request, the page's or one of its workers', that goes to another
// site or carries a body, with the body's size. Reading a copy of the body
// leaves the request itself as it was.
function report(event, req, url) {
  const offsite = url.origin !== location.origin && /^(?:https?|wss?):$/.test(url.protocol);
  const body = req.method !== "GET" && req.method !== "HEAD";
  if (!offsite && !body) return;
  event.waitUntil((async () => {
    const bytes = body ? await req.clone().arrayBuffer().then((b) => b.byteLength, () => 0) : 0;
    for (const client of await self.clients.matchAll({ type: "window" })) client.postMessage({ type: "nopload:egress", url: req.url, bytes });
  })());
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.origin === location.origin && url.pathname === "/share") {
    event.respondWith(receiveShare(req));
    return;
  }
  report(event, req, url);
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
        staleBuild(event, url, res);
        return res;
      })).then(isolated),
    );
    return;
  }
  const navigation = req.mode === "navigate";
  if (navigation || req.headers.get("accept")?.includes("text/html") || url.searchParams.has("_rsc")) {
    event.respondWith(
      // The navigation preload's response when there is one: it started while this worker woke up.
      Promise.resolve(navigation ? event.preloadResponse : undefined)
        .then((preloaded) => preloaded ?? fetch(req))
        .then((res) => {
          keepPage(event, req, res);
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
