// Summarize PDF: extractive TextRank over the document's own sentences, the
// browser's built-in Summarizer and Translator when they are already on the
// device, and nothing fetched from anywhere.
//
//   node tests/summarize.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, openPdf, check, eq, root } from "./lib/load.mjs";

const ex = await load("../ai/extractive");
const { summarizePdf } = await load("../ai/summarize");
const results = { failed: 0 };
const test = check(results);

// pdf.js in Node runs its worker in the main thread once a document has been opened directly.
const report = new Uint8Array(readFileSync(join(root, "tests/fixtures/report.pdf")));
await openPdf(report.slice());
const file = (bytes, name = "report.pdf") => new File([bytes], name, { type: "application/pdf" });
const run = async (bytes, o, name) => {
  const [out] = await summarizePdf(file(bytes, name), { summaryLength: "medium", summaryLang: "same", ...o });
  return { ...out, text: await out.blob.text() };
};

// No request may leave the page while summarising.
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error("network");
};

// A longer document: an article with a title, sections and filler.
async function article() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sections = [
    ["Solar power adoption", [
      "Solar power adoption in cities grew quickly over the last decade as panel prices fell.",
      "Cheaper solar panels made rooftop solar power affordable for many households in cities.",
      "The weather was pleasant on the day the survey started.",
      "City councils now offer grants that pay for part of a rooftop solar installation.",
    ]],
    ["Storage and the grid", [
      "Battery storage lets households keep solar power for the evening, when demand peaks.",
      "Grid operators worry that rooftop solar power makes demand harder to predict.",
      "Lunch was served in the main hall.",
      "New battery storage tariffs reward households that share stored solar power with the grid.",
    ]],
    ["Outlook", [
      "Analysts expect solar power and battery storage to supply a third of city electricity by 2035.",
      "The next survey will measure how grants change solar adoption in smaller towns.",
    ]],
  ];
  let page = doc.addPage([595, 842]);
  let y = 780;
  const line = (text, f, size) => {
    if (y < 60) {
      page = doc.addPage([595, 842]);
      y = 780;
    }
    page.drawText(text, { x: 50, y, size, font: f });
    y -= size * 1.6;
  };
  line("City Energy Survey", bold, 24);
  y -= 10;
  for (const [heading, sentences] of sections) {
    line(heading, bold, 16);
    for (const s of sentences) {
      // About 75 characters a line, like a real paragraph.
      const words = s.split(" ");
      let cur = "";
      for (const w of words) {
        if ((cur + " " + w).length > 75) {
          line(cur, font, 11);
          cur = w;
        } else cur = cur ? cur + " " + w : w;
      }
      line(cur, font, 11);
    }
    y -= 12;
  }
  return doc.save();
}

await test("sentences: split, abbreviations and e-mail addresses kept whole", () => {
  const s = ex.splitSentences("Revenue grew 12 percent. Contact jane.doe@example.com for details. Is it good? Yes!", "en");
  eq(s.length, 4, "sentence count");
  eq(s[1], "Contact jane.doe@example.com for details.", "e-mail kept in its sentence");
});

await test("language guess: English, Spanish, German, Japanese, Russian, Bengali, Tamil, Telugu, Urdu, Persian, Arabic", () => {
  eq(ex.guessLanguage("The report shows that the revenue of the company is growing and it will grow"), "en", "en");
  eq(ex.guessLanguage("El informe muestra que los ingresos de la empresa crecen y que seguirán creciendo en el año"), "es", "es");
  eq(ex.guessLanguage("Der Bericht zeigt, dass der Umsatz des Unternehmens wächst und nicht mit dem Jahr sinkt"), "de", "de");
  eq(ex.guessLanguage("この報告書は、会社の収益が伸びていることを示しています。"), "ja", "ja");
  eq(ex.guessLanguage("Отчёт показывает, что выручка компании растёт."), "ru", "ru");
  eq(ex.guessLanguage("প্রতিবেদনটি দেখায় যে কোম্পানির আয় বাড়ছে।"), "bn", "bn");
  eq(ex.guessLanguage("நிறுவனத்தின் வருமானம் வளர்ந்து வருவதாக அறிக்கை காட்டுகிறது."), "ta", "ta");
  eq(ex.guessLanguage("కంపెనీ ఆదాయం పెరుగుతోందని నివేదిక చూపిస్తుంది."), "te", "te");
  eq(ex.guessLanguage("رپورٹ سے پتہ چلتا ہے کہ کمپنی کی آمدنی بڑھ رہی ہے۔"), "ur", "ur");
  eq(ex.guessLanguage("گزارش نشان می‌دهد که درآمد شرکت در حال افزایش است."), "fa", "fa");
  eq(ex.guessLanguage("يظهر التقرير أن إيرادات الشركة تنمو."), "ar", "ar");
});

await test("markdown to plain text", () => {
  eq(ex.markdownToText("### Outlook\n\n- One point.\n- **Two** points."), "Outlook\n\n• One point.\n• Two points.", "plain");
});

await test("report.pdf: short < medium < long, all non-empty, nothing fetched", async () => {
  const out = {};
  for (const summaryLength of ["short", "medium", "long"]) out[summaryLength] = (await run(report, { summaryLength })).text.trim();
  for (const [k, v] of Object.entries(out)) if (!v) throw new Error(`${k} is empty`);
  if (!(out.short.length < out.medium.length && out.medium.length < out.long.length)) {
    throw new Error(`lengths ${out.short.length}, ${out.medium.length}, ${out.long.length}`);
  }
  eq(out.short.includes("Revenue grew 12 percent this quarter, driven by renewals."), true, "the key sentence leads");
  // The three pages repeat each other; a sentence appears once.
  eq(out.long.split("Revenue grew 12 percent").length - 1, 1, "repeated sentence kept once");
  eq(requests, 0, "requests");
});

