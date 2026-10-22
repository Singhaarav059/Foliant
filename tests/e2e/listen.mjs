// Read PDF aloud (P2-16) in real browsers, with a stand-in speech engine
// that records what it's asked to say: the text shows in reading order,
// Listen starts speaking within 1 s, the passage and word being read are
// highlighted, and pause, next and stop do what they say.
//
//   node tests/e2e/listen.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { open, pick, suite } from "./kit.mjs";

// The stand-in: one voice, utterances queued and finished on demand.
const fakeSpeech = () => {
  const said = [];
  let queue = [];
  window.__speech = { said, queue: () => queue, finish: () => queue.shift()?.onend?.(), paused: false, cancelled: 0 };
  class U {
    constructor(text) {
      this.text = text;
    }
  }
  window.SpeechSynthesisUtterance = U;
  const synth = {
    getVoices: () => [{ name: "Test voice", lang: "en-US", localService: true, default: true }],
    addEventListener() {},
    removeEventListener() {},
    speak(u) {
      said.push({ text: u.text, at: performance.now() });
      queue.push(u);
      // The first word, as voices report it.
      setTimeout(() => u.onboundary?.({ name: "word", charIndex: 0, charLength: u.text.split(" ")[0].length }), 50);
    },
    pause() {
      window.__speech.paused = true;
    },
    resume() {
      window.__speech.paused = false;
    },
    cancel() {
      window.__speech.cancelled++;
      queue = [];
    },
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
};

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 } });
  await ctx.addInitScript(fakeSpeech);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);

  await test("the text shows in reading order", async () => {
    await open(page, "/en/read-pdf-aloud");
    await pick(page, ["report.pdf"]);
    await page.waitForSelector("[data-passage]");
    const first = await page.locator("[data-passage]").first().innerText();
    if (!/Quarterly/.test(first)) throw new Error(`first passage: ${first}`);
    return `${await page.locator("[data-passage]").count()} passages`;
  });

  await test("Listen starts speaking within 1 s, highlighting the passage and word", async () => {
    const t0 = await page.evaluate(() => performance.now());
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => window.__speech.said.length > 0, null, { timeout: 5000 });
    const ms = (await page.evaluate(() => window.__speech.said[0].at)) - t0;
    if (ms > 1000) throw new Error(`first words after ${Math.round(ms)} ms`);
    await page.waitForSelector("[data-passage='0'][aria-current] mark");
    return `${Math.round(ms)} ms`;
  });

  await test("pause, next paragraph and stop", async () => {
    await page.getByRole("button", { name: "Pause" }).click();
    if (!(await page.evaluate(() => window.__speech.paused))) throw new Error("not paused");
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByRole("button", { name: "Next paragraph" }).click();
    await page.waitForSelector("[data-passage='1'][aria-current]");
    await page.getByRole("button", { name: "Stop" }).click();
    await page.waitForSelector("[data-listen=idle]");
  });

  await test("reading moves on when a passage ends; a click jumps to any passage", async () => {
    await page.locator("[data-passage='2']").click();
    await page.waitForSelector("[data-passage='2'][aria-current]");
    const n = await page.evaluate(() => window.__speech.queue().length);
    for (let k = 0; k < n; k++) await page.evaluate(() => window.__speech.finish());
    await page.waitForSelector("[data-passage='3'][aria-current]");
  });

  await ctx.close();
});
