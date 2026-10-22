"use client";

import { TOOLS, type Tool, type ToolId } from "./tools";

// Carries files into a tool without re-uploading: a result into the next tool
// ("Continue with …"), or files shared to the installed app or opened with it
// (/{lang}/open). Read during the tool's first render, cleared once it has
// mounted.
let pending: File[] | null = null;

export function handOff(files: File[]) {
  pending = files;
}

export const peekHandoff = () => pending;

export function clearHandoff() {
  pending = null;
}

// Files that arrive from outside the page are kept in IndexedDB, on this
// device only: the service worker (public/sw.js, which has its own copy of
// INBOX) puts files shared from the share sheet under `shared`, and handOffTo
// keeps a copy under `handoff`, so the files survive a full page load, as
// when a tool is opened offline. Files are kept as their bytes: WebKit can't
// store a File in IndexedDB in every kind of session.
export const INBOX = { db: "nopload-inbox", store: "files", shared: "shared", handoff: "handoff" } as const;
// A stash older than this is from an earlier visit, not the current one.
export const STASH_MS = 10 * 60 * 1000;

export type Stored = { name: string; type: string; lastModified: number; data: ArrayBuffer };
export type Stash = { files: Stored[]; at: number; tool?: ToolId };

export const toStored = async (f: File): Promise<Stored> =>
  ({ name: f.name, type: f.type, lastModified: f.lastModified, data: await f.arrayBuffer() });
export const fromStored = (s: Stored) => new File([s.data], s.name, { type: s.type, lastModified: s.lastModified });

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");

// The tools these files can go to together: every file is a type the tool
// takes (photos by type when the name has no extension, as the workspace
// does), and several files only to tools that take several.
export function toolsFor(files: { name: string; type: string }[]): Tool[] {
  if (!files.length) return [];
  return TOOLS.filter(
    (t) =>
      t.mode !== "scan" && t.mode !== "url" && (files.length === 1 || t.multiple) &&
      files.every((f) => t.accept.includes(extOf(f.name)) || (t.accept.includes("jpg") && f.type.startsWith("image/"))) &&
      (!t.needsPdf || files.some((f) => extOf(f.name) === "pdf")),
  );
}

// The stashed files, if they're recent and meant for this tool (or for no
// tool in particular).
export function usable(stash: Stash | undefined, tool: ToolId | undefined, now = Date.now()): File[] | null {
  if (!stash?.files?.length || now - stash.at > STASH_MS || stash.tool !== tool) return null;
  return stash.files.map(fromStored);
}

function inbox<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    const open = indexedDB.open(INBOX.db, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(INBOX.store);
    open.onerror = () => resolve(undefined);
    open.onsuccess = () => {
      const db = open.result;
      const done = (value?: T) => {
        db.close();
        resolve(value);
      };
      try {
        const tx = db.transaction(INBOX.store, "readwrite");
        const req = run(tx.objectStore(INBOX.store));
        tx.oncomplete = () => done(req.result);
        tx.onerror = tx.onabort = () => done();
      } catch {
        done();
      }
    };
  });
}

// Reads a stash and removes it, in one transaction.
const take = (key: string) =>
  inbox<Stash | undefined>((store) => {
    const req = store.get(key);
    req.onsuccess = () => store.delete(key);
    return req;
  });

const put = async (key: string, files: File[], tool?: ToolId) => {
  const stash: Stash = { files: await Promise.all(files.map(toStored)), at: Date.now(), tool };
  return inbox((store) => store.put(stash, key));
};

// Files the share sheet handed to the service worker.
export const takeShared = async () => usable(await take(INBOX.shared), undefined) ?? [];

// Keeps files for /{lang}/open across a page load (a change of language).
export const stashShared = (files: File[]) => put(INBOX.shared, files);

// Hands files to a tool that is about to open: in memory for a client-side
// navigation, and stashed in case the tool's page loads afresh.
export async function handOffTo(tool: ToolId, files: File[]) {
  handOff(files);
  await put(INBOX.handoff, files, tool);
}

// Called once the tool has mounted. Files already handed over in memory were
// used in its first render, so the stash is only dropped; otherwise the
// stash is what this tool was handed, if anything.
export async function restoreHandoff(tool: ToolId): Promise<File[]> {
  const inMemory = pending !== null;
  clearHandoff();
  const stash = await take(INBOX.handoff);
  return inMemory ? [] : (usable(stash, tool) ?? []);
}
