// The AI worker: downloads models (./store.ts) and runs them with
// Transformers.js, so the page stays responsive. Everything it loads comes
// from this site: the runtime from /vendor, the weights from the device.
// Messages: see ./engine.ts.

import { VENDOR } from "../vendor";
import { download, folderOf, isStored, model, MODEL_IDS, remove, storedFile, type ModelId } from "./store";

type Transformers = typeof import("@huggingface/transformers");
type Msg = { id: number; type: string; [k: string]: unknown };

const post = (m: object) => (self as unknown as Worker).postMessage(m);
const MODELS = "/vendor/models/";

// Model files are read from the device; any other request is refused, so
// nothing can reach another site even by mistake.
async function localFetch(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
  if (url.origin === location.origin && url.pathname.startsWith(MODELS)) {
    const [folder, ...rest] = url.pathname.slice(MODELS.length).split("/");
    const id = MODEL_IDS.find((m) => folderOf(m) === folder);
    const file = id && (await storedFile(id, rest.join("/")));
    if (file) return new Response(file, { headers: { "content-length": String(file.size) } });
  }
  return new Response(null, { status: 404 });
}

let lib: Promise<Transformers> | null = null;
function transformers() {
  lib ??= (async () => {
    const t = await import("@huggingface/transformers");
    const { env } = t;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // A path, not a URL: Transformers.js only looks for "local" files at paths.
    env.localModelPath = MODELS;
    env.useBrowserCache = false;
    env.useWasmCache = false;
    env.useFS = false;
    env.fetch = localFetch as typeof fetch;
    // ONNX Runtime's WebGPU build from /vendor, never the CDN default. Its
    // .wasm is gzipped there (scripts/vendor.mjs).
    const ort = env.backends.onnx as { wasm: { wasmPaths?: unknown; wasmBinary?: ArrayBuffer; numThreads?: number; proxy?: boolean } };
    const base = new URL(`${VENDOR}ai/`, location.origin).href;
    // The .mjs is fetched here too, though ONNX Runtime imports it itself
    // later, so the service worker has it for offline use.
    const [gz] = await Promise.all([fetch(`${base}ort-wasm-simd-threaded.asyncify.wasm.gz`), fetch(`${base}ort-wasm-simd-threaded.asyncify.mjs`).then((r) => r.arrayBuffer())]);
    if (!gz.ok || !gz.body) throw new Error(`AI runtime: HTTP ${gz.status}`);
    ort.wasm.wasmBinary = await new Response(gz.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    ort.wasm.wasmPaths = { mjs: `${base}ort-wasm-simd-threaded.asyncify.mjs` };
    ort.wasm.proxy = false;
    // Threads need cross-origin isolation, which most pages here don't have.
    if (!self.crossOriginIsolated) ort.wasm.numThreads = 1;
    return t;
  })();
  return lib;
}

// WebGPU with 16-bit floats runs the q4f16 models; the light model runs on the CPU anywhere.
async function gpu(): Promise<{ webgpu: boolean; f16: boolean }> {
  const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } };
  try {
    const adapter = await nav.gpu?.requestAdapter();
    return { webgpu: !!adapter, f16: !!adapter?.features.has("shader-f16") };
  } catch {
    return { webgpu: false, f16: false };
  }
}

// Loaded models, one at a time for the language models (they're large).
let embedder: Promise<(texts: string[], o: object) => Promise<{ tolist(): number[][] }>> | null = null;
type Lm = { id: ModelId; tokenizer: { apply_chat_template(m: unknown, o: object): unknown }; model: { generate(o: object): Promise<unknown>; dispose(): Promise<unknown> }; device: string };
let lm: Promise<Lm> | null = null;
let lmId: ModelId | null = null;

function loadEmbedder() {
  embedder ??= (async () => {
    const t = await transformers();
    const id = "light" as ModelId;
    if (!(await isStored(id))) throw new Error("model light: not downloaded");
    // Built by hand: pipeline() first probes which files exist, a request per file.
    const name = folderOf(id);
    const [tokenizer, m] = await Promise.all([t.AutoTokenizer.from_pretrained(name), t.AutoModel.from_pretrained(name, { dtype: model(id).dtype as "q8", device: "wasm" })]);
    return new t.FeatureExtractionPipeline({ task: "feature-extraction", model: m, tokenizer } as never) as unknown as (texts: string[], o: object) => Promise<{ tolist(): number[][] }>;
  })();
  embedder.catch(() => (embedder = null));
  return embedder;
}

