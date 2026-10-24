"use client";

// The on-device AI, from the page's side. (The cloud AI, the default where
// this site has it, is ./cloud.ts.) Engines on the device, best first:
//  1. the browser's built-in AI (Chrome's Translator and Summarizer), when
//     its model is already on the device;
//  2. a language model from this site, run with WebGPU (CPU otherwise):
//     "small" (SmolLM2-360M, English) or "large" (Qwen3-0.6B, many languages);
//  3. "light": a 23 MB embedding model that finds the sentences that answer,
//     on any device.
// Models are only downloaded when the visitor asks (./store.ts), and run in
// a worker (./worker.ts).

import { AI_MODELS } from "../vendor";
import { CLOUD, CLOUDFLARE } from "./cloud";
import { MODEL_IDS, sizeOf, type ModelId } from "./store";
import type { Embed, Generate } from "./chat";

export { MODEL_IDS, sizeOf, type ModelId };

// Models this build of the site serves (NOPLOAD_AI_MODELS, scripts/vendor.mjs).
export const servedModels = () => MODEL_IDS.filter((m) => AI_MODELS.includes(m));

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onEvent?: (e: never) => void };
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

export class Aborted extends Error {}

function call<T>(type: string, payload: object = {}, onEvent?: (e: never) => void, signal?: AbortSignal): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e: MessageEvent<{ id: number; result?: unknown; error?: string; aborted?: boolean; event?: never }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.event !== undefined) return p.onEvent?.(e.data.event);
      pending.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(e.data.aborted ? new Aborted(e.data.error) : new Error(e.data.error));
      else p.resolve(e.data.result);
    });
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onEvent });
    signal?.addEventListener("abort", () => worker?.postMessage({ id: ++seq, type: "abort", target: id }));
    worker!.postMessage({ id, type, ...payload });
  });
}

export type Status = { stored: Record<ModelId, boolean>; webgpu: boolean; f16: boolean };
export const status = () => call<Status>("status");

export const download = (id: ModelId, progress: (done: number, total: number) => void, signal?: AbortSignal) =>
  call<true>("download", { model: id }, ((e: { done: number; total: number }) => progress(e.done, e.total)) as (e: never) => void, signal);

export const removeModel = (id: ModelId) => call<true>("remove", { model: id });

// Loads the runtime the models run on, so it works offline too (7.8 MB, from /vendor).
export const prepareRuntime = () => call<true>("prepare");

// Loads a language model ahead of the first question; says where it runs.
export const loadModel = (id: ModelId) => call<"webgpu" | "wasm">("load", { model: id });

export const embed: Embed = (texts) => call<number[][]>("embed", { texts });

export const generator = (id: ModelId): Generate => (messages, o) =>
  call<string>("generate", { model: id, messages, maxNewTokens: o.maxNewTokens }, ((e: { text: string }) => o.onText?.(e.text)) as (e: never) => void, o.signal);

// The browser's built-in Translator, when it can translate this pair without downloading anything.
type BuiltinTranslator = { translate(text: string): Promise<string>; destroy?(): void };
type TranslatorApi = { availability(o: object): Promise<string>; create(o: object): Promise<BuiltinTranslator> };
export async function builtinTranslator(from: string, to: string): Promise<BuiltinTranslator | null> {
  const api = (globalThis as unknown as { Translator?: TranslatorApi }).Translator;
  if (!api) return null;
  try {
    const o = { sourceLanguage: from, targetLanguage: to };
    return (await api.availability(o)) === "available" ? await api.create(o) : null;
  } catch {
    return null;
  }
}

// Which model a feature uses: the visitor's choice ("cloud" for Claude,
// "cloudflare" for Workers AI alone, or a model on
// the device) when it's there, else the cloud AI when this site has it,
// else the largest model on the device.
const PICK = "nopload-ai-model";
// "device": on-device AI, with no model picked.
export type Choice = ModelId | typeof CLOUD | typeof CLOUDFLARE | "device";
export function chosenModel(): Choice | null {
  try {
    const v = localStorage.getItem(PICK);
    return v === CLOUD || v === CLOUDFLARE || v === "device" ? v : v && (MODEL_IDS as string[]).includes(v) ? (v as ModelId) : null;
  } catch {
    return null;
  }
}
export function chooseModel(id: Choice) {
  try {
    localStorage.setItem(PICK, id);
  } catch {
    /* private mode: the choice lasts this visit */
  }
}
