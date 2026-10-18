// Errors are translated, name the file, and point to the tool that fixes
// them. Raw parser or qpdf text never reaches the page.
//
//   node tests/e2e/errors.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { dict, open, pick, suite } from "./kit.mjs";

const RAW = /line:|offset|qpdf/i;

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // The alert carrying `text`; Next's route announcer is an empty alert too.
  const alertWith = (text) => page.getByRole("alert").filter({ hasText: text });

  for (const lang of ["en", "ar"]) {
    const t = dict(lang);
    for (const [slug, action] of [["organize-pdf", null], ["compress-pdf", "tool.compress.action"], ["pdf-to-word", "tool.pdfToWord.action"]]) {
      await test(`${lang}/${slug}: a text file isn't a PDF`, async () => {
        await open(page, `/${lang}/${slug}`);
        await pick(page, ["text-file.pdf"]);
        if (action) await page.getByRole("button", { name: t[action], exact: true }).click();
        const alert = alertWith(t["err.notPdf"]);
        await alert.waitFor({ timeout: 15000 });
        const text = await alert.innerText();
        if (RAW.test(text)) throw new Error(`raw text: ${text}`);
        if (!text.includes("text-file.pdf")) throw new Error(`no file name: ${text}`);
        return text.replace(/\s+/g, " ").slice(0, 60);
      });
    }
  }

  await test("sign-pdf: a protected file asks to unlock it", async () => {
    const t = dict("en");
    await open(page, "/en/sign-pdf");
    const t0 = Date.now();
    await pick(page, ["locked-report.pdf"]);
    const alert = alertWith(t["err.encrypted"]);
    await alert.waitFor({ timeout: 10000 });
    const ms = Date.now() - t0;
    const link = alert.getByRole("link", { name: t["tool.unlock.name"] });
    if ((await link.getAttribute("href")) !== "/en/unlock-pdf") throw new Error("no Unlock link");
    if (!(await alert.innerText()).includes("locked-report.pdf")) throw new Error("no file name");
    if (ms > 2000) throw new Error(`took ${ms} ms`);
    return `${ms} ms`;
  });

  await test("protect-pdf: a protected file is already protected", async () => {
    const t = dict("en");
    await open(page, "/en/protect-pdf");
    await pick(page, ["locked-report.pdf"]);
    await page.getByLabel(t["opt.password"], { exact: true }).fill("test1234");
    await page.getByLabel(t["opt.confirmPassword"], { exact: true }).fill("test1234");
    await page.getByRole("button", { name: t["tool.protect.action"], exact: true }).click();
    const alert = alertWith(t["err.alreadyEncrypted"]);
    await alert.waitFor({ timeout: 15000 });
    if (RAW.test(await alert.innerText())) throw new Error("raw text");
    return "already protected";
  });

  await test("jpg-to-pdf: HEIC is converted or explained", async () => {
    const t = dict("en");
    await open(page, "/en/jpg-to-pdf");
    await pick(page, ["photo.heic"]);
    const download = page.waitForEvent("download", { timeout: 15000 }).then(() => "converted", () => null);
    await page.getByRole("button", { name: t["tool.jpgToPdf.action"], exact: true }).click();
    const alert = alertWith(t["err.imageUnsupported"]);
    const outcome = await Promise.race([download, alert.waitFor({ timeout: 15000 }).then(() => "explained")]);
    // Chromium can't decode HEIC; WebKit can.
    if (name === "chromium" && outcome !== "explained") throw new Error(outcome ?? "nothing shown");
    if (!outcome) throw new Error("nothing shown");
    if (outcome === "explained" && !(await alert.innerText()).includes("photo.heic")) throw new Error("no file name");
    return outcome;
  });

  await ctx.close();
});
