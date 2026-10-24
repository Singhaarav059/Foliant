// /api/ai: the cloud AI behind Chat, Summarize and Translate PDF, as a
// Cloudflare Pages Function (Vercel forwards /api/ai here, see
// scripts/vercel-output.mjs). Claude Haiku (Anthropic) answers first;
// when it can't (no key, out of credit, overloaded, down), Cloudflare
// Workers AI does. The page only ever sends the text a task needs, never
// the file, and it falls back to on-device AI when this endpoint fails.
//
// The prompts live here, one per task, so the endpoint can't be used as a
// general-purpose chatbot, and every input is capped in size.
//
//   GET  /api/ai → { anthropic, cloudflare }: which providers are set up.
//   POST /api/ai { task: "chat", sources, question, history? }      → text, streamed
//   POST /api/ai { task: "summarize", text, points, language }      → text, streamed
//   POST /api/ai { task: "translate", texts, language }             → { texts }
// Any of them may add provider: "cloudflare" to use only Workers AI (the
// visitor chose it; their text then never goes to Anthropic). Otherwise
// Claude answers and Workers AI is its backup.
// The X-AI-Provider response header names who answered.
//
// Settings (Cloudflare dashboard → the Pages project → Settings):
//   ANTHROPIC_API_KEY   secret; without it Workers AI answers every request.
//   AI                  Workers AI binding; without it there's no fallback.
//   ALLOWED_ORIGINS     other sites whose pages may call this, comma-separated
//                       (default: https://nopload.vercel.app).
//   ANTHROPIC_MODEL, FALLBACK_MODEL, ANTHROPIC_BASE_URL   optional overrides.

import Anthropic from "@anthropic-ai/sdk";

type WorkersAi = { run(model: string, input: object): Promise<unknown> };
export type Env = {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  ANTHROPIC_BASE_URL?: string;
  FALLBACK_MODEL?: string;
  ALLOWED_ORIGINS?: string;
  AI?: WorkersAi;
};
type Context = { request: Request; env: Env };

const ANTHROPIC_MODEL = "claude-haiku-5-5";
const FALLBACK_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const DEFAULT_ORIGINS = ["https://nopload.vercel.app"];

// Input caps, in characters.
const MAX = { sources: 24_000, question: 2_000, history: 4, turn: 2_000, text: 60_000, texts: 12_000, items: 200 };

// Best effort, per visitor and per Worker instance (instances don't share
// memory): characters sent in the last hour. The hard cap on spending is the
// Anthropic account's own limit.
const HOUR = 3_600_000;
const BUDGET = 600_000;
const spent = new Map<string, { at: number; chars: number }>();
function allow(ip: string, chars: number) {
  const now = Date.now();
  if (spent.size > 10_000) for (const [k, v] of spent) if (now - v.at > HOUR) spent.delete(k);
  const s = spent.get(ip);
  const cur = s && now - s.at < HOUR ? s : { at: now, chars: 0 };
  if (cur.chars + chars > BUDGET) return false;
  spent.set(ip, { at: cur.at, chars: cur.chars + chars });
  return true;
}

type Message = { role: "user" | "assistant"; content: string };
type Job = { system: string; messages: Message[]; maxTokens: number; json?: boolean; count?: number };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const languageName = (tag: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? "English";
  } catch {
    return "English";
  }
};

