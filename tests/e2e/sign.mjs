// Sign PDF and the editor's text tool in real browsers: typed signatures use
// the bundled handwriting fonts, the action button is on screen on a phone,
// text typed right after clicking with the Text tool isn't lost, a signature
// can be made, placed and saved with the keyboard alone, and the signing
// extras (name, date format, stamp, placement presets) reach the saved file.
//
//   node tests/e2e/sign.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument, PDFDict, PDFName } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const downloads = mkdtempSync(join(tmpdir(), "e2e-sign-"));
// Image XObjects on each page of a saved PDF.
const images = async (path) => {
  const doc = await PDFDocument.load(readFileSync(path));
  return doc.getPages().map((p) => {
    const xo = p.node.Resources()?.lookup(PDFName.of("XObject"));
    return xo instanceof PDFDict ? xo.keys().length : 0;
  });
};
const textOf = async (path) => {
  const doc = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items.map((x) => x.str).join(""));
  return pages;
};

// A 300×120 PNG of a red ring on white paper, as a scanned stamp would be.
const stampPng = join(downloads, "stamp.png");
{
  const { createCanvas } = await import("@napi-rs/canvas");
  const c = createCanvas(300, 120);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 300, 120);
  ctx.strokeStyle = "#c81e1e";
  ctx.lineWidth = 10;
  ctx.strokeRect(20, 20, 260, 80);
  writeFileSync(stampPng, c.toBuffer("image/png"));
}

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  // WebKit on macOS skips buttons on Tab unless Option is held, as Safari does by default.
  const TAB = name === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";

  // Opens a tool with report.pdf and waits for the first page to render.
  const load = async (p, slug) => {
    await open(p, `/en/${slug}`);
    await pick(p, ["report.pdf"]);
    await p.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), null, { timeout: 30000 });
  };
  const save = async (p, button) => {
    const visible = p.getByRole("button", { name: button, exact: true }).locator("visible=true").first();
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 60000 }), visible.click()]);
    const path = join(downloads, `${name}-${Date.now()}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    return path;
  };
  const dialog = () => page.getByRole("dialog");
  // Makes a typed signature and leaves it waiting to be placed.
  const typedSignature = async (text) => {
    await page.getByRole("button", { name: t["ed.signature"], exact: true }).click();
    await dialog().getByRole("tab", { name: t["ed.typeTab"] }).click();
    await dialog().getByPlaceholder(t["ed.typeName"]).fill(text);
    await dialog().getByRole("button", { name: t["ed.useSignature"] }).click();
  };
  // Presses Tab until `match` holds for the focused element.
  const tabTo = async (what, match, arg) => {
    for (let i = 0; i < 80; i++) {
      if (await page.evaluate(match, arg)) return;
      await page.keyboard.press(TAB);
    }
    throw new Error(`Tab never reached ${what}`);
  };
  const named = ([role, label]) => {
    const el = document.activeElement;
    const text = (el?.getAttribute("aria-label") || el?.textContent || "").trim();
    return !!el && (el.getAttribute("role") || el.tagName.toLowerCase()) === role && text === label;
  };

  await test("typed signature uses a bundled handwriting font", async () => {
    await load(page, "sign-pdf");
    await page.getByRole("button", { name: t["ed.signature"], exact: true }).click();
    await dialog().getByRole("tab", { name: t["ed.typeTab"] }).click();
    await dialog().getByPlaceholder(t["ed.typeName"]).fill("Hello");
    await page.waitForFunction(() => [...document.fonts].some((f) => f.family.replace(/["']/g, "") === "Dancing Script" && f.status === "loaded"), null, { timeout: 10000 })
      .catch(() => { throw new Error("no bundled Dancing Script face loaded"); });
    const ok = await page.evaluate(() => document.fonts.check('40px "Dancing Script"', "Hello"));
    if (!ok) throw new Error("document.fonts.check failed");
    await page.keyboard.press("Escape");
    return "Dancing Script loaded";
  });

  await test("signature dialog is modal and keeps focus inside", async () => {
    await load(page, "sign-pdf");
    await page.getByRole("button", { name: t["ed.signature"], exact: true }).click();
    const modal = await page.evaluate(() => document.querySelector("dialog")?.matches(":modal") ?? false);
    if (!modal) throw new Error("not a modal <dialog>");
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(TAB);
      const inside = await page.evaluate(() => !!document.activeElement?.closest("dialog"));
      if (!inside) throw new Error(`focus left the dialog after ${i + 1} Tabs`);
    }
    await page.keyboard.press("Escape");
    if (await dialog().count()) throw new Error("Escape didn't close it");
    return "focus stayed in";
  });

  await test("signature placed and saved with the keyboard only", async () => {
    await load(page, "sign-pdf");
    await page.locator("body").focus();
    await tabTo("Signature", named, ["button", t["ed.signature"]]);
    await page.keyboard.press("Enter");
    await dialog().waitFor();
    await tabTo("Type tab", named, ["tab", t["ed.typeTab"]]);
    await page.keyboard.press("Enter");
    await tabTo("name box", () => document.activeElement?.tagName === "INPUT");
    await page.keyboard.type("Ada Lovelace");
    await tabTo("Use this signature", named, ["button", t["ed.useSignature"]]);
    await page.keyboard.press("Enter");
    await tabTo("Place at centre", named, ["button", t["ed.placeCentre"]]);
    await page.keyboard.press("Enter");
    // Nudge it with the arrow keys; the item moves.
    const before = await page.locator("[data-item][data-selected]").evaluate((el) => el.style.left);
    await page.keyboard.press("Shift+ArrowRight");
    const after = await page.locator("[data-item][data-selected]").evaluate((el) => el.style.left);
    if (before === after) throw new Error("arrow key didn't move it");
    await tabTo("Sign PDF", named, ["button", t["tool.sign.action"]]);
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.keyboard.press("Enter")]);
    const path = join(downloads, `${name}-kbd-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    const got = await images(path);
    if (!(got[0] > 0)) throw new Error(`images per page ${JSON.stringify(got)}`);
    return `images ${JSON.stringify(got)}`;
  });

  await test("placement presets: all but last, last, custom", async () => {
    const results = [];
    for (const [preset, custom, want] of [["allButLast", "", [1, 1, 0]], ["last", "", [0, 0, 1]], ["custom", "1,3", [1, 0, 1]]]) {
      await load(page, "sign-pdf");
      await typedSignature("Ada");
      await page.getByRole("button", { name: t["ed.placeCentre"] }).click();
      await page.getByLabel(t["ed.placeOn"], { exact: true }).selectOption(preset);
      if (custom) await page.getByLabel(t["ed.customPages"], { exact: true }).fill(custom);
      await page.getByRole("button", { name: t["ed.applyPlacement"], exact: true }).click();
      const got = (await images(await save(page, t["tool.sign.action"]))).map((n) => (n > 0 ? 1 : 0));
      if (got.join() !== want.join()) throw new Error(`${preset}: pages with a signature ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      results.push(preset);
    }
    return results.join(", ");
  });

  await test("name and ISO date reach the saved file", async () => {
    await load(page, "sign-pdf");
    await page.getByLabel(t["ed.yourName"], { exact: true }).fill("Grace Hopper");
    await page.getByRole("button", { name: t["ed.name"], exact: true }).click();
    await page.getByRole("button", { name: t["ed.placeCentre"] }).click();
    await page.getByLabel(t["ed.dateFormat"], { exact: true }).selectOption("iso");
    await page.getByRole("button", { name: t["ed.date"], exact: true }).click();
    await page.locator("main img").first().click({ position: { x: 100, y: 100 } });
    const text = (await textOf(await save(page, t["tool.sign.action"])))[0];
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (!text.includes("Grace Hopper")) throw new Error("name missing");
    if (!text.includes(iso)) throw new Error(`no ${iso} in "${text.slice(-60)}"`);
    return iso;
  });

  await test("stamp upload drops the paper and is placed", async () => {
    await load(page, "sign-pdf");
    await page.getByRole("button", { name: t["ed.stamp"], exact: true }).click();
    await dialog().locator("input[type=file]").setInputFiles(stampPng);
    await dialog().locator("img").waitFor();
    // White paper became transparent: the preview's corner pixel has no alpha.
    const alpha = await dialog().locator("img").last().evaluate(async (img) => {
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data[3];
    });
    if (alpha !== 0) throw new Error(`stamp centre alpha ${alpha}`);
    await dialog().getByRole("button", { name: t["ed.useStamp"] }).click();
    await page.getByRole("button", { name: t["ed.placeCentre"] }).click();
    const got = await images(await save(page, t["tool.sign.action"]));
    if (!(got[0] > 0)) throw new Error(`images per page ${JSON.stringify(got)}`);
    return "placed";
  });

  await test("phone: Sign PDF button is on screen", async () => {
    const phone = await browser.newContext({ locale: "en-US", viewport: { width: 375, height: 812 } });
    try {
      const p = await phone.newPage();
      await load(p, "sign-pdf");
      const box = await p.getByRole("button", { name: t["tool.sign.action"], exact: true }).locator("visible=true").first().boundingBox();
      if (!box || box.y < 0 || box.y + box.height > 812) throw new Error(`button at y=${box?.y}`);
      return `y=${Math.round(box.y)}`;
    } finally {
      await phone.close();
    }
  });

  await test("Text tool keeps keys typed right after the click (20 runs)", async () => {
    const p = await ctx.newPage();
    try {
      await load(p, "edit-pdf");
      if (name === "chromium") {
        const cdp = await ctx.newCDPSession(p);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      }
      const stage = p.locator("main img").first();
      const textTool = p.getByRole("button", { name: t["ed.text"], exact: true });
      const selectTool = p.getByRole("button", { name: t["ed.select"], exact: true });
      // The 20 clicks go 24 px apart down the page: scroll its top up to just
      // under the sticky header and toolbar, so the last ones aren't below the window.
      const top = (await stage.boundingBox()).y;
      await p.evaluate((dy) => window.scrollBy({ top: dy, behavior: "instant" }), top - 160);
      const bad = [];
      for (let i = 0; i < 20; i++) {
        await textTool.click();
        const box = await stage.boundingBox();
        const click = p.mouse.click(box.x + 40, box.y + 24 + i * 24);
        // Chromium: keys queued right behind the click, as a fast typist sends
        // them (CDP keeps the order). Other engines' drivers may deliver such
        // keys before the click, so they type once it has landed.
        if (name === "chromium") await Promise.all([click, p.keyboard.type("Hello")]);
        else {
          await click;
          await p.keyboard.type("Hello");
        }
        await selectTool.click();
        const texts = await p.locator("main div.whitespace-pre").allInnerTexts();
        if (texts.length !== i + 1 - bad.length || texts.at(-1)?.trim() !== "Hello") bad.push(`${i}:${JSON.stringify(texts.at(-1))}`);
      }
      if (bad.length) throw new Error(`${bad.length}/20 lost keys: ${bad.slice(0, 4).join(" ")}`);
      const text = (await textOf(await save(p, t["tool.edit.action"])))[0];
      const n = text.split("Hello").length - 1;
      if (n !== 20) throw new Error(`saved file has ${n} Hello`);
      return `20/20${name === "chromium" ? " at 4x CPU" : ""}`;
    } finally {
      await p.close();
    }
  });
});
