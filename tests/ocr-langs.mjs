// OCR languages: the list, its vendored models and names, how a choice of
// several reaches Tesseract and is remembered, and reading a scanned page in
// English and Hindi (tests/fixtures/mixed-script.pdf) with both picked, and
// a Bengali page alone.
//
//   node tests/ocr-langs.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorker, createScheduler } from "tesseract.js";
import { root, vendorDir, load, openPdf, check, eq } from "./lib/load.mjs";
import { MIXED_LINES, wordsIn } from "./lib/mixed-script.mjs";

const results = { failed: 0 };
const test = check(results);
const { OCR_LANGS, PADDLE_LANGS, TOOLS, defaultOptions } = await load("../tools");
const langs = await load("../ocr-langs");
const { ocr, engine } = await load("ocr");
const { createCanvas } = await import("@napi-rs/canvas");
globalThis.document ??= { createElement: () => createCanvas(1, 1) };
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

await test("the list has 100 or more languages, each once", () => {
  eq(OCR_LANGS.length >= 100, true, `languages (got ${OCR_LANGS.length})`);
  eq(new Set(OCR_LANGS).size, OCR_LANGS.length, "unique");
  for (const l of PADDLE_LANGS) eq(OCR_LANGS.includes(l), true, `high-accuracy ${l} listed`);
});

await test("every language's model is vendored, within the host's file limit", () => {
  const vendored = readdirSync(join(vendorDir, "tessdata")).map((f) => f.replace(/\.traineddata\.gz$/, "")).sort();
  eq(vendored.join(), [...OCR_LANGS].sort().join(), "vendored models");
  const big = OCR_LANGS.filter((l) => statSync(join(vendorDir, "tessdata", `${l}.traineddata.gz`)).size >= 24 * 1024 * 1024);
  eq(big.join(), "", "models of 24 MiB or more");
});

await test("every language has a name, in English and in Hindi", () => {
  for (const locale of ["en", "hi"]) {
    const names = OCR_LANGS.map((l) => {
      const { name, native, variant } = langs.ocrLangName(l, locale);
      if (!name || name === l || /_/.test(name) || !native) throw new Error(`${l} named "${name}" / "${native}" in ${locale}`);
      return `${name}${variant ? `, ${variant}` : ""}`;
    });
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    eq(dup.join(), "", `names used twice in ${locale}`);
  }
  eq(langs.ocrLangName("hin", "en").name, "Hindi", "hin in English");
  eq(langs.ocrLangName("hin", "en").native, "हिन्दी", "hin in Hindi");
  eq(langs.ocrLangName("chi_sim_vert", "en").variant, "vert", "vertical variant");
});

await test("a browser without a language's name in its Intl data still shows one", () => {
  const Real = Intl.DisplayNames;
  Intl.DisplayNames = class { of() { return undefined; } };
  try {
    const bare = OCR_LANGS.filter((l) => { const { name } = langs.ocrLangName(l, "en-AU"); return !name || name === l; });
    eq(bare.join(), "", "languages named by code");
    eq(langs.ocrLangName("bod", "en-AU").name, "Tibetan", "bod");
  } finally {
    Intl.DisplayNames = Real;
  }
});

await test("OCR offers the languages as a multi-select, English by default", () => {
  const opt = TOOLS.find((t) => t.id === "ocr").options.find((o) => o.key === "ocrLang");
  eq(opt.type, "multi", "option type");
  eq(opt.choices, OCR_LANGS, "choices");
  eq(opt.max, langs.MAX_OCR_LANGS, "max");
  eq(defaultOptions(TOOLS.find((t) => t.id === "ocr")).ocrLang, "eng", "default");
});

await test("a value keeps known languages, each once, up to the limit", () => {
  const all = (v) => langs.ocrLangs(v, OCR_LANGS).join("+");
  eq(all("eng+hin"), "eng+hin", "two");
  eq(all("hin+nope+eng+hin"), "hin+eng", "unknown and repeated dropped");
  eq(all(""), "eng", "empty");
  eq(all(undefined), "eng", "missing");
  eq(all("eng+hin+mar+ben+tam"), ["eng", "hin", "mar", "ben", "tam"].slice(0, langs.MAX_OCR_LANGS).join("+"), "limit");
});

// The engine stand-in records what it was asked for and reads nothing.
const scanned = () => new File([readFileSync(join(root, "tests/fixtures/scanned.pdf"))], "scanned.pdf");
const asked = async (o) => {
  let got = null;
  engine.create = async (lang) => {
    got = lang;
    return { recognise: async () => ({ confidence: 0, blocks: [] }), stop: async () => {} };
  };
  await ocr(scanned(), { dpi: "96", ...o });
  return got;
};
await test("the picked languages reach Tesseract joined with +", async () => {
  eq(await asked({ ocrLang: "eng+hin" }), "eng+hin", "eng+hin");
  eq(await asked({ ocrLang: "hin+../../x+eng" }), "hin+eng", "unknown dropped");
  eq(await asked({ ocrLang: "eng+hin", ocrEngine: "accurate" }), "eng+hin", "high accuracy is for one language");
});