// The request as a job for a model, or an error message.
export function jobOf(body: Record<string, unknown>): Job | string {
  if (body.task === "chat") {
    const sources = str(body.sources, MAX.sources);
    const question = str(body.question, MAX.question);
    if (!sources.trim() || !question.trim()) return "sources and question are required";
    const history = (Array.isArray(body.history) ? body.history : [])
      .slice(-MAX.history)
      .flatMap((m) => (m && (m.role === "user" || m.role === "assistant") ? [{ role: m.role, content: str(m.content, MAX.turn) } as Message] : []))
      .filter((m) => m.content.trim());
    // The API wants turns to alternate, starting with the user.
    while (history.length && history[0].role !== "user") history.shift();
    return {
      system:
        "You answer questions about a document using only the numbered sources from it. " +
        "Cite every fact with its source number in square brackets, like [1] or [2][3]. " +
        "If the sources don't contain the answer, say you couldn't find it in the document. " +
        "Answer briefly and plainly, in the language of the question, without Markdown headings.",
      messages: [...history, { role: "user", content: `Sources:\n${sources}\n\nQuestion: ${question}` }],
      maxTokens: 700,
    };
  }
  if (body.task === "summarize") {
    const text = str(body.text, MAX.text);
    if (!text.trim()) return "text is required";
    const points = Math.min(12, Math.max(1, Number(body.points) || 5));
    const language = languageName(str(body.language, 20) || "en");
    return {
      system:
        `You summarise documents. Write exactly ${points} key points as a Markdown list, one line each starting with "- ". ` +
        `Use only facts from the document. Write in ${language}. Reply with the list only.`,
      messages: [{ role: "user", content: text }],
      maxTokens: 120 * points + 200,
    };
  }
  if (body.task === "translate") {
    const list: unknown[] = Array.isArray(body.texts) ? body.texts : [];
    const texts = list.map((t) => (typeof t === "string" ? t : ""));
    const total = texts.reduce((n, t) => n + t.length, 0);
    if (!texts.length || texts.length > MAX.items || total > MAX.texts) return `texts: 1 to ${MAX.items} strings, ${MAX.texts} characters in all`;
    const language = languageName(str(body.language, 20) || "en");
    return {
      system:
        `You are a professional translator into ${language}. The user sends a JSON array of text blocks from one document. ` +
        `Reply with {"texts": [...]}: the same number of blocks, in the same order, each translated into ${language}. ` +
        "Keep numbers, codes, names and line breaks; translate nothing else into the reply.",
      messages: [{ role: "user", content: JSON.stringify(texts) }],
      maxTokens: Math.min(16_000, 400 + Math.ceil(total * 1.5)),
      json: true,
      count: texts.length,
    };
  }
  return "unknown task";
}

const charsOf = (job: Job) => job.system.length + job.messages.reduce((n, m) => n + m.content.length, 0);

// Text in pieces as a model writes it.
type Pieces = AsyncIterable<string>;

async function* anthropic(env: Env, job: Job, signal: AbortSignal): Pieces {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1 });
  const stream = client.messages.stream(
    {
      model: env.ANTHROPIC_MODEL || ANTHROPIC_MODEL,
      max_tokens: job.maxTokens,
      system: job.system,
      messages: job.messages,
      output_config: {
        effort: "low",
        ...(job.json
          ? { format: { type: "json_schema", schema: { type: "object", properties: { texts: { type: "array", items: { type: "string" } } }, required: ["texts"], additionalProperties: false } } }
          : {}),
      },
    },
    { signal },
  );
  for await (const event of stream) if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error("refused");
}

// Workers AI streams server-sent events: {"response": "..."} or, for
// chat-completion models, {"choices": [{"delta": {"content": "..."}}]};
// numeric tokens may come as numbers ({"response": 1}).
async function* cloudflare(env: Env, job: Job): Pieces {
  const out = await env.AI!.run(env.FALLBACK_MODEL || FALLBACK_MODEL, {
    messages: [{ role: "system", content: job.system + (job.json ? " Reply with JSON only." : "") + " /no_think" }, ...job.messages],
    max_tokens: job.maxTokens,
    stream: true,
  });
  if (!(out instanceof ReadableStream)) throw new Error("Workers AI didn't stream");
  const reader = out.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      try {
        const e = JSON.parse(data);
        // A token that is a number ("1", "2026") can arrive as a JSON number.
        const piece = e.response ?? e.choices?.[0]?.delta?.content;
        if ((typeof piece === "string" || typeof piece === "number") && piece !== "") yield String(piece);
      } catch {
        /* a partial or keep-alive line */
      }
    }
  }
}

