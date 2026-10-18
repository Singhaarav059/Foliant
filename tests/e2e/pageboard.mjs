// The page board in real browsers: Shift-click selects a range, Organize
// interleaves, reverses and resets pages from several files, and Rotate takes
// several files (one rotated PDF each) and can turn only the portrait or only
// the landscape pages.
//
//   node tests/e2e/pageboard.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument } from "pdf-lib";
import { unzipSync } from "fflate";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const dir = mkdtempSync(join(tmpdir(), "e2e-pageboard-"));

// Each page's width tells it apart: file A's are 300, 301, …; file B's 500, 501, ….
async function make(name, sizes) {
  const doc = await PDFDocument.create();
  for (const s of sizes) doc.addPage(s);
  const path = join(dir, name);
  writeFileSync(path, await doc.save());
  return path;
}
const A = await make("A.pdf", [[300, 400], [301, 400], [302, 400]]);
const B = await make("B.pdf", [[500, 700], [501, 700], [502, 700]]);
const seven = await make("seven.pdf", Array.from({ length: 7 }, (_, i) => [400 + i, 600]));
const mixed = await make("mixed.pdf", [[400, 600], [600, 400], [400, 600], [600, 400]]);

const widths = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => Math.round(p.getWidth()));
const angles = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getRotation().angle);
const expect = (what, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what} ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

await suite(async ({ browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const cards = page.locator("main ul li");
  // Opens a tool with these files and waits for every page's thumbnail.
  const ready = async (path, files, count) => {
    await open(page, `/en/${path}`);
    await pick(page, files);
    await page.waitForFunction((n) => {
      const imgs = [...document.querySelectorAll("main ul li img")];
      return imgs.length === n && imgs.every((i) => i.src.startsWith("blob:") && i.naturalWidth > 0);
    }, count, { timeout: 30000 });
  };
  const button = (label) => page.getByRole("button", { name: label, exact: true }).first();
  const download = async (label) => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), button(label).click()]);
    return readFileSync(await dl.path());
  };

  await test("Shift-click selects every page in the range", async () => {
    await ready("extract-pages", [seven], 7);
    await cards.nth(1).getByRole("button").first().click();
    await cards.nth(5).getByRole("button").first().click({ modifiers: ["Shift"] });
    await page.getByText(t["ws.selected"].replace("{n}", "5"), { exact: true }).waitFor({ timeout: 5000 });
    expect("pages", await widths(await download(t["tool.extract.action"])), [401, 402, 403, 404, 405]);
    return "5 selected";
  });

  await test("Shift-click back from the last click selects backwards", async () => {
    await ready("extract-pages", [seven], 7);
    await cards.nth(5).getByRole("button").first().click();
    await cards.nth(2).getByRole("button").first().click({ modifiers: ["Shift"] });
    await page.getByText(t["ws.selected"].replace("{n}", "4"), { exact: true }).waitFor({ timeout: 5000 });
    return "4 selected";
  });

  await test("interleaving two 3-page files gives A1 B1 A2 B2 A3 B3", async () => {
    await ready("organize-pdf", [A, B], 6);
    await button(t["ws.interleave"]).click();
    const got = await widths(await download(t["tool.organize.action"]));
    expect("pages", got, [300, 500, 301, 501, 302, 502]);
    return JSON.stringify(got);
  });

  await test("reverse, then sort, then reset", async () => {
    await ready("organize-pdf", [A, B], 6);
    await button(t["ws.reverse"]).click();
    await cards.nth(0).hover();
    await cards.nth(0).getByRole("button", { name: t["ws.delete"], exact: true }).click();
    await button(t["ws.sortPages"]).click();
    await cards.nth(0).hover();
    await cards.nth(0).getByRole("button", { name: t["ws.rotateRight"], exact: true }).click();
    await button(t["ws.resetPages"]).click();
    const bytes = await download(t["tool.organize.action"]);
    expect("pages", await widths(bytes), [300, 301, 302, 500, 501, 502]);
    expect("angles", await angles(bytes), [0, 0, 0, 0, 0, 0]);
    return "reset brings back the deleted page and clears turns";
  });

  await test("two PDFs into Rotate give two rotated PDFs", async () => {
    await ready("rotate-pdf", [A, B], 6);
    await button(t["tool.rotate.action"]).click();
    await page.getByText("A-rotated.pdf", { exact: true }).waitFor({ timeout: 60000 });
    const zip = unzipSync(await download(t["res.downloadAll"]));
    const names = Object.keys(zip).sort();
    expect("files", names, ["A-rotated.pdf", "B-rotated.pdf"]);
    expect("A", await widths(zip["A-rotated.pdf"]), [300, 301, 302]);
    expect("B", await widths(zip["B-rotated.pdf"]), [500, 501, 502]);
    expect("A angles", await angles(zip["A-rotated.pdf"]), [90, 90, 90]);
    return names.join(", ");
  });

  for (const [label, want] of [["ws.rotateLandscape", [0, 90, 0, 90]], ["ws.rotatePortrait", [90, 0, 90, 0]]]) {
    await test(`${t[label]} turns only those`, async () => {
      await ready("rotate-pdf", [mixed], 4);
      await page.getByLabel(t["opt.angle"], { exact: true }).selectOption("0");
      await button(t[label]).click();
      await page.waitForFunction(() => [...document.querySelectorAll("main ul li img")].some((i) => /rotate\(90deg\)/.test(i.style.transform)), null, { timeout: 10000 });
      const got = await angles(await download(t["tool.rotate.action"]));
      expect("angles", got, want);
      return JSON.stringify(got);
    });
  }

  await ctx.close();
});
