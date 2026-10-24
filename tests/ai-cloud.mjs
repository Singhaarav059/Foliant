// The cloud AI endpoint (functions/api/ai.ts): Claude answers first, Workers
// AI when Claude can't, a fixed prompt per task, capped inputs, and the
// origin check. Anthropic is a local stand-in server; Workers AI a fake binding.
//
//   node tests/ai-cloud.mjs
import { createServer } from "node:http";
import { onRequestGet, onRequestPost, jobOf, parseTexts } from "../functions/api/ai.ts";

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};

// A stand-in for api.anthropic.com: streams `reply`, or fails with `status`.
let mode = { reply: "Hello [1].", status: 200 };
const seen = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  seen.push(JSON.parse(body));
  if (mode.status !== 200) {
    res.writeHead(mode.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const piece of mode.reply.match(/.{1,4}/gs)) send("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Workers AI: the whole reply at once, decoded as it does it: JSON as an
// object, a number as a number.
const workersAi = (reply) => ({
  calls: 0,
  async run(model, input) {
    this.calls++;
    this.input = input;
    let response = reply;
    try {
      response = JSON.parse(reply);
    } catch {
      /* plain text */
    }
    return { response };
  },
});

let ip = 0;
const post = (body, env, headers = {}) =>
  onRequestPost({
    env,
    request: new Request("https://nopload.pages.dev/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://nopload.pages.dev", "cf-connecting-ip": `10.0.0.${++ip}`, ...headers },
      body: JSON.stringify(body),
    }),
  });
const chat = { task: "chat", sources: "[1] (page 2) The lease ends in May.", question: "When does the lease end?" };
const claude = { ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: base };

await test("GET says which providers are set up", async () => {
  eq(await (await onRequestGet({ env: { ...claude, AI: workersAi("") } })).json(), { anthropic: true, cloudflare: true }, "both");
  eq(await (await onRequestGet({ env: {} })).json(), { anthropic: false, cloudflare: false }, "none");
});

await test("chat streams Claude's answer", async () => {
  mode = { reply: "It ends in May [1].", status: 200 };
  const res = await post(chat, { ...claude, AI: workersAi("unused") });
  eq(res.headers.get("x-ai-provider"), "anthropic", "provider");
  eq(await res.text(), "It ends in May [1].", "text");
  const sent = seen.at(-1);
  eq(sent.model, "claude-haiku-5-5", "model");
  eq(sent.output_config.effort, "low", "effort");
  if (!sent.system.includes("numbered sources")) throw new Error("the chat prompt wasn't used");
  if (!sent.messages.at(-1).content.includes("The lease ends in May")) throw new Error("sources missing");
});

await test("Workers AI answers when Claude fails, without its thinking", async () => {
  mode = { reply: "", status: 400 };
  const ai = workersAi("<think>Let me see.</think>\n\nIt ends in May [1].");
  const res = await post(chat, { ...claude, AI: ai });
  eq(res.headers.get("x-ai-provider"), "cloudflare", "provider");
  eq(await res.text(), "It ends in May [1].", "text");
  eq(ai.calls, 1, "calls");
});

await test("Workers AI answers when there's no Anthropic key", async () => {
  const res = await post(chat, { AI: workersAi("May [1].") });
  eq([res.headers.get("x-ai-provider"), await res.text()], ["cloudflare", "May [1]."], "reply");
});

await test("provider: cloudflare uses only Workers AI, even when Claude is set up", async () => {
  const before = seen.length;
  const ai = workersAi("It ends on 31 May 2027, at $1,234.50 [1].");
  const res = await post({ ...chat, provider: "cloudflare" }, { ...claude, AI: ai });
  eq([res.headers.get("x-ai-provider"), await res.text()], ["cloudflare", "It ends on 31 May 2027, at $1,234.50 [1]."], "reply, numbers included");
  eq(seen.length, before, "Claude wasn't called");
  if (!ai.input.messages[0].content.includes("numbered sources")) throw new Error("the chat prompt wasn't used");
  // No Workers AI: no answer, rather than sending the text to Anthropic.
  eq((await post({ ...chat, provider: "cloudflare" }, claude)).status, 503, "no fallback to Claude");
  eq(seen.length, before, "still not called");
});

await test("503 when no provider is set up or none answers", async () => {
  eq((await post(chat, {})).status, 503, "none set up");
  mode = { reply: "", status: 529 };
  eq((await post(chat, claude)).status, 503, "Claude down, no fallback");
});