// Drops a reasoning model's <think>…</think> as the text streams by.
async function* withoutThinking(pieces: Pieces): Pieces {
  let pending = "";
  let thinking = false;
  // Right after a thought (or at the start), leading blank lines are dropped.
  let trim = true;
  for await (const p of pieces) {
    pending += p;
    for (;;) {
      if (trim && !thinking) {
        pending = pending.replace(/^\s+/, "");
        if (!pending) break;
        trim = false;
      }
      if (thinking) {
        const end = pending.indexOf("</think>");
        if (end < 0) break;
        pending = pending.slice(end + 8);
        thinking = false;
        trim = true;
      } else {
        const start = pending.indexOf("<think>");
        if (start >= 0) {
          if (start) yield pending.slice(0, start);
          pending = pending.slice(start + 7);
          thinking = true;
          continue;
        }
        // Hold back what could be the start of a tag.
        const keep = pending.lastIndexOf("<");
        const cut = keep >= 0 && "<think>".startsWith(pending.slice(keep)) ? keep : pending.length;
        if (cut) yield pending.slice(0, cut);
        pending = pending.slice(cut);
        break;
      }
    }
  }
  if (!thinking && pending) yield pending;
}

// Starts the first provider that answers: its name, its first piece and the rest.
async function start(env: Env, job: Job, signal: AbortSignal, only?: "cloudflare") {
  const tries: [string, () => Pieces][] = [];
  if (env.ANTHROPIC_API_KEY && !only) tries.push(["anthropic", () => anthropic(env, job, signal)]);
  if (env.AI) tries.push(["cloudflare", () => withoutThinking(cloudflare(env, job))]);
  for (const [provider, run] of tries) {
    const it = run()[Symbol.asyncIterator]();
    try {
      let first = await it.next();
      while (!first.done && !first.value) first = await it.next();
      if (first.done) throw new Error("empty reply");
      return { provider, first: first.value, it };
    } catch (e) {
      if (signal.aborted) throw e;
      console.warn(`${provider} failed:`, e instanceof Error ? e.message : e);
    }
  }
  return null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

function originAllowed(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
  return origin === new URL(request.url).origin || allowed.includes(origin);
}

export async function onRequestGet({ env }: Context) {
  return json({ anthropic: !!env.ANTHROPIC_API_KEY, cloudflare: !!env.AI });
}

export async function onRequestPost({ request, env }: Context) {
  if (!originAllowed(request, env)) return json({ error: "origin not allowed" }, 403);
  if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: "no AI provider is set up" }, 503);
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: "send JSON" }, 400);
  }
  const job = jobOf(body ?? {});
  if (typeof job === "string") return json({ error: job }, 400);
  // Requests forwarded by another copy (Vercel) come from its servers; the
  // visitor is the first address it forwarded for.
  const forwarded = request.headers.get("Origin") && request.headers.get("Origin") !== new URL(request.url).origin;
  const ip = (forwarded && request.headers.get("X-Forwarded-For")?.split(",")[0].trim()) || request.headers.get("CF-Connecting-IP") || "?";
  if (!allow(ip, charsOf(job))) return json({ error: "hourly limit reached" }, 429, { "Retry-After": "3600" });

  const signal = request.signal ?? new AbortController().signal;
  const started = await start(env, job, signal, body.provider === "cloudflare" ? "cloudflare" : undefined);
  if (!started) return json({ error: "no AI provider answered" }, 503);
  const headers = { "X-AI-Provider": started.provider, "Cache-Control": "no-store" };

  if (job.json) {
    let text = started.first;
    for (let r = await started.it.next(); !r.done; r = await started.it.next()) text += r.value;
    const texts = parseTexts(text);
    // The start of the reply comes back too (it's the visitor's own text), to see how a model got the format wrong.
    if (!texts || texts.length !== job.count) return json({ error: "the translation came back incomplete", got: texts?.length ?? null, reply: text.slice(0, 400) }, 502, headers);
    return json({ texts }, 200, headers);
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      c.enqueue(enc.encode(started.first));
      try {
        for (let r = await started.it.next(); !r.done; r = await started.it.next()) c.enqueue(enc.encode(r.value));
      } catch (e) {
        console.warn(`${started.provider} stopped:`, e instanceof Error ? e.message : e);
      }
      c.close();
    },
    cancel() {
      void started.it.return?.();
    },
  });
  return new Response(stream, { headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
}

// {"texts": [...]}, or a bare array, possibly wrapped in a code fence.
export function parseTexts(text: string): string[] | null {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const from = raw.search(/[[{]/);
  if (from < 0) return null;
  try {
    const v = JSON.parse(raw.slice(from, Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]")) + 1));
    const list = Array.isArray(v) ? v : v?.texts;
    return Array.isArray(list) && list.every((t) => typeof t === "string") ? list : null;
  } catch {
    return null;
  }
}
