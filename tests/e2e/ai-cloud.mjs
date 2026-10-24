// Server AI in real browsers, with /api/ai (functions/api/ai.ts) stood in
// for by the test. On a device that can't run the models (forced "weak"),
// it's the AI tools' default, the panel says what is sent, only text is
// sent (never the file), the answer says server AI wrote it, a failing
// server falls back to the device, and "On this device" sends nothing and
// is remembered. On a device that can (forced "capable"), there's no server
// AI at all, and a model that fails to run brings it back.
//
//   node tests/e2e/ai-cloud.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const dir = mkdtempSync(join(tmpdir(), "e2e-ai-cloud-"));

// Twenty pages of project notes, with the invoice on page 14.
const twenty = join(dir, "twenty.pdf");
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 20; i++) {
    const page = doc.addPage([595, 842]);
    const lines = i === 14
      ? ["Invoice INV-2041", "Bill to: Northwind Traders", "The invoice total is $1,234.50, due on 30 November."]
      : [`Section ${i}`, `This section describes project milestone ${i} and the risks the team saw.`];
    lines.forEach((l, j) => page.drawText(l, { x: 60, y: 760 - j * 22, size: 12, font }));
  }
  writeFileSync(twenty, await doc.save());
}

async function ask(page, question) {
  const n = await page.locator("[data-answer]").count();
  await page.getByLabel(t["chat.ask"]).fill(question);
  await page.getByRole("button", { name: t["chat.send"], exact: true }).click();
  const answer = page.locator("[data-answer]").nth(n);
  await page.waitForFunction((i) => document.querySelectorAll("[data-answer]")[i]?.getAttribute("data-answer") === "done", n, { timeout: 60000 });
  const pages = await answer.locator("[data-citation]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-citation"))));
  return { text: (await answer.innerText()).trim(), pages };
}

