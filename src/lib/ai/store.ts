// Model weights on this device. A model is downloaded only when the visitor
// asks for it, from this site (/vendor/models/, see scripts/vendor.mjs), part
// by part, each part checked against its SHA-256, and kept in Cache Storage
// under its own name, which the service worker leaves alone (public/sw.js),
// so it works offline afterwards. An interrupted download picks up at the
// part it stopped at. Runs in the AI worker (./worker.ts).

import catalog from "./models.json";

export type ModelId = keyof typeof catalog.models;
export const MODEL_IDS = Object.keys(catalog.models) as ModelId[];
export const model = (id: ModelId) => catalog.models[id];

// Where the site serves a model: the folder changes with its revision.
export const folderOf = (id: ModelId) => `${id}-${model(id).revision.slice(0, 12)}`;
export const urlOf = (id: ModelId) => `/vendor/models/${folderOf(id)}/`;
// Bytes to download.
export const sizeOf = (id: ModelId) => Object.values(model(id).files).reduce((n, [, size]) => n + (size as number), 0);

export const CACHE = "nopload-models";
const partUrl = (id: ModelId, file: string, i: number) => `${urlOf(id)}${file}.${String(i).padStart(2, "0")}`;
type Parts = Record<string, string[]>;

// The model's part list, as kept on the device.
async function partsOf(cache: Cache, id: ModelId): Promise<Parts | null> {
  const res = await cache.match(urlOf(id) + "parts.json");
  return res ? res.json() : null;
}

// A model counts as downloaded when every part is there.
export async function isStored(id: ModelId): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE);
    const parts = await partsOf(cache, id);
    if (!parts) return false;
    for (const [file, hashes] of Object.entries(parts))
      for (let i = 0; i < hashes.length; i++) if (!(await cache.match(partUrl(id, file, i)))) return false;
    return true;
  } catch {
    return false;
  }
}

// A stored file, its parts joined, for the runtime to read (./worker.ts).
export async function storedFile(id: ModelId, file: string): Promise<Blob | null> {
  try {
    const cache = await caches.open(CACHE);
    const hashes = (await partsOf(cache, id))?.[file];
    if (!hashes) return null;
    const blobs: Blob[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const res = await cache.match(partUrl(id, file, i));
      if (!res) return null;
      blobs.push(await res.blob());
    }
    return new Blob(blobs);
  } catch {
    return null;
  }
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// Downloads a model. `progress` gets bytes done and the total. Parts of
// models or revisions this site no longer serves are removed first.
export async function download(id: ModelId, progress: (done: number, total: number) => void, signal?: AbortSignal) {
  const cache = await caches.open(CACHE);
  await prune(cache);
  const res = await fetch(urlOf(id) + "parts.json", { signal });
  if (!res.ok) throw new Error(`model ${id}: not on this site (HTTP ${res.status})`);
  const parts: Parts = await res.clone().json();
  const total = sizeOf(id);
  let done = 0;
  for (const [file, hashes] of Object.entries(parts))
    for (const [i, hash] of hashes.entries()) {
      const url = partUrl(id, file, i);
      const kept = await cache.match(url);
      if (kept) {
        done += Number(kept.headers.get("content-length")) || (await kept.blob()).size;
        progress(done, total);
        continue;
      }
      const r = await fetch(url, { signal });
      if (!r.ok) throw new Error(`model ${id}: ${file} part ${i}: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (hex(await crypto.subtle.digest("SHA-256", buf)) !== hash) throw new Error(`model ${id}: ${file} part ${i} is corrupt`);
      await cache.put(url, new Response(buf, { headers: { "content-length": String(buf.byteLength) } }));
      done += buf.byteLength;
      progress(done, total);
    }
  // Last, so a model only counts as downloaded once every part is in.
  await cache.put(urlOf(id) + "parts.json", res);
}

export async function remove(id: ModelId) {
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(urlOf(id))) await cache.delete(req);
}

async function prune(cache: Cache) {
  const keep = MODEL_IDS.map(urlOf);
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!keep.some((k) => path.startsWith(k))) await cache.delete(req);
  }
}
