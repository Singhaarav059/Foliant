// Form autofill (P3-07) in real browsers: details saved once (encrypted, on
// this device) fill a form's "Applicant Name", "D.O.B" and "Pin code"
// fields, each highlighted for review, and the saved PDF has the values;
// after a reload the details stay locked until the passphrase is given; and
// clearing the site's data removes them.
//
//   node tests/e2e/autofill.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const dir = mkdtempSync(join(tmpdir(), "e2e-autofill-"));
const formPdf = join(dir, "admission.pdf");
{
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  for (const [k, name] of ["Applicant Name", "D.O.B", "Pin code", "Remarks"].entries()) {
    page.drawText(name, { x: 60, y: 760 - k * 50, size: 12, font });
    form.createTextField(name).addToPage(page, { x: 200, y: 752 - k * 50, width: 250, height: 22 });
  }
  writeFileSync(formPdf, await doc.save());
}
const PASS = "monsoon-lotus-42";

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const panel = () => page.locator("[data-autofill]");
  const load = async () => {
    await open(page, "/en/pdf-forms");
    await pick(page, [formPdf]);
    await panel().waitFor();
  };

  await test("set up details, fill the form: three fields filled and highlighted", async () => {
    await load();
    await page.getByRole("button", { name: t["af.setUp"] }).click();
    await panel().getByLabel(t["af.field.fullName"], { exact: true }).fill("Asha Rao");
    await panel().getByLabel(t["af.field.dob"], { exact: true }).fill("2001-08-15");
    await panel().getByLabel(t["af.field.pincode"], { exact: true }).fill("560001");
    await panel().getByLabel(t["af.newPassphrase"], { exact: true }).fill(PASS);
    await panel().getByLabel(t["af.repeatPassphrase"], { exact: true }).fill(PASS);
    await page.getByRole("button", { name: t["af.save"] }).click();
    await page.locator("[data-action=autofill]").click();
    const got = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("main label[data-autofilled] input")].map((i) => [i.getAttribute("aria-label"), i.value]).filter(([k]) => k)));
    const want = { "Applicant Name": "Asha Rao", "D.O.B": "15/08/2001", "Pin code": "560001" };
    for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`${k}: ${JSON.stringify(got[k])} (all: ${JSON.stringify(got)})`);
    if ("Remarks" in got) throw new Error("Remarks was filled");
    return "3 fields";
  });

  await test("the saved PDF has the values", async () => {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByRole("button", { name: t["tool.forms.action"], exact: true }).locator("visible=true").first().click()]);
    const path = join(dir, `${name}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    const form = (await PDFDocument.load(readFileSync(path))).getForm();
    const v = (f) => form.getTextField(f).getText();
    if (v("Applicant Name") !== "Asha Rao" || v("Pin code") !== "560001") throw new Error(`${v("Applicant Name")} / ${v("Pin code")}`);
  });

  await test("after a reload the details are locked; a wrong passphrase doesn't open them", async () => {
    await load();
    await page.waitForSelector("[data-autofill=locked]");
    await panel().getByLabel(t["af.passphrase"], { exact: true }).fill("not it");
    await page.getByRole("button", { name: t["af.unlock"] }).click();
    await page.getByText(t["af.wrongPass"]).waitFor();
    await panel().getByLabel(t["af.passphrase"], { exact: true }).fill(PASS);
    await page.getByRole("button", { name: t["af.unlock"] }).click();
    await page.waitForSelector("[data-autofill=unlocked]");
  });

  await test("clearing the site's data removes the details", async () => {
    if (name !== "chromium") return "Chromium only (clears site data over CDP)";
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Storage.clearDataForOrigin", { origin: new URL(page.url()).origin, storageTypes: "all" });
    await load();
    await page.waitForSelector("[data-autofill=none]");
  });
  await ctx.close();
});