await test("report.pdf: Markdown output, named after the file, marked as extractive", async () => {
  const out = await run(report, {});
  eq(out.name, "report-summary.md", "name");
  eq(out.blob.type.startsWith("text/markdown"), true, "type");
  eq(out.note, "summary:extractive", "note");
  eq(/^- /m.test(out.text), true, "key points as a list");
});

const art = await article();
await test("article: picks on-topic sentences, leaves out filler, keeps document order", async () => {
  const { text } = await run(art, { summaryLength: "medium" });
  eq(text.includes("weather"), false, "filler about the weather");
  eq(text.includes("Lunch"), false, "filler about lunch");
  eq((text.match(/solar/gi) ?? []).length >= 2, true, "on topic");
  const long = (await run(art, { summaryLength: "long" })).text;
  const a = long.indexOf("Solar power adoption in cities");
  const b = long.indexOf("Analysts expect");
  eq(a >= 0 && b > a, true, "document order");
  eq(long.includes("### Storage and the grid"), true, "long summary grouped by section");
});

await test("a PDF with no text is a no_text error", async () => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]);
  const bytes = await doc.save();
  try {
    await run(bytes, {}, "blank.pdf");
  } catch (e) {
    eq(e.code, "no_text", "code");
    return;
  }
  throw new Error("no error");
});

// The browser's own models, stubbed: used only when already on the device.
const calls = [];
class Summarizer {
  static state = "available";
  static async availability(o) {
    calls.push(["availability", o]);
    return Summarizer.state;
  }
  static async create(o) {
    calls.push(["create", o]);
    return {
      inputQuota: 100000,
      measureInputUsage: async (t) => t.length,
      summarize: async () => "- Built-in summary.",
      destroy() {},
    };
  }
}
class Translator {
  static state = "available";
  static async availability(o) {
    calls.push(["tavailability", o]);
    return Translator.state;
  }
  static async create(o) {
    calls.push(["tcreate", o]);
    return { translate: async (t) => `[${o.targetLanguage}] ${t}`, destroy() {} };
  }
}

await test("built-in Summarizer is used when it is available", async () => {
  globalThis.Summarizer = Summarizer;
  calls.length = 0;
  const out = await run(report, { summaryLength: "short" });
  eq(out.note, "summary:builtin", "note");
  eq(out.text.trim(), "- Built-in summary.", "text");
  const created = calls.find((c) => c[0] === "create")?.[1];
  eq(created?.length, "short", "length passed");
  eq(created?.type, "key-points", "type");
});

await test("built-in Summarizer that would need a download is left alone", async () => {
  for (const state of ["downloadable", "downloading", "unavailable"]) {
    Summarizer.state = state;
    calls.length = 0;
    const out = await run(report, {});
    eq(out.note, "summary:extractive", `note when ${state}`);
    eq(calls.some((c) => c[0] === "create"), false, `create called when ${state}`);
  }
  Summarizer.state = "available";
});

await test("a broken built-in Summarizer falls back to the extractive summary", async () => {
  const create = Summarizer.create;
  Summarizer.create = async () => {
    throw new Error("NotAllowedError");
  };
  const out = await run(report, {});
  Summarizer.create = create;
  eq(out.note, "summary:extractive", "note");
  eq(out.text.includes("Revenue grew"), true, "text");
});

await test("another language: translated line by line by the built-in Translator", async () => {
  delete globalThis.Summarizer;
  globalThis.Translator = Translator;
  calls.length = 0;
  const out = await run(report, { summaryLang: "es" });
  eq(out.note, "summary:extractive", "note");
  const first = out.text.split("\n").find((l) => l.startsWith("- "));
  eq(first?.startsWith("- [es] "), true, "list marker kept, text translated");
  const created = calls.find((c) => c[0] === "tcreate")?.[1];
  eq(created?.sourceLanguage, "en", "source");
  eq(created?.targetLanguage, "es", "target");
});

await test("Chinese locales map to the Translator's language tags", async () => {
  calls.length = 0;
  await run(report, { summaryLang: "zh-tw" });
  eq(calls.find((c) => c[0] === "tcreate")?.[1].targetLanguage, "zh-Hant", "zh-tw");
  calls.length = 0;
  await run(report, { summaryLang: "zh-cn" });
  eq(calls.find((c) => c[0] === "tcreate")?.[1].targetLanguage, "zh", "zh-cn");
});

await test("another language without a Translator on the device: original language, flagged", async () => {
  for (const state of ["downloadable", null]) {
    if (state) {
      Translator.state = state;
      globalThis.Translator = Translator;
    } else delete globalThis.Translator;
    calls.length = 0;
    const out = await run(report, { summaryLang: "fr" });
    eq(out.note, "summary:extractive:noLang", `note (${state ?? "no API"})`);
    eq(out.text.includes("Revenue grew"), true, "original text");
    eq(calls.some((c) => c[0] === "tcreate"), false, "create called");
  }
  delete globalThis.Translator;
});

await test("the document's own language needs no translation", async () => {
  globalThis.Translator = Translator;
  Translator.state = "available";
  calls.length = 0;
  const out = await run(report, { summaryLang: "en" });
  eq(out.note, "summary:extractive", "note");
  eq(calls.some((c) => c[0] === "tcreate"), false, "translator created");
  delete globalThis.Translator;
  eq(requests, 0, "requests");
});

console.log(results.failed ? `\n${results.failed} failed` : "\nall passed");
process.exit(results.failed ? 1 : 0);
