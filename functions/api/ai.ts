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
//                       (Its replies aren't streamed: see cloudflare() below.)
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

// Best effort, per visitor (the address Cloudflare saw, which the sender
// can't choose) and per Worker instance (instances don't share memory):
// characters and requests in the last hour, and requests in the last
// minute, so neither big requests nor floods of small ones run up the bill.
// A 100-page translation is about 35 requests and 300,000 characters. The
// hard cap on spending is the Anthropic account's own limit.
const HOUR = 3_600_000;
const MINUTE = 60_000;
const LIMIT = { chars: 600_000, hour: 200, minute: 40 };
type Use = { at: number; chars: number; requests: number; minuteAt: number; minute: number };
const spent = new Map<string, Use>();
function allow(ip: string, chars: number) {
  const now = Date.now();
  if (spent.size > 10_000) for (const [k, v] of spent) if (now - v.at > HOUR) spent.delete(k);
  const prev = spent.get(ip);
  const use: Use = prev && now - prev.at < HOUR ? { ...prev } : { at: now, chars: 0, requests: 0, minuteAt: now, minute: 0 };
  if (now - use.minuteAt >= MINUTE) [use.minuteAt, use.minute] = [now, 0];
  if (use.chars + chars > LIMIT.chars || use.requests >= LIMIT.hour || use.minute >= LIMIT.minute) return false;
  spent.set(ip, { ...use, chars: use.chars + chars, requests: use.requests + 1, minute: use.minute + 1 });
  return true;
}

// The largest request a page sends is a summary: 60,000 characters, up to
// three bytes each, escaped in JSON. Anything bigger is refused unread.
const MAX_BODY = 400_000;
async function readBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      void reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

type Message = { role: "user" | "assistant"; content: string };
// json: the reply is a JSON object with the keys "1" to `count`.
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
    if (!list.every((t) => typeof t === "string") || !list.some((t) => (t as string).trim())) return "texts: strings, not all empty";
    const texts = list as string[];
    const total = texts.reduce((n, t) => n + t.length, 0);
    if (texts.length > MAX.items || total > MAX.texts) return `texts: 1 to ${MAX.items} strings, ${MAX.texts} characters in all`;
    const language = languageName(str(body.language, 20) || "en");
    return {
      system:
        `You are a professional translator into ${language}. The user sends a JSON object of numbered text blocks from one document. ` +
        `Reply with a JSON object with exactly the same keys, "1" to "${texts.length}", each holding that block translated into ${language}. ` +
        "Never merge or split blocks. Keep numbers, codes, names and line breaks; put nothing else in the reply.",
      // Numbered, so a model keeps each block on its own (a plain list let blocks run together).
      messages: [{ role: "user", content: JSON.stringify(Object.fromEntries(texts.map((t, i) => [String(i + 1), t]))) }],
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
          ? { format: { type: "json_schema", schema: keyedSchema(job.count ?? 0) } }
          : {}),
      },
    },
    { signal },
  );
  for await (const event of stream) if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") throw new Error("refused");
}

// Workers AI, asked for its whole reply rather than a stream: the stream
// decodes each token that looks like JSON on its own (the token `","`
// arrives as `,`, `2025` as a number), which can't be undone, and turned
// JSON replies into garbage. The whole reply is {"response": ...}, itself
// decoded when it's JSON or a number, or {"choices": [...]} for
// chat-completion models.
async function* cloudflare(env: Env, job: Job): Pieces {
  const out = (await env.AI!.run(env.FALLBACK_MODEL || FALLBACK_MODEL, {
    messages: [{ role: "system", content: job.system + (job.json ? " Reply with JSON only." : "") + " /no_think" }, ...job.messages],
    max_tokens: job.maxTokens,
  })) as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  const reply = out?.response ?? out?.choices?.[0]?.message?.content;
  if (reply === undefined || reply === null || reply === "") throw new Error("Workers AI gave no reply");
  yield typeof reply === "string" ? reply : typeof reply === "number" ? String(reply) : JSON.stringify(reply);
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

// Replies are data, never a page: no sniffing, nothing a browser would run or frame.
const SAFE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...SAFE, "Content-Type": "application/json", ...headers } });

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
  const raw = await readBody(request);
  if (raw === null) return json({ error: "request too large" }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return json({ error: "send JSON" }, 400);
  }
  const job = jobOf(body);
  if (typeof job === "string") return json({ error: job }, 400);
  // Only the address Cloudflare saw: headers like X-Forwarded-For are the sender's to write.
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  if (!allow(ip, charsOf(job))) return json({ error: "hourly limit reached" }, 429, { "Retry-After": "3600" });

  const signal = request.signal ?? new AbortController().signal;
  const started = await start(env, job, signal, body.provider === "cloudflare" ? "cloudflare" : undefined);
  if (!started) return json({ error: "no AI provider answered" }, 503);
  const headers = { ...SAFE, "X-AI-Provider": started.provider };

  if (job.json) {
    let text = started.first;
    for (let r = await started.it.next(); !r.done; r = await started.it.next()) text += r.value;
    const texts = parseTexts(text, job.count);
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

// The keys "1" to n, each a string: Claude's output is held to it.
const keyedSchema = (n: number) => {
  const keys = Array.from({ length: n }, (_, i) => String(i + 1));
  return { type: "object", properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])), required: keys, additionalProperties: false };
};

// The blocks of a reply, in order: {"1": ..., "2": ...} with every key from
// 1 to `count`, or (as some models answer anyway) {"texts": [...]} or a bare
// array; possibly in a code fence. Null when anything is missing.
export function parseTexts(text: string, count?: number): string[] | null {
  const raw = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const from = raw.search(/[[{]/);
  if (from < 0) return null;
  try {
    const v = JSON.parse(raw.slice(from, Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]")) + 1));
    const keyed = v && !Array.isArray(v) && typeof v === "object" && !Array.isArray(v.texts) && count ? Array.from({ length: count }, (_, i) => v[String(i + 1)]) : null;
    const list = keyed ?? (Array.isArray(v) ? v : v?.texts);
    return Array.isArray(list) && list.every((t) => typeof t === "string") ? list : null;
  } catch {
    return null;
  }
}
