// Files get in however the user offers them: dropped on the page at any
// stage, pasted, or picked before the page has finished loading.
//
//   node tests/e2e/intake.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { readFileSync } from "node:fs";
import { base, dict, fixture, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const bytes = (name) => [...readFileSync(fixture(name))];

// Dispatches a file drop the way the OS does: dragenter, dragover, drop.
// Returns whether the page cancelled dragover; if it didn't, the browser
// would open the file itself and the session would be gone.
function drop(page, name, type, target = "body") {
  return page.evaluate(([data, name, type, target]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], name, { type }));
    const el = document.querySelector(target) ?? document.body;
    const fire = (kind) => {
      const e = new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    };
    fire("dragenter");
    const cancelled = fire("dragover");
    fire("drop");
    return cancelled;
  }, [bytes(name), name, type, target]);
}

function paste(page, name, type) {
  return page.evaluate(([data, name, type]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], name, { type }));
    let e;
    try {
      e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    } catch {
      e = new Event("paste", { bubbles: true, cancelable: true });
    }
    // Firefox's ClipboardEvent takes no clipboardData (its init dictionary
    // has only data and dataType) and gives the event an empty one instead.
    if (!e.clipboardData?.files.length) Object.defineProperty(e, "clipboardData", { value: dt });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  }, [bytes(name), name, type]);
}

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // One "Remove <name>" button per listed file. (The sortable card around it
  // is a role=button too, named from its content, so match the attribute.)
  const files = () => page.locator(`button[aria-label^="${t["ws.remove"]} "]`);
  const waitFiles = (n) =>
    page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length === n, [`button[aria-label^="${t["ws.remove"]} "]`, n], { timeout: 10000 });

  await test("merge: a file dropped after the first is added", async () => {
    await open(page, "/en/merge-pdf");
    await pick(page, ["report.pdf"]);
    await waitFiles(1);
    const url = page.url();
    const cancelled = await drop(page, "report-v2.pdf", "application/pdf");
    if (!cancelled) throw new Error("dragover not cancelled: the browser would open the file");
    await waitFiles(2);
    if (page.url() !== url) throw new Error(`navigated to ${page.url()}`);
    return `${await files().count()} files`;
  });

  await test("merge: a dropped file of the wrong type is refused", async () => {
    const cancelled = await drop(page, "brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    if (!cancelled) throw new Error("dragover not cancelled");
    await page.getByRole("alert").filter({ hasText: t["ws.wrongType"].replace("{name}", "brief.docx") }).waitFor({ timeout: 5000 });
    if ((await files().count()) !== 2) throw new Error(`${await files().count()} files`);
    return "refused";
  });

  await test("merge: a pasted PDF is added", async () => {
    await open(page, "/en/merge-pdf");
    const taken = await paste(page, "report.pdf", "application/pdf");
    await waitFiles(1);
    await paste(page, "report-v2.pdf", "application/pdf");
    await waitFiles(2);
    return taken ? "2 files, paste handled" : "2 files";
  });

  await test("organize: dropping on the page board adds its pages", async () => {
    await open(page, "/en/organize-pdf");
    await pick(page, ["report.pdf"]);
    const cards = page.locator("main li");
    await page.waitForFunction(() => document.querySelectorAll("main li").length >= 3, null, { timeout: 15000 });
    const before = await cards.count();
    if (!(await drop(page, "report-v2.pdf", "application/pdf", "main li"))) throw new Error("dragover not cancelled");
    await page.waitForFunction((n) => document.querySelectorAll("main li").length > n, before, { timeout: 15000 });
    return `${before} → ${await cards.count()} pages`;
  });

  await test("sign: the editor doesn't let a drop navigate away", async () => {
    await open(page, "/en/sign-pdf");
    await pick(page, ["report.pdf"]);
    await page.waitForFunction(() => [...document.querySelectorAll("img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), null, { timeout: 15000 });
    const url = page.url();
    if (!(await drop(page, "report-v2.pdf", "application/pdf"))) throw new Error("dragover not cancelled");
    await page.waitForTimeout(300);
    if (page.url() !== url) throw new Error(`navigated to ${page.url()}`);
    return "stays";
  });

  await ctx.close();

  // Scripts are held back, so the page is painted but React hasn't hydrated:
  // the state a slow phone is in for a second or two.
  await test("a file picked before the page is interactive is kept", async () => {
    const c = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
    const p = await c.newPage();
    let release;
    const gate = new Promise((r) => (release = r));
    await c.route(/\/_next\/static\/chunks\/.*\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      await p.goto(base + "/en/merge-pdf", { waitUntil: "domcontentloaded" });
      const picker = p.getByText(t["ws.select"], { exact: true });
      await picker.waitFor({ timeout: 10000 });
      const hydrated = await p.evaluate(() => Object.keys(document.querySelector("input[type=file]") ?? {}).some((k) => k.startsWith("__react")));
      if (hydrated) throw new Error("page hydrated before the test could tap");
      const [chooser] = await Promise.all([p.waitForEvent("filechooser", { timeout: 5000 }), picker.click()]);
      await chooser.setFiles(fixture("report.pdf"));
      release();
      await p.locator(`button[aria-label="${t["ws.remove"]} report.pdf"]`).waitFor({ timeout: 20000 });
      const listed = await p.locator(`button[aria-label^="${t["ws.remove"]} "]`).count();
      if (listed !== 1) throw new Error(`${listed} files listed`);
      return "picker opened early, file listed after hydration";
    } finally {
      release();
      await c.close();
    }
  });
});