await suite(async ({ browser, test }) => {
  // The service worker would hide /api/ai from the stand-in.
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  // Which kind of device this is (src/lib/ai/engine.ts deviceCanRunModels).
  let device = "weak";
  await ctx.exposeBinding("deviceKind", () => device);
  await ctx.addInitScript(async () => localStorage.setItem("nopload-ai-device", await window.deviceKind()));
  const page = await ctx.newPage();
  // How the stand-in answers next, and what it was sent.
  let mode = { status: 200, provider: "anthropic" };
  const posts = [];
  await ctx.route("**/api/ai", async (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: { anthropic: true, cloudflare: true } });
    const body = req.postDataJSON();
    posts.push({ body, bytes: req.postDataBuffer()?.length ?? 0 });
    if (mode.status !== 200) return route.fulfill({ status: mode.status, json: { error: "no AI provider answered" } });
    const headers = { "X-AI-Provider": mode.provider };
    if (body.task === "chat") {
      const n = body.sources.split("\n").find((l) => l.includes("$1,234.50"))?.match(/^\[(\d+)\]/)?.[1] ?? "1";
      return route.fulfill({ headers, contentType: "text/plain", body: `The invoice total is $1,234.50 [${n}].` });
    }
    if (body.task === "summarize") return route.fulfill({ headers, contentType: "text/plain", body: Array.from({ length: body.points }, (_, i) => `- Cloud point ${i + 1}`).join("\n") });
    if (body.task === "translate") return route.fulfill({ headers, json: { texts: body.texts.map((s) => `ES ${s}`) } });
    return route.fulfill({ status: 400, json: { error: "unknown task" } });
  });

  await test("chat: the cloud AI is the default, and says what it sends", async () => {
    await open(page, "/en/chat-with-pdf");
    await pick(page, [twenty]);
    const panel = page.locator("[data-ai-models]");
    await page.locator("[data-ai-mode='cloud']").waitFor({ timeout: 15000 });
    const disclosure = await panel.locator("[data-ai-disclosure]").innerText();
    for (const key of ["ai.server.sends.chat", "ai.server.who"]) if (!disclosure.includes(t[key])) throw new Error(`no ${key}: ${disclosure}`);
    const link = await panel.locator("[data-ai-disclosure] a").getAttribute("href");
    if (link !== "/en/privacy#ai") throw new Error(`links ${link}`);
    return "cloud selected, disclosure shown";
  });

  await test("chat: Claude's answer cites page 14; only text was sent", async () => {
    await page.waitForFunction(() => !document.querySelector("#chat-q")?.disabled, null, { timeout: 30000 });
    const a = await ask(page, "What is the invoice total?");
    if (a.pages[0] !== 14 || !a.text.includes("$1,234.50")) throw new Error(`cited ${a.pages}: ${a.text}`);
    if (!a.text.includes(t["chat.by.server"])) throw new Error(`no attribution: ${a.text}`);
    const { body, bytes } = posts.at(-1);
    if (body.task !== "chat" || body.question !== "What is the invoice total?") throw new Error(JSON.stringify(body).slice(0, 200));
    if (bytes > 20000 || JSON.stringify(body).includes("%PDF")) throw new Error(`sent ${bytes} bytes`);
    return `cites p. ${a.pages.join(", ")}, sent ${bytes} bytes`;
  });

  await test("chat: the backup's answers say so", async () => {
    mode = { status: 200, provider: "cloudflare" };
    const a = await ask(page, "When is the invoice due?");
    if (!a.text.includes(t["chat.by.server"])) throw new Error(a.text);
    return "Cloudflare named";
  });

  await test("chat: when the cloud fails, the device answers and says why", async () => {
    mode = { status: 503 };
    const a = await ask(page, "What is the invoice total?");
    if (a.pages[0] !== 14) throw new Error(`cited ${a.pages}: ${a.text}`);
    if (!a.text.includes(t["chat.cloudFailed"]) || !a.text.includes(t["chat.by.keywords"])) throw new Error(a.text);
    mode = { status: 200, provider: "anthropic" };
    return "fell back to keywords";
  });

  await test("chat: On this device states its limits, sends nothing, and is remembered", async () => {
    await page.locator("[data-ai-choice='device']").click();
    await page.locator("[data-ai-mode='device']").waitFor();
    const limits = await page.locator("[data-ai-device]").innerText();
    if (!limits.includes(t["ai.device.limits"])) throw new Error(limits);
    const before = posts.length;
    const a = await ask(page, "What is the invoice total?");
    if (posts.length !== before) throw new Error("sent a request");
    if (a.pages[0] !== 14 || !a.text.includes(t["chat.by.keywords"])) throw new Error(a.text);
    await open(page, "/en/chat-with-pdf");
    await pick(page, [twenty]);
    await page.locator("[data-ai-mode='device']").waitFor({ timeout: 15000 });
    await page.locator("[data-ai-choice='cloud']").click();
    await page.locator("[data-ai-mode='cloud']").waitFor();
    return "device answer, choice kept after reload";
  });

  await test("summarize: written by Claude, labelled, text only", async () => {
    await open(page, "/en/summarize-pdf");
    await pick(page, ["report.pdf"]);
    await page.locator("[data-ai-mode='cloud']").waitFor({ timeout: 15000 });
    const disclosure = await page.locator("[data-ai-disclosure]").innerText();
    if (!disclosure.includes(t["ai.server.sends.summarize"])) throw new Error(disclosure);
    await page.getByRole("button", { name: t["tool.summarize.action"], exact: true }).click();
    await page.locator("[data-summary]").waitFor({ timeout: 60000 });
    const summary = await page.locator("[data-summary]").innerText();
    if (!summary.includes("Cloud point 5")) throw new Error(summary);
    for (const key of ["res.summaryServer", "ws.processedServerAi"]) if (!(await page.getByText(t[key]).count())) throw new Error(`no ${key}`);
    const { body } = posts.at(-1);
    if (body.task !== "summarize" || body.points !== 5 || !body.text.includes("Revenue grew")) throw new Error(JSON.stringify(body).slice(0, 200));
    return summary.split("\n")[0];
  });

  await test("translate: blocks go in batches, the PDF is rebuilt here", async () => {
    await open(page, "/en/translate-pdf");
    await pick(page, ["report.pdf"]);
    await page.locator("[data-ai-mode='cloud']").waitFor({ timeout: 15000 });
    await page.getByRole("radio", { name: new RegExp(`^${t["choice.translateFormat.md"].split(":")[0]}`) }).click();
    const before = posts.length;
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.getByRole("button", { name: t["tool.translate.action"], exact: true }).click(),
    ]);
    const md = readFileSync(await dl.path(), "utf8");
    if (!/^ES /m.test(md)) throw new Error(md.slice(0, 200));
    const sent = posts.slice(before);
    if (!sent.length || sent.some((p) => p.body.task !== "translate" || p.body.language !== "es")) throw new Error(JSON.stringify(sent[0]?.body).slice(0, 200));
    if (!(await page.getByText(t["res.translateServer"]).count())) throw new Error("no attribution");
    return `${sent.length} request(s), ${sent.reduce((n, p) => n + p.body.texts.length, 0)} blocks`;
  });

  await test("a capable device: on-device only, told what a download gives", async () => {
    device = "capable";
    await open(page, "/en/chat-with-pdf");
    await pick(page, [twenty]);
    await page.locator("[data-ai-capable]").waitFor({ timeout: 15000 });
    const panel = await page.locator("[data-ai-models]").innerText();
    for (const key of ["ai.capable.chat", "ai.capable.why"]) if (!panel.includes(t[key])) throw new Error(`no ${key}: ${panel}`);
    if (await page.locator("[data-ai-choice='cloud']").count()) throw new Error("server AI offered");
    await page.waitForFunction(() => !document.querySelector("#chat-q")?.disabled, null, { timeout: 30000 });
    const before = posts.length;
    const a = await ask(page, "What is the invoice total?");
    if (posts.length !== before) throw new Error("sent a request");
    if (a.pages[0] !== 14) throw new Error(a.text);
    return "no server AI, nothing sent";
  });

  await test("a capable device whose model fails is offered server AI", async () => {
    // What markDeviceFailed (src/lib/ai/engine.ts) does when a model doesn't run.
    await page.evaluate(() => {
      localStorage.removeItem("nopload-ai-device");
      localStorage.setItem("nopload-ai-device-failed", "1");
      window.dispatchEvent(new Event("nopload:ai-device-failed"));
    });
    await page.locator("[data-ai-fell-back]").waitFor({ timeout: 5000 });
    await page.locator("[data-ai-mode='cloud']").waitFor();
    device = "weak";
    return t["ai.deviceFailed"];
  });

  await test("the AI tools' pages say AI on device or server, not 'Runs on your device'", async () => {
    await open(page, "/en/chat-with-pdf");
    const pill = await page.locator("header .pill").filter({ hasText: t["home.aiBadge"] }).count();
    const local = await page.locator("header .pill").filter({ hasText: t["home.privateBadge"] }).count();
    if (!pill || local) throw new Error(`aiBadge ${pill}, privateBadge ${local}`);
    return t["home.aiBadge"];
  });

  await ctx.close();
});