await test("the choice is remembered, and blocked storage is no error", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  eq(langs.rememberedOcrLang(), null, "nothing yet");
  langs.rememberOcrLang("eng+hin");
  eq(langs.rememberedOcrLang(), "eng+hin", "remembered");
  globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  eq(langs.rememberedOcrLang(), null, "blocked read");
  langs.rememberOcrLang("eng");
  delete globalThis.localStorage;
});

// ── Reading the English and Hindi page with Tesseract, models from disk.

const cache = mkdtempSync(join(tmpdir(), "tess-"));
engine.create = async (lang, count) => {
  const scheduler = createScheduler();
  for (let i = 0; i < Math.min(count, 2); i++) scheduler.addWorker(await createWorker(lang, undefined, { langPath: join(vendorDir, "tessdata"), cachePath: cache }));
  const { grayPng } = await load("ocrprep");
  return {
    recognise: async (image) => (await scheduler.addJob("recognize", Buffer.from(grayPng(image)), {}, { blocks: true })).data,
    stop: () => scheduler.terminate(),
  };
};

// Character error rate over one script's words, as edit distance / reference length.
function cer(ref, hyp) {
  const a = [...ref.normalize("NFC")], b = [...hyp.normalize("NFC")];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}
async function read(ocrLang) {
  const file = new File([readFileSync(join(root, "tests/fixtures/mixed-script.pdf"))], "mixed-script.pdf");
  const [out] = await ocr(file, { ocrLang, dpi: "200" });
  const doc = await openPdf(new Uint8Array(await out.blob.arrayBuffer()));
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((t) => t.str).join(" ");
  const ref = MIXED_LINES.join(" ");
  const rate = (s) => cer(wordsIn(ref, s).join(" "), wordsIn(text, s).join(" "));
  return { eng: rate("eng"), hin: rate("hin"), text };
}
const pct = (v) => `${(v * 100).toFixed(1)}%`;
if (!existsSync(join(root, "tests/fixtures/mixed-script.pdf"))) throw new Error("run node tests/make-mixed-script.mjs");
const both = await read("eng+hin");
const english = await read("eng");
console.log(`      eng+hin: English ${pct(both.eng)}, Hindi ${pct(both.hin)}; eng alone: English ${pct(english.eng)}, Hindi ${pct(english.hin)}`);
if (process.env.SHOW) console.log(`      ${both.text}`);
await test("English and Hindi picked: each script under 5% CER", () => {
  if (both.eng >= 0.05 || both.hin >= 0.05) throw new Error(`English ${pct(both.eng)}, Hindi ${pct(both.hin)}`);
});
await test("English alone can't read the Hindi (the page needs both)", () => {
  if (english.hin < 0.5) throw new Error(`Hindi ${pct(english.hin)} with English only`);
});

// Bengali (P2-15): a page set in Noto Sans Bengali (tests/fixtures/images/bengali-scan.png),
// read with the vendored model, under 10% CER.
const BENGALI = [
  "আমাদের গ্রামের পাশে একটি ছোট নদী আছে।",
  "বর্ষাকালে নদীর জল অনেক বেড়ে যায়।",
  "শিশুরা বিকেলে মাঠে ফুটবল খেলে।",
  "মা রান্নাঘরে ভাত আর মাছের ঝোল রান্না করছেন।",
  "এই চিঠিটি আগামী সোমবারের মধ্যে পাঠাতে হবে।",
  "বিদ্যালয়ের গ্রন্থাগারে অনেক পুরনো বই রয়েছে।",
];
await test("Bengali scan: under 10% CER", async () => {
  const worker = await createWorker("ben", undefined, { langPath: join(vendorDir, "tessdata"), cachePath: mkdtempSync(join(tmpdir(), "tess-ben-")) });
  try {
    const { data } = await worker.recognize(readFileSync(join(root, "tests/fixtures/images/bengali-scan.png")));
    const flat = (s) => s.replace(/\s+/g, "");
    const rate = cer(flat(BENGALI.join("")), flat(data.text));
    console.log(`      Bengali: ${pct(rate)}`);
    if (rate >= 0.1) throw new Error(`CER ${pct(rate)}: ${data.text.slice(0, 120)}`);
  } finally {
    await worker.terminate();
  }
});

process.exit(results.failed ? 1 : 0);
