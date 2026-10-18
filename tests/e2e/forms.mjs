// PDF forms in a real browser: the five newer field types (radio buttons,
// dropdown, list, date, signature) are drawn on a blank page, given options
// in the side panel and saved; the saved form is opened again, filled in,
// saved, and opened a third time with its values in place. Every saved file
// is read back with pdf.js, as a viewer would.
//
//   node tests/e2e/forms.mjs [chromium] [firefox] [webkit]   (see kit.mjs)
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dict, open, pick, suite } from "./kit.mjs";

const t = dict("en");
const downloads = mkdtempSync(join(tmpdir(), "e2e-forms-"));
const blankPdf = join(downloads, "blank.pdf");
{
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  writeFileSync(blankPdf, await doc.save());
}

// name → { type, value } for each field pdf.js finds, plus the list's choices
// as the widget holds them (the field object keeps only the first).
const readBack = async (path) => {
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(path)) }).promise;
  const out = {};
  for (const [name, widgets] of await pdf.getFieldObjects() ?? new Map()) {
    const ws = widgets.filter((w) => w.type);
    const on = ws.find((w) => w.type === "radiobutton" && w.value === w.exportValues);
    out[name] = { type: ws[0]?.type, value: ws[0]?.type === "radiobutton" ? on?.exportValues ?? "" : ws[0]?.value, items: ws[0]?.items?.map((i) => i.exportValue) };
  }
  for (const a of await (await pdf.getPage(1)).getAnnotations()) if (a.fieldName && out[a.fieldName] && a.fieldType === "Ch" && !a.combo) out[a.fieldName].value = a.fieldValue;
  return out;
};

await suite(async ({ name, browser, test }) => {
  const ctx = await browser.newContext({ acceptDownloads: true, locale: "en-US", viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const load = async (file) => {
    await open(page, "/en/pdf-forms");
    await pick(page, [file]);
    await page.waitForFunction(() => [...document.querySelectorAll("main img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0), null, { timeout: 30000 });
  };
  const save = async () => {
    const button = page.getByRole("button", { name: t["tool.forms.action"], exact: true }).locator("visible=true").first();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), button.click()]);
    const path = join(downloads, `${name}-${Date.now()}-${dl.suggestedFilename()}`);
    await dl.saveAs(path);
    return path;
  };
  // Picks a field tool and clicks the page at (x, y) fractions.
  const place = async (tool, x, y) => {
    step = tool;
    await page.getByRole("button", { name: t[tool], exact: true }).click();
    const img = page.locator("main img").first();
    const box = await img.boundingBox();
    // A click by position scrolls that part of the page into view first.
    await img.click({ position: { x: box.width * x, y: box.height * y } });
  };
  const panel = () => page.locator("aside");
  // The last field tool used, named in failures.
  let step = "";
  const setName = (v) => panel().getByLabel(t["ed.fieldName"], { exact: true }).fill(v);
  const setOptions = (v) => panel().getByLabel(t["ed.fieldOptions"], { exact: true }).fill(v);

  let made;
  await test("five new field types are drawn, set up and saved", async () => {
   try {
    await load(blankPdf);
    await place("ed.addRadio", 0.15, 0.1);
    await setName("pet");
    await setOptions("Cat\nDog\nFish");
    await panel().getByLabel(t["ed.fieldRequired"], { exact: true }).check();
    await place("ed.addDropdown", 0.15, 0.3);
    await setName("planet");
    await setOptions("Earth\nMars\nVenus");
    await place("ed.addList", 0.15, 0.42);
    await setName("fruit");
    await setOptions("Apple\nBanana\nCherry");
    await panel().getByLabel(t["ed.fieldMultiple"], { exact: true }).check();
    await place("ed.addDate", 0.15, 0.6);
    await setName("when");
    await panel().getByLabel(t["ed.fieldDateFormat"], { exact: true }).selectOption("DD/MM/YYYY");
    await place("ed.addSignatureField", 0.15, 0.72);
    await setName("sig");
    // The radio group shows its options on the page while it is being edited.
    const shown = await page.locator('[data-item="radio"]').innerText();
    if (!/Cat[\s\S]*Dog[\s\S]*Fish/.test(shown)) throw new Error(`radio on page shows "${shown}"`);
    made = await save();
    const got = await readBack(made);
    const types = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.type]));
    const want = { pet: "radiobutton", planet: "combobox", fruit: "listbox", when: "text", sig: "signature" };
    if (JSON.stringify(types) !== JSON.stringify(want)) throw new Error(`types ${JSON.stringify(types)}`);
    if (got.planet.items.join() !== "Earth,Mars,Venus") throw new Error(`dropdown items ${got.planet.items}`);
    const form = (await PDFDocument.load(readFileSync(made))).getForm();
    if (!form.getRadioGroup("pet").isRequired()) throw new Error("radio not required");
    if (form.getRadioGroup("pet").getOptions().join() !== "Cat,Dog,Fish") throw new Error("radio options");
    return Object.values(types).join(", ");
   } catch (e) {
    throw new Error(`${step}: ${e.message}`);
   }
  });

  let filled;
  await test("the saved form is filled in and keeps its values", async () => {
    if (!made) throw new Error("no form from the previous test");
    await load(made);
    await panel().getByLabel("pet", { exact: true }).selectOption("Dog");
    await panel().getByLabel("planet", { exact: true }).selectOption("Mars");
    await panel().getByLabel("fruit", { exact: true }).selectOption(["Apple", "Cherry"]);
    await panel().getByLabel("when", { exact: true }).fill("2026-10-18");
    // The empty signature field is listed, but there is nothing to type in it.
    if (!(await panel().getByText(t["ed.signatureFieldNote"]).count())) throw new Error("signature field not listed");
    filled = await save();
    const got = await readBack(filled);
    const values = Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.value]));
    const want = { pet: "Dog", planet: "Mars", fruit: ["Apple", "Cherry"], when: "18/10/2026", sig: null };
    for (const [k, v] of Object.entries(want)) {
      if (k !== "sig" && JSON.stringify(values[k]) !== JSON.stringify(v)) throw new Error(`${k}: ${JSON.stringify(values[k])}, expected ${JSON.stringify(v)}`);
    }
    return JSON.stringify(values);
  });

  await test("opened again, the filled form shows its values", async () => {
    if (!filled) throw new Error("no filled form from the previous test");
    await load(filled);
    const got = {
      pet: await panel().getByLabel("pet", { exact: true }).inputValue(),
      planet: await panel().getByLabel("planet", { exact: true }).inputValue(),
      fruit: await panel().getByLabel("fruit", { exact: true }).evaluate((el) => [...el.selectedOptions].map((o) => o.value)),
      when: await panel().getByLabel("when", { exact: true }).inputValue(),
    };
    const want = { pet: "Dog", planet: "Mars", fruit: ["Apple", "Cherry"], when: "2026-10-18" };
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(JSON.stringify(got));
    // Saving untouched changes nothing.
    const again = await readBack(await save());
    if (again.when.value !== "18/10/2026" || again.planet.value !== "Mars") throw new Error(JSON.stringify(again));
    return "values kept";
  });
});
