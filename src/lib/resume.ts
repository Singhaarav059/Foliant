"use client";

// A job that has to survive a page reload (Office → PDF reloads once to become
// cross-origin isolated): its files and options wait in IndexedDB, which keeps
// File objects as they are, and the reloaded workspace picks them up.

const DB = "foliant";
const STORE = "resume";
// Older than this, it isn't the reload we started: drop it.
const FRESH_MS = 5 * 60_000;

export type Job = { tool: string; files: File[]; options: Record<string, unknown>; agreed?: boolean; at: number };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const saveJob = (job: Omit<Job, "at">) => tx("readwrite", (s) => s.put({ ...job, at: Date.now() }, job.tool)).then(() => undefined);

export async function peekJob(tool: string): Promise<Job | null> {
  const job = (await tx("readonly", (s) => s.get(tool))) as Job | undefined;
  return job && Date.now() - job.at < FRESH_MS ? job : null;
}

export const clearJob = (tool: string) => tx("readwrite", (s) => s.delete(tool)).then(() => undefined);
