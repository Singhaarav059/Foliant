// Form field types (src/lib/pdf/forms.ts through edit.ts): radio groups,
// dropdowns, lists, date fields and empty signature fields, checked the way a
// viewer sees them (pdf.js getFieldObjects), filled, saved and opened again.
//
//   node tests/forms.mjs
import { PDFDocument, PDFName, PDFString, PDFHexString, degrees } from "pdf-lib";
import { load, openPdf, check, eq } from "./lib/load.mjs";

const { editPdf, fillForm, readFields } = await load("edit");
const forms = await load("forms");

const results = { failed: 0 };
const test = check(results);
const blank = async (rotate = 0) => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (rotate) page.setRotation(degrees(rotate));
  return new File([await doc.save()], "blank.pdf", { type: "application/pdf" });
};
const asFile = async (out, name = "out.pdf") => new File([await out[0].blob.arrayBuffer()], name, { type: "application/pdf" });
// pdf.js 6 gives a Map of name → [parent node (no type), ...widgets].
const fieldObjects = async (file) => {
  const map = await (await openPdf(new Uint8Array(await file.arrayBuffer()))).getFieldObjects();
  return Object.fromEntries([...(map ?? new Map())].map(([k, v]) => [k, v.filter((w) => w.type)]));
};
const pageText = async (file) => {
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  return (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(" ");
};

const five = [
  { id: "r", page: 0, kind: "radio", name: "pet", x: 0.1, y: 0.1, w: 0.25, h: 0.09, options: ["Cat", "Dog", "Fish"], required: true },
  { id: "d", page: 0, kind: "dropdown", name: "planet", x: 0.1, y: 0.25, w: 0.3, h: 0.035, options: ["Earth", "Mars", "Venus"] },
  { id: "l", page: 0, kind: "optionList", name: "fruit", x: 0.1, y: 0.35, w: 0.3, h: 0.1, options: ["Apple", "Banana", "Cherry"], multiple: true },
  { id: "t", page: 0, kind: "dateField", name: "when", x: 0.1, y: 0.5, w: 0.2, h: 0.035, dateFormat: "YYYY-MM-DD", tooltip: "Date of birth", required: true },
  { id: "s", page: 0, kind: "signatureField", name: "sig", x: 0.1, y: 0.6, w: 0.3, h: 0.07, tooltip: "Signature" },
];

let made;
await test("radio, dropdown, list, date and signature fields have the right pdf.js types", async () => {
  made = await asFile(await editPdf(await blank(), five, "forms"));
  const objs = await fieldObjects(made);
  const types = Object.fromEntries(Object.entries(objs).map(([k, v]) => [k, [...new Set(v.map((w) => w.type))].join()]));
  eq(JSON.stringify(types), JSON.stringify({ pet: "radiobutton", planet: "combobox", fruit: "listbox", when: "text", sig: "signature" }), "types");
  eq(objs.pet.length, 3, "radio buttons");
});

await test("options, required flags, multi-select and the date hint are stored", async () => {
  const doc = await PDFDocument.load(await made.arrayBuffer());
  const form = doc.getForm();
  eq(form.getRadioGroup("pet").getOptions().join(), "Cat,Dog,Fish", "radio options");
  eq(form.getDropdown("planet").getOptions().join(), "Earth,Mars,Venus", "dropdown options");
  eq(form.getOptionList("fruit").getOptions().join(), "Apple,Banana,Cherry", "list options");
  eq(form.getRadioGroup("pet").isRequired(), true, "radio required");
  eq(form.getTextField("when").isRequired(), true, "date required");
  eq(form.getDropdown("planet").isRequired(), false, "dropdown not required");
  const ff = form.getOptionList("fruit").acroField.getFlags();
  eq(Boolean(ff & (1 << 21)), true, "list multi-select flag");
  const tu = form.getTextField("when").acroField.dict.lookup(PDFName.of("TU"));
  eq(tu instanceof PDFString || tu instanceof PDFHexString ? tu.decodeText() : "", "Date of birth (YYYY-MM-DD)", "date tooltip");
  // A date field asks for no JavaScript: no actions anywhere.
  eq(form.getTextField("when").acroField.dict.has(PDFName.of("AA")), false, "no actions");
});

await test("radio options are labelled on the page", async () => {
  const text = await pageText(made);
  for (const w of ["Cat", "Dog", "Fish"]) if (!text.includes(w)) throw new Error(`no "${w}" in "${text}"`);
});

await test("readFields reports each type, with the date format and the signature", async () => {
  const fields = await readFields(made);
  const by = Object.fromEntries(fields.map((f) => [f.name, f]));
  eq(by.pet.type, "radio", "pet");
  eq(by.planet.type, "dropdown", "planet");
  eq(by.fruit.type, "list", "fruit");
  eq(by.when.type, "date", "when");
  eq(by.when.dateFormat, "YYYY-MM-DD", "when format");
  eq(by.sig.type, "signature", "sig");
  eq(by.pet.required, true, "pet required");
});

let filled;
await test("filled values open in pdf.js and survive another save", async () => {
  filled = await asFile(await fillForm(made, { pet: "Dog", planet: "Mars", fruit: ["Apple", "Cherry"], when: "2026-10-18" }, [], false));
  const again = await asFile(await fillForm(filled, {}, [], false));
  for (const [label, file] of [["first save", filled], ["second save", again]]) {
    const objs = await fieldObjects(file);
    eq(objs.planet[0].value, "Mars", `${label}: dropdown`);
    // The field object holds the first choice; the widget pdf.js draws holds all of them.
    const annots = await (await (await openPdf(new Uint8Array(await file.arrayBuffer()))).getPage(1)).getAnnotations();
    eq(JSON.stringify(annots.find((a) => a.fieldName === "fruit").fieldValue), JSON.stringify(["Apple", "Cherry"]), `${label}: list`);
    eq(objs.when[0].value, "2026-10-18", `${label}: date`);
    const on = objs.pet.filter((w) => w.value === w.exportValues);
    eq(on.length, 1, `${label}: one radio on`);
    eq(on[0].exportValues, "Dog", `${label}: radio`);
  }
  const fields = Object.fromEntries((await readFields(again)).map((f) => [f.name, f.value]));
  eq(JSON.stringify(fields), JSON.stringify({ pet: "Dog", planet: "Mars", fruit: ["Apple", "Cherry"], when: "2026-10-18", sig: "" }), "readFields");
});

await test("flattening a form with an empty signature field works", async () => {
  const flat = await asFile(await fillForm(filled, {}, [], true));
  eq(Object.keys(await fieldObjects(flat)).length, 0, "fields left");
  const text = await pageText(flat);
  if (!text.includes("Mars")) throw new Error(`flattened page lacks the dropdown value: "${text}"`);
});

await test("a radio group on a page turned 90° sits where it was placed", async () => {
  const file = await asFile(await editPdf(await blank(90), [five[0]], "forms"));
  const pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const rects = (await pdf.getFieldObjects()).get("pet").filter((w) => w.type).map((w) => [...vp.convertToViewportPoint(w.rect[0], w.rect[1]), ...vp.convertToViewportPoint(w.rect[2], w.rect[3])]);
  const xs = rects.flatMap((r) => [r[0], r[2]]).map((x) => x / vp.width);
  const ys = rects.flatMap((r) => [r[1], r[3]]).map((y) => y / vp.height);
  const it = five[0];
  if (Math.min(...xs) < it.x - 0.01 || Math.max(...xs) > it.x + it.w + 0.01) throw new Error(`x ${Math.min(...xs).toFixed(3)}–${Math.max(...xs).toFixed(3)}`);
  if (Math.min(...ys) < it.y - 0.01 || Math.max(...ys) > it.y + it.h + 0.01) throw new Error(`y ${Math.min(...ys).toFixed(3)}–${Math.max(...ys).toFixed(3)}`);
  // Three buttons, one above the other in the view.
  const tops = rects.map((r) => Math.min(r[1], r[3])).sort((a, b) => a - b);
  if (!(tops[1] - tops[0] > 5 && tops[2] - tops[1] > 5)) throw new Error(`buttons not stacked: ${tops.map(Math.round)}`);
});

await test("two fields given the same name both survive", async () => {
  const file = await asFile(await editPdf(await blank(), [five[1], { ...five[1], id: "d2", y: 0.8 }], "forms"));
  eq(Object.keys(await fieldObjects(file)).sort().join(), "planet,planet_2", "names");
});

await test("date values convert between ISO and the field's format", async () => {
  eq(forms.formatDate("2026-03-07", "DD/MM/YYYY"), "07/03/2026", "dmy");
  eq(forms.formatDate("2026-03-07", "MM/DD/YYYY"), "03/07/2026", "mdy");
  eq(forms.parseDate("07/03/2026", "DD/MM/YYYY"), "2026-03-07", "parse dmy");
  eq(forms.parseDate("13/13/2026", "MM/DD/YYYY"), "", "bad date");
  eq(forms.dateFormatOf("Date of birth (MM/DD/YYYY)"), "MM/DD/YYYY", "from tooltip");
  eq(forms.dateFormatOf("Notes"), undefined, "plain field");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