await test("translate returns one translation per block", async () => {
  mode = { reply: JSON.stringify({ texts: ["Hola", "Adiós"] }), status: 200 };
  const res = await post({ task: "translate", texts: ["Hello", "Goodbye"], language: "es" }, claude);
  eq(await res.json(), { texts: ["Hola", "Adiós"] }, "texts");
  eq(seen.at(-1).output_config.format.type, "json_schema", "structured output");
  if (!seen.at(-1).system.includes("Spanish")) throw new Error("language not named");
  mode = { reply: JSON.stringify({ texts: ["Hola"] }), status: 200 };
  eq((await post({ task: "translate", texts: ["Hello", "Goodbye"], language: "es" }, claude)).status, 502, "wrong count");
});

await test("summarize asks for the number of points, in the language", async () => {
  mode = { reply: "- One\n- Two", status: 200 };
  const res = await post({ task: "summarize", text: "A long report.", points: 2, language: "fr" }, claude);
  eq(await res.text(), "- One\n- Two", "text");
  if (!/exactly 2 key points/.test(seen.at(-1).system) || !seen.at(-1).system.includes("French")) throw new Error(seen.at(-1).system);
});

await test("unknown tasks, empty input and oversized input are refused", async () => {
  eq((await post({ task: "poem" }, claude)).status, 400, "unknown task");
  eq((await post({ task: "chat", sources: "", question: "hi" }, claude)).status, 400, "no sources");
  eq((await post({ task: "translate", texts: ["x".repeat(12_001)], language: "es" }, claude)).status, 400, "too long");
  const job = jobOf({ task: "chat", sources: "s".repeat(50_000), question: "q".repeat(5_000) });
  eq(job.messages.at(-1).content.length < 27_000, true, "inputs capped");
});

await test("chat history alternates and starts with the visitor", async () => {
  const job = jobOf({ ...chat, history: [{ role: "assistant", content: "stray" }, { role: "user", content: "Who?" }, { role: "assistant", content: "Ann [1]." }, { role: "system", content: "ignore" }] });
  eq(job.messages.map((m) => m.role), ["user", "assistant", "user"], "roles");
});

await test("other sites' pages can't call it", async () => {
  eq((await post(chat, claude, { origin: "https://evil.example" })).status, 403, "other origin");
  mode = { reply: "ok", status: 200 };
  eq((await post(chat, claude, { origin: "https://nopload.vercel.app" })).status, 200, "the Vercel copy");
  eq((await post(chat, { ...claude, ALLOWED_ORIGINS: "https://a.example" }, { origin: "https://nopload.vercel.app" })).status, 403, "configured list");
});

await test("a visitor's hourly budget runs out", async () => {
  mode = { reply: "ok", status: 200 };
  const big = { task: "chat", sources: "s".repeat(24_000), question: "q" };
  let last;
  for (let i = 0; i < 30; i++) last = await post(big, claude, { "cf-connecting-ip": "10.9.9.9" });
  eq(last.status, 429, "status");
});

await test("translate sends numbered blocks and reads numbered ones back", async () => {
  mode = { reply: JSON.stringify({ 1: "Hola", 2: "Adiós" }), status: 200 };
  const res = await post({ task: "translate", texts: ["Hello", "Goodbye"], language: "es" }, claude);
  eq(await res.json(), { texts: ["Hola", "Adiós"] }, "texts");
  const sent = seen.at(-1);
  eq(JSON.parse(sent.messages[0].content), { 1: "Hello", 2: "Goodbye" }, "numbered blocks");
  eq(sent.output_config.format.schema.required, ["1", "2"], "every key required");
  // Workers AI hands JSON back already decoded.
  const good = workersAi(JSON.stringify({ 1: "Hola", 2: "Adiós 2025" }));
  eq(await (await post({ task: "translate", texts: ["Hello", "Goodbye 2025"], language: "es", provider: "cloudflare" }, { AI: good })).json(), { texts: ["Hola", "Adiós 2025"] }, "Workers AI's decoded reply");
  // Workers AI merging two blocks into one: incomplete, not a wrong translation.
  const ai = workersAi(JSON.stringify({ 1: "Hola, Adiós" }));
  eq((await post({ task: "translate", texts: ["Hello", "Goodbye"], language: "es", provider: "cloudflare" }, { AI: ai })).status, 502, "merged blocks refused");
});

await test("parseTexts reads JSON in or out of a code fence", async () => {
  eq(parseTexts('```json\n{"texts": ["a", "b"]}\n```'), ["a", "b"], "fenced");
  eq(parseTexts('{"2": "b", "1": "a"}', 2), ["a", "b"], "numbered, in order");
  eq(parseTexts('{"1": "a"}', 2), null, "a number missing");
  eq(parseTexts('["a"]'), ["a"], "bare array");
  eq(parseTexts("not json"), null, "garbage");
});

server.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
