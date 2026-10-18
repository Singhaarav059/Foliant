import "server-only";
import { isIP } from "node:net";
import { HttpError } from "./errors";
import { v6Bytes } from "./net";

// Small in-memory sliding window per key. Good enough for one server process;
// put a shared store in front for multi-instance deployments. The number of
// keys is capped, so a flood of new keys can't exhaust memory.
const MAX_KEYS = 50_000;
const hits = new Map<string, { times: number[]; windowMs: number }>();

export function sweep(now = Date.now()) {
  for (const [key, { times, windowMs }] of hits) if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(key);
}

function store(key: string, times: number[], windowMs: number) {
  hits.delete(key); // re-inserted last, so the oldest keys go first when full
  hits.set(key, { times, windowMs });
  if (hits.size > MAX_KEYS) {
    sweep();
    for (const k of hits.keys()) {
      if (hits.size <= MAX_KEYS * 0.9) break;
      hits.delete(k);
    }
  }
}

const recent = (key: string, windowMs: number, now: number) => (hits.get(key)?.times ?? []).filter((t) => now - t < windowMs);

export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = recent(key, windowMs, now);
  if (list.length >= max) {
    store(key, list, windowMs);
    return false;
  }
  list.push(now);
  store(key, list, windowMs);
  return true;
}

// For counting failures only: check with hitCount, then recordHit on failure.
export const hitCount = (key: string, windowMs: number) => recent(key, windowMs, Date.now()).length;
export function recordHit(key: string, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  store(key, [...recent(key, windowMs, now), now], windowMs);
}
export const clearHits = (key: string) => void hits.delete(key);
export const trackedKeys = () => hits.size;

// The client's address as the trusted reverse proxy saw it. Each proxy
// appends the address it received the request from to X-Forwarded-For, so
// with TRUST_PROXY_HOPS proxies in front only the last that many entries are
// trustworthy; anything to their left is whatever the client sent. Without a
// proxy, Next fills the header from the socket only when the client sent none,
// which is why the server build needs a proxy in front (see README).
const HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 1);

export function clientIp(req: Request, hops = HOPS) {
  if (!(hops > 0)) return "direct";
  const list = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length) return "unknown";
  let ip = list[Math.max(0, list.length - hops)];
  // "1.2.3.4:5678" and "[::1]:5678" from proxies that keep the port.
  if (!isIP(ip)) ip = ip.replace(/^\[([^\]]+)\](:\d+)?$/, "$1").replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1");
  if (isIP(ip) === 4) return ip;
  const b = isIP(ip) === 6 ? v6Bytes(ip) : null;
  if (!b) return "unknown";
  // One IPv6 client usually has a whole /64, so it's one key.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return b.slice(12).join(".");
  const groups = [0, 2, 4, 6].map((i) => ((b[i] << 8) | b[i + 1]).toString(16));
  return `${groups.join(":")}::/64`;
}

export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024;
export const MAX_HTML_BYTES = 10 * 1024 * 1024;
export const MAX_JSON_BYTES = 64 * 1024;

const tooLarge = () => new HttpError(413, "File too large.");

// Reads a request body, stopping as soon as it passes `max` bytes. A declared
// Content-Length over the limit is refused before anything is read.
export async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (declared > max) throw tooLarge();
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    // Stops reading rather than cancelling: the rest is dropped with the request.
    if (size > max) throw tooLarge();
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function readForm(req: Request, max: number) {
  const body = await readBody(req, max);
  try {
    return await new Response(body as BodyInit, { headers: { "Content-Type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new HttpError(400, "That upload couldn't be read.");
  }
}
