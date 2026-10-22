// Workflow recipe links (P2-05): the steps go into the #fragment and come
// back the same; secrets, files and tools that can't be steps never travel;
// damaged or foreign links load nothing.
//
//   node tests/recipe.mjs
import { loadLib, check, eq } from "./lib/load.mjs";

const results = { failed: 0 };
const test = check(results);
const ok = (v, what) => {
  if (!v) throw new Error(what);
};
const { recipeHash, readRecipe, cleanSteps } = await loadLib("recipe");

const steps = [
  { tool: "compress", options: { level: "extreme", targetKb: "off" } },
  { tool: "pageNumbers", options: { position: "bottom-right", numberFormat: "custom", template: "Seite {page} — ü", startAt: 3 } },
];

await test("a recipe survives the round trip through a link", () => {
  const hash = recipeHash({ name: "Shrink + number ✓", steps });
  ok(hash.startsWith("#recipe="), hash);
  ok(/^#recipe=[A-Za-z0-9_-]+$/.test(hash), "base64url only, nothing to escape in a URL");
  const back = readRecipe(`https://example.org/en/workflows${hash}`.slice(`https://example.org/en/workflows`.length));
  eq(JSON.stringify(back), JSON.stringify({ name: "Shrink + number ✓", steps }), "same steps");
});

await test("passwords and files never go into a link", () => {
  const hash = recipeHash({ name: "Lock", steps: [{ tool: "protect", options: { password: "hunter2", confirmPassword: "hunter2", ownerPassword: "x", openPassword: true, allowPrint: false } }, { tool: "watermark", options: { markType: "image", markImage: { name: "logo.png" } } }] });
  const back = readRecipe(hash);
  eq(JSON.stringify(back.steps[0].options), JSON.stringify({ openPassword: true, allowPrint: false }), "protect keeps only switches");
  eq("markImage" in back.steps[1].options, false, "no image");
  ok(!Buffer.from(hash.slice(8), "base64url").toString().includes("hunter2"), "secret not in the link");
});

await test("no fragment, or another fragment, is no recipe", () => {
  eq(readRecipe(""), null, "empty");
  eq(readRecipe("#main"), null, "skip link");
});

await test("a damaged, foreign or oversized link loads nothing", () => {
  eq(readRecipe("#recipe="), "bad", "empty body");
  eq(readRecipe("#recipe=%%%"), "bad", "not base64");
  const enc = (o) => `#recipe=${Buffer.from(JSON.stringify(o)).toString("base64url")}`;
  eq(readRecipe(enc({ v: 2, name: "x", steps })), "bad", "newer version");
  eq(readRecipe(enc({ v: 1, name: "x", steps: [{ tool: "edit", options: {} }] })), "bad", "a tool that can't be a step");
  eq(readRecipe(enc({ v: 1, name: "x", steps: [] })), "bad", "no steps");
  eq(readRecipe(enc({ v: 1, name: "x", steps: [{ tool: "compress", options: [] }] })), "bad", "options not an object");
  eq(readRecipe(`#recipe=${"A".repeat(9000)}`), "bad", "too long");
});

await test("saved steps keep only plain values", () => {
  eq(JSON.stringify(cleanSteps([{ tool: "watermark", options: { markText: "X", opacity: 30, mosaic: true, markImage: { a: 1 }, extra: null } }])),
    JSON.stringify([{ tool: "watermark", options: { markText: "X", opacity: 30, mosaic: true } }]), "objects and nulls dropped");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
