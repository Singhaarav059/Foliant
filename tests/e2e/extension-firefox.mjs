// The browser add-on (extension/) in Firefox, against the static build: the
// same handoff as extension.mjs checks in Chromium, with the Firefox zip's
// event-page background and Firefox's content-script isolation.
//
//   npm run build:static
//   node tests/e2e/extension-firefox.mjs
//
// Playwright's Firefox can't load add-ons, so this drives a release Firefox
// (FIREFOX_PATH, else the usual install locations) over WebDriver BiDi, which
// installs the add-on as a temporary one. Browser menus can't be clicked from
// a test, so it calls the menu's handler in the add-on's background page,
// reached from the add-on's own open.html. Firefox runs with
// --remote-allow-system-access only so the test can open that page.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checksum, fail, FILES, onCleanup, ok, report, requireBrowser, setup, SITE, t, test } from "./extension-kit.mjs";

const firefox = requireBrowser(
  [process.env.FIREFOX_PATH, "/Applications/Firefox.app/Contents/MacOS/firefox", "/usr/bin/firefox", "/snap/bin/firefox"].find((p) => p && existsSync(p)),
  "no Firefox found (set FIREFOX_PATH)",
);
const { temp, ext, hits, big } = await setup();

// A fixed internal id, so the test knows the add-on's moz-extension:// address.
const UUID = "6c1b2a3e-0d4f-4e5a-9b7c-1a2b3c4d5e6f";
const EXT = `moz-extension://${UUID}`;
const profile = join(temp, "profile");
mkdirSync(profile, { recursive: true });
const prefs = {
  "extensions.webextensions.uuids": JSON.stringify({ "open-in@nopload": UUID }),
  "intl.accept_languages": "en-US",
  "browser.shell.checkDefaultBrowser": false,
  "datareporting.policy.dataSubmissionEnabled": false,
};
writeFileSync(join(profile, "user.js"), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`).join(""));

// Firefox keeps some state outside the profile (on macOS in Application
// Support, which a sandboxed parent process may not create). MOZ_APP_DATA
// keeps it in the temporary folder.
for (const d of ["data", "local"]) mkdirSync(join(temp, d));
const proc = spawn(firefox, ["-headless", "-no-remote", "-profile", profile, "--remote-debugging-port=0", "--remote-allow-system-access"], {
  env: { ...process.env, MOZ_APP_DATA: join(temp, "data"), MOZ_LOCAL_APP_DATA: join(temp, "local") },
  stdio: ["ignore", "ignore", "pipe"],
});
onCleanup(() => proc.kill());
const endpoint = await new Promise((resolve, reject) => {
  let log = "";
  const timer = setTimeout(() => reject(new Error(`Firefox didn't start: ${log.slice(-300)}`)), 30000);
  proc.stderr.on("data", (d) => {
    log += d;
    const m = log.match(/WebDriver BiDi listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  proc.on("exit", (code) => reject(new Error(`Firefox exited (${code}): ${log.slice(-300)}`)));
});

// A minimal WebDriver BiDi client.
const ws = new WebSocket(`${endpoint}/session`);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("no BiDi connection"));
});
let nextId = 0;
const waiting = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  const w = waiting.get(msg.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.type === "error") w.reject(new Error(`${msg.error}: ${msg.message}`));
  else w.resolve(msg.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
onCleanup(() => ws.close());

const evaluate = async (context, expression) => {
  const r = await send("script.evaluate", { expression, target: { context }, awaitPromise: true });
  if (r.type === "exception") throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* page still loading */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const tabs = async () => (await send("browsingContext.getTree", { maxDepth: 0 })).contexts;
const bar = (context) => evaluate(context, `document.querySelector("[data-extension-file]")?.innerText ?? ""`);

try {
  await send("session.new", { capabilities: {} });
  const { extension } = await send("webExtension.install", { extensionData: { type: "path", path: join(ext, "firefox") } });
  ok(extension === "open-in@nopload", `installed as ${extension}`);
  // What each page was handed, as a checksum, read back by the tests.
  await send("script.addPreloadScript", {
    functionDeclaration: `() => addEventListener("message", (e) => {
      if (e.data?.source !== "nopload-extension" || e.data.type !== "files") return;
      const b = new Uint8Array(e.data.files[0].data);
      let sum = 0;
      for (let i = 0; i < b.length; i++) sum = (sum * 33 + b[i]) >>> 0;
      window.__handed = { size: b.length, sum };
    })`,
  });

  // The add-on's own page, from which the tests reach its background page.
  // BiDi won't navigate to moz-extension:// pages, so the browser window
  // (reachable with --remote-allow-system-access) opens it.
  const [win] = (await send("browsingContext.getTree", { maxDepth: 0, "moz:scope": "chrome" })).contexts;
  const chromeEval = (expression) => evaluate(win.context, expression);
  await chromeEval(
    `gBrowser.selectedTab = gBrowser.addTab("${EXT}/open.html", { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); true`,
  );
  const control = await until(async () => (await tabs()).find((c) => c.url.startsWith(`${EXT}/open.html`))?.context, "the add-on's page");
  await until(() => evaluate(control, `document.readyState === "complete"`), "the add-on's page to load");

  // Runs "Open in Nopload" on a URL, as the menu does, and returns the tab it opens.
  async function openIn(url) {
    const before = new Set((await tabs()).map((c) => c.context));
    await evaluate(
      control,
      `Promise.all([browser.runtime.getBackgroundPage(), browser.tabs.getCurrent()])
        .then(([bg, tab]) => bg.openInNopload(${JSON.stringify(url)}, { after: tab })).then(() => true)`,
    );
    const tab = await until(async () => (await tabs()).find((c) => !before.has(c.context)), "a new tab");
    await until(async () => (await tabs()).find((c) => c.context === tab.context && c.url !== "about:blank"), "the new tab to load");
    return tab.context;
  }
  const url = async (context) => (await tabs()).find((c) => c.context === context)?.url ?? "";
  const close = (context) => send("browsingContext.close", { context });

  await test("a PDF link opens the tool picker with the file", async () => {
    const tab = await openIn(`${FILES}/files/report.pdf`);
    const text = await until(() => bar(tab), "the file bar");
    ok(text.includes(t["handoff.pick"].replace("{name}", "report.pdf")), `bar says "${text}"`);
    ok((await url(tab)) === `${SITE}/en`, `landed on ${await url(tab)}`);
    ok((await evaluate(tab, `document.querySelectorAll("[data-tool]").length`)) > 10, "no tool grid");
    await close(tab);
  });

  await test("the next tool starts with the file", async () => {
    const tab = await openIn(`${FILES}/files/report.pdf`);
    await until(() => bar(tab), "the file bar");
    await evaluate(tab, `document.querySelector('[data-tool="compress"]').click()`);
    const remove = `${t["ws.remove"]} report.pdf`;
    await until(() => evaluate(tab, `!!document.querySelector(${JSON.stringify(`button[aria-label="${remove}"]`)})`), "the file in Compress");
    ok(!(await bar(tab)), "the bar stayed after picking a tool");
    await close(tab);
  });

  await test("the file name comes from Content-Disposition", async () => {
    const tab = await openIn(`${FILES}/download?id=7`);
    const text = await until(() => bar(tab), "the file bar");
    ok(text.includes("Annual report 2026.pdf"), `bar says "${text}"`);
    await close(tab);
  });

  await test("a 4 MB file arrives byte for byte", async () => {
    const tab = await openIn(`${FILES}/files/big.pdf`);
    await until(() => bar(tab), "the file bar");
    const got = await evaluate(tab, `window.__handed`);
    const size = got?.find?.(([k]) => k === "size")?.[1]?.value;
    const sum = got?.find?.(([k]) => k === "sum")?.[1]?.value;
    ok(size === big.length && sum === checksum(big), `got ${size} bytes (sum ${sum}), sent ${big.length} (sum ${checksum(big)})`);
    await close(tab);
  });

  await test("the site downloaded nothing; the add-on fetched each file once", async () => {
    const expected = ["/files/report.pdf", "/files/report.pdf", "/download?id=7", "/files/big.pdf"];
    ok(JSON.stringify(hits) === JSON.stringify(expected), `requests: ${JSON.stringify(hits)}`);
  });

  await test("a file that isn't a PDF says so", async () => {
    const tab = await openIn(`${FILES}/files/fake.pdf`);
    ok((await url(tab)).startsWith(`${EXT}/open.html`), `opened ${await url(tab)}`);
    await until(async () => (await evaluate(tab, `document.getElementById("title").textContent`)) === "This isn't a PDF", "the error");
    await close(tab);
  });

  await test("a site not yet allowed asks first, for that site only", async () => {
    const before = hits.length;
    const tab = await openIn("http://localhost:3711/files/report.pdf");
    ok((await url(tab)).startsWith(`${EXT}/open.html`), `opened ${await url(tab)}`);
    await until(() => evaluate(tab, `!document.getElementById("allow").hidden && document.getElementById("text").textContent.includes("localhost")`), "the Allow button");
    ok(hits.length === before, "fetched before asking");
    // Once allowed, open.html asks the add-on to go on, in the same tab.
    await evaluate(tab, `browser.runtime.sendMessage({ type: "open", url: "http://127.0.0.1:3711/files/report.pdf" }).then(() => true)`);
    await until(async () => (await url(tab)) === `${SITE}/en`, "the same tab to open Nopload");
    await until(() => bar(tab), "the file bar");
    await close(tab);
  });

  await test("a normal visit shows no bar", async () => {
    const { context: tab } = await send("browsingContext.create", { type: "tab" });
    await send("browsingContext.navigate", { context: tab, url: `${SITE}/en`, wait: "complete" });
    await until(() => evaluate(tab, `document.querySelectorAll("[data-tool]").length > 0`), "the tool grid");
    await sleep(1000);
    ok(!(await bar(tab)), "a bar without a file");
    await close(tab);
  });

  await test("the add-on logged no errors", async () => {
    const errors = await chromeEval(
      `Services.console.getMessageArray().filter((m) => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
        .map((m) => m.sourceName + ": " + m.errorMessage).filter((s) => s.startsWith("${EXT}")).join(" | ")`,
    );
    ok(!errors, errors);
  });
} catch (e) {
  fail("launch", e);
}
report("firefox");
