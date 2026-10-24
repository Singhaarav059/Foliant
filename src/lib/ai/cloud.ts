// The cloud AI (functions/api/ai.ts), from the page's side: Claude by
// Anthropic, with Cloudflare Workers AI as its backup. Only the text a task
// needs is sent (a question and the passages that answer it, a document's
// text to summarise, blocks to translate), never the file. Any failure is a
// CloudUnavailable, and the tools then use on-device AI instead.

import { AI_CLOUD } from "../mode";

export const CLOUD = "cloud";
export type Provider = "anthropic" | "cloudflare";

export class CloudUnavailable extends Error {}

const ENDPOINT = "/api/ai";

// Whether this copy of the site has the endpoint with a provider set up
// (static hosts without it, offline, the extension: no).
let available: Promise<boolean> | null = null;
export function cloudAvailable(): Promise<boolean> {
  if (!AI_CLOUD) return Promise.resolve(false);
  available ??= fetch(ENDPOINT, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { anthropic?: boolean; cloudflare?: boolean } | null) => !!(s?.anthropic || s?.cloudflare))
    .catch(() => false);
  return available;
}

const providerOf = (r: Response): Provider => (r.headers.get("X-AI-Provider") === "cloudflare" ? "cloudflare" : "anthropic");

async function send(body: object, signal?: AbortSignal): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new CloudUnavailable(String(e));
  }
  if (!r.ok) throw new CloudUnavailable(`${r.status} ${await r.text().catch(() => "")}`.trim());
  return r;
}

// A streamed reply; `onText` gets the text so far.
export async function cloudText(body: object, o: { onText?: (text: string) => void; signal?: AbortSignal } = {}): Promise<{ text: string; provider: Provider }> {
  const r = await send(body, o.signal);
  const provider = providerOf(r);
  if (!r.body) return { text: await r.text(), provider };
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
    o.onText?.(text);
  }
  if (!text.trim()) throw new CloudUnavailable("empty reply");
  return { text, provider };
}

export async function cloudJson<T>(body: object, signal?: AbortSignal): Promise<{ data: T; provider: Provider }> {
  const r = await send(body, signal);
  return { data: (await r.json()) as T, provider: providerOf(r) };
}
