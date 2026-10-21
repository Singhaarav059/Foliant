// Reports, per language, which English keys are missing or still identical to
// English, and which keys don't exist in English at all. Placeholders like
// {n} must survive translation, so mismatches are listed too. A plural block,
// {n|one:# file|other:# files} (see src/lib/i18n/format.ts), counts as {n}; its
// forms must include "other" and use only the language's plural categories.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "src/lib/i18n/dict");
const parse = (file) => {
  const src = readFileSync(join(dir, file), "utf8");
  const out = {};
  for (const m of src.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) out[m[1]] = JSON.parse(`"${m[2]}"`);
  return out;
};
const en = parse("en.ts");
const keys = Object.keys(en);
const vars = (s) => [...new Set([...s.matchAll(/\{(\w+)[}|]/g)].map((m) => m[1]))].sort().join(",");
const pluralOk = (s, locale) => {
  const allowed = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  return [...s.matchAll(/\{\w+\|([^{}]*)\}/g)].every(([, body]) => {
    const cats = body.split("|").map((p) => p.slice(0, p.indexOf(":")).trim());
    return cats.includes("other") && cats.every((c) => allowed.includes(c));
  });
};
let bad = 0;
for (const file of readdirSync(dir).filter((f) => f !== "en.ts")) {
  const d = parse(file);
  const missing = keys.filter((k) => !(k in d));
  const extra = Object.keys(d).filter((k) => !(k in en));
  const locale = file.replace(/\.ts$/, "");
  const broken = keys.filter((k) => k in d && (vars(d[k]) !== vars(en[k]) || !pluralOk(d[k], locale)));
  if (missing.length || extra.length || broken.length) bad++;
  console.log(`${file.padEnd(10)} ${String(Object.keys(d).length).padStart(4)}/${keys.length}` +
    (missing.length ? `  missing: ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` +${missing.length - 6}` : ""}` : "") +
    (extra.length ? `  unknown: ${extra.join(", ")}` : "") +
    (broken.length ? `  placeholders: ${broken.join(", ")}` : ""));
}
process.exit(bad ? 1 : 0);
