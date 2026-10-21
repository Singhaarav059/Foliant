// Count strings in the dictionaries (src/lib/i18n/format.ts): plural blocks
// like {n|one:# file|other:# files} pick the form the language's plural rules
// ask for, so "1 matches" and "Add at least 1 files" never appear.
//
//   node tests/plural.mjs
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "../src/lib/i18n/format.ts";

let failed = 0;
const test = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${label}  ${e.message}`);
  }
};
const eq = (got, want) => {
  if (got !== want) throw new Error(`got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

const matches = "{n|one:# match marked|other:# matches marked}";
test("English: one", () => eq(format(matches, { n: 1 }), "1 match marked"));
test("English: other", () => eq(format(matches, { n: 3 }), "3 matches marked"));
test("English: zero is plural", () => eq(format(matches, { n: 0 }), "0 matches marked"));
test("English is the default locale", () => eq(format("{n|one:# file|other:# files}", { n: 1 }, undefined), "1 file"));

const ru = "{n|one:# страница|few:# страницы|many:# страниц|other:# страницы}";
test("Russian: 1, 21 take one", () => eq([1, 21].map((n) => format(ru, { n }, "ru")).join(", "), "1 страница, 21 страница"));
test("Russian: 2, 24 take few", () => eq([2, 24].map((n) => format(ru, { n }, "ru")).join(", "), "2 страницы, 24 страницы"));
test("Russian: 5, 11 take many", () => eq([5, 11].map((n) => format(ru, { n }, "ru")).join(", "), "5 страниц, 11 страниц"));

const ar = "{n|zero:لا تغييرات|one:تغيير واحد|two:تغييران|few:# تغييرات|many:# تغييرًا|other:# تغيير}";
test("Arabic: zero, one, two, few, many", () =>
  eq([0, 1, 2, 3, 11, 100].map((n) => format(ar, { n }, "ar")).join(" / "), "لا تغييرات / تغيير واحد / تغييران / 3 تغييرات / 11 تغييرًا / 100 تغيير"));

test("a missing form falls back to other", () => eq(format("{n|other:# 件}", { n: 1 }, "ja"), "1 件"));
test("plain placeholders still fill in around a block", () =>
  eq(format("{name}: {n|one:# page|other:# pages}", { name: "a.pdf", n: 2 }), "a.pdf: 2 pages"));
test("a block whose count isn't given is left alone", () => eq(format("{n|one:# page|other:# pages}", { m: 1 }), "{n|one:# page|other:# pages}"));
test("an unknown locale uses English rules", () => eq(format("{n|one:# page|other:# pages}", { n: 1 }, "xx-invalid-!"), "1 page"));

// Every dictionary's own count strings, at 1 and at a plural count.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/lib/i18n/dict");
const parse = (file) => {
  const out = {};
  for (const m of readFileSync(join(dir, file), "utf8").matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) out[m[1]] = JSON.parse(`"${m[2]}"`);
  return out;
};
const counted = ["ws.pages", "ws.needMore", "ws.remoteBlocked", "ed.redactFound", "cmp.changes"];
const en = parse("en.ts");
test("English count strings read right for 1", () => {
  eq(format(en["ws.pages"], { n: 1 }), "1 page");
  eq(format(en["ws.needMore"], { n: 1 }), "Add at least 1 file.");
  eq(format(en["ed.redactFound"], { n: 1 }), "1 match marked");
  eq(format(en["cmp.changes"], { n: 1 }), "1 change");
});
for (const file of readdirSync(dir)) {
  const locale = file.replace(/\.ts$/, "");
  const d = parse(file);
  test(`${locale}: count strings fill in with no braces left`, () => {
    for (const k of counted) {
      for (const n of [0, 1, 2, 5, 21]) {
        const s = format(d[k] ?? en[k], { n }, locale);
        if (/[{}|#]/.test(s) || !s.includes(String(n)) && !(locale === "ar" && n <= 2)) throw new Error(`${k} at ${n}: ${s}`);
      }
    }
  });
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