async function loadLm(id: ModelId, device: string) {
  if (lm && lmId === id) return lm;
  if (lm) {
    const old = lm;
    lm = null;
    await (await old.catch(() => null))?.model.dispose();
  }
  lmId = id;
  lm = (async () => {
    const t = await transformers();
    if (!(await isStored(id))) throw new Error(`model ${id}: not downloaded`);
    const name = folderOf(id);
    const [tokenizer, m] = await Promise.all([
      t.AutoTokenizer.from_pretrained(name),
      t.AutoModelForCausalLM.from_pretrained(name, { dtype: model(id).dtype as "q4f16", device: device as "webgpu" }),
    ]);
    return { id, tokenizer, model: m, device } as unknown as Lm;
  })();
  lm.catch(() => {
    lm = null;
    lmId = null;
  });
  return lm;
}

const aborts = new Map<number, AbortController>();

async function handle(req: Msg) {
  switch (req.type) {
    case "status": {
      const stored = Object.fromEntries(await Promise.all(MODEL_IDS.map(async (m) => [m, await isStored(m)])));
      return { stored, ...(await gpu()) };
    }
    case "download": {
      const ctl = new AbortController();
      aborts.set(req.id, ctl);
      await download(req.model as ModelId, (done, total) => post({ id: req.id, event: { done, total } }), ctl.signal);
      // Keep it: ask the browser not to clear this site's storage under pressure.
      await navigator.storage.persist?.().catch(() => false);
      return true;
    }
    case "remove": {
      const id = req.model as ModelId;
      if (lmId === id) {
        const old = lm;
        lm = null;
        lmId = null;
        await (await old?.catch(() => null))?.model.dispose();
      }
      if (id === "light") embedder = null;
      await remove(id);
      return true;
    }
    case "embed": {
      const run = await loadEmbedder();
      const texts = req.texts as string[];
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 16) {
        out.push(...(await run(texts.slice(i, i + 16), { pooling: "mean", normalize: true })).tolist());
        post({ id: req.id, event: { done: Math.min(texts.length, i + 16), total: texts.length } });
      }
      return out;
    }
    case "load": {
      const g = await gpu();
      await loadLm(req.model as ModelId, g.f16 ? "webgpu" : "wasm");
      return g.f16 ? "webgpu" : "wasm";
    }
    case "generate": {
      const g = await gpu();
      const { tokenizer, model: m } = await loadLm(req.model as ModelId, g.f16 ? "webgpu" : "wasm");
      const t = await transformers();
      const ctl = new AbortController();
      aborts.set(req.id, ctl);
      const stop = new t.InterruptableStoppingCriteria();
      ctl.signal.addEventListener("abort", () => stop.interrupt());
      let text = "";
      const streamer = new t.TextStreamer(tokenizer as never, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (s: string) => {
          text += s;
          post({ id: req.id, event: { text: clean(text) } });
        },
      });
      // Qwen3 answers straight away rather than thinking aloud first.
      const inputs = tokenizer.apply_chat_template(req.messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false }) as object;
      await m.generate({ ...inputs, max_new_tokens: req.maxNewTokens ?? 320, do_sample: false, repetition_penalty: 1.1, streamer, stopping_criteria: [stop] });
      return clean(text);
    }
    // Loads the runtime (code and WebAssembly) without a model, so it's kept for offline use.
    case "prepare":
      await transformers();
      return true;
    case "abort":
      aborts.get(req.target as number)?.abort();
      return true;
  }
  throw new Error(`unknown request ${req.type}`);
}

// Any reasoning a model writes despite being told not to.
const clean = (s: string) => s.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();

self.addEventListener("message", async (e: MessageEvent<Msg>) => {
  const req = e.data;
  try {
    post({ id: req.id, result: await handle(req) });
  } catch (err) {
    post({ id: req.id, error: err instanceof Error ? err.message : String(err), aborted: aborts.get(req.id)?.signal.aborted ?? false });
  } finally {
    aborts.delete(req.id);
  }
});
