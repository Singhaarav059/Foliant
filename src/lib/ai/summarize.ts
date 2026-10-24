"use client";

// Summarize PDF. A language model the visitor downloaded from this site
// (./engine.ts) writes the summary when they picked one; otherwise the
// browser's built-in Summarizer does when its model is already on the device
// (desktop Chrome); otherwise the document's own key sentences are picked
// (./extractive.ts). Another output language uses the browser's built-in
// Translator the same way. The browser's own models are never downloaded:
// one that is "downloadable" is left alone. With the cloud AI picked (the
// default where the site has it), Claude writes the summary from the
// document's text (./cloud.ts), and the steps above are the fallback;
// otherwise nothing is sent anywhere.

import { baseName, closePdf, openPdf, pdfjs, type Output, type Progress } from "../pdf/common";
import { PdfError } from "../pdf/errors";
import { documentLayout } from "../pdf/layout";
import { blocks, bodySizeOf, type Line } from "../pdf/text";
import { guessLanguage, summarize, type Doc, type Length, type Unit } from "./extractive";

type Availability = "unavailable" | "downloadable" | "downloading" | "available";
type BuiltinSummarizer = {
  summarize(text: string, o?: { context?: string }): Promise<string>;
  inputQuota?: number;
  measureInputUsage?(text: string): Promise<number>;
  destroy?(): void;
};
type BuiltinTranslator = { translate(text: string): Promise<string>; destroy?(): void };
type Api<T> = { availability(o: object): Promise<Availability>; create(o: object): Promise<T> };
type Builtins = { Summarizer?: Api<BuiltinSummarizer>; Translator?: Api<BuiltinTranslator>; LanguageDetector?: Api<{ detect(t: string): Promise<{ detectedLanguage: string; confidence: number }[]> }> };

const builtins = () => globalThis as unknown as Builtins;

// Site locales → the language tags the Translator takes.
const TAGS: Record<string, string> = { "zh-cn": "zh", "zh-tw": "zh-Hant" };
export const languageTag = (locale: string) => TAGS[locale] ?? locale;

const LENGTHS: Length[] = ["short", "medium", "long"];

// Paragraphs and list items under their headings, in reading order; tables,
// figures, headers and footers are left out.
async function readDoc(file: File, progress?: Progress): Promise<Doc> {
  const doc = await openPdf(await file.arrayBuffer());
  try {
    const layouts = await documentLayout(doc, (i) => progress?.(i * 0.9, doc.numPages));
    const all = (l: (typeof layouts)[number]) =>
      l.sections.flatMap((s) => s.columns.flatMap((c) => c.items.flatMap((it) => (it.kind === "lines" ? [it.lines] : []))));
    const body = bodySizeOf(layouts.map((l) => ({ lines: all(l).flat() })));
    const units: Unit[] = [];
    const headings: string[] = [];
    let heading: string | undefined;
    for (const layout of layouts)
      for (const lines of all(layout))
        for (const b of blocks(lines as Line[], body)) {
          if (b.kind === "heading") {
            heading = b.text.trim();
            headings.push(heading);
          } else units.push({ text: b.text.replace(/^([•◦▪●○■\-–*]|\d{1,3}[.)])\s+/, ""), heading });
        }
    return { units, headings };
  } finally {
    await closePdf(doc);
  }
}

async function detectLanguage(text: string): Promise<string | undefined> {
  const api = builtins().LanguageDetector;
  try {
    if (api && (await api.availability({})) === "available") {
      const detector = await api.create({});
      const [top] = await detector.detect(text.slice(0, 4000));
      if (top && top.confidence > 0.6 && top.detectedLanguage !== "und") return top.detectedLanguage;
    }
  } catch {
    /* fall back to the guess */
  }
  return guessLanguage(text);
}

// The built-in Summarizer, only when its model is already on the device. It
// writes in `out` when it can, else in the document's language (`inOut` false).
async function builtinSummary(doc: Doc, text: string, length: Length, lang: string | undefined, out: string | undefined): Promise<{ md: string; inOut: boolean } | null> {
  const api = builtins().Summarizer;
  if (!api) return null;
  for (const outputLanguage of [...new Set([out, lang])]) {
    const o = {
      type: "key-points", format: "markdown", length,
      ...(lang ? { expectedInputLanguages: [lang] } : {}),
      ...(outputLanguage ? { outputLanguage } : {}),
    };
    try {
      if ((await api.availability(o)) !== "available") continue;
      const summarizer = await api.create(o);
      try {
        // Too long for the model: give it the extractive long summary instead.
        let input = text;
        if (summarizer.inputQuota && summarizer.measureInputUsage && (await summarizer.measureInputUsage(input)) > summarizer.inputQuota) {
          input = summarize(doc, "long", lang).replace(/^- /gm, "");
          if ((await summarizer.measureInputUsage(input)) > summarizer.inputQuota) continue;
        }
        const md = (await summarizer.summarize(input)).trim();
        if (md) return { md, inOut: outputLanguage === out };
      } finally {
        summarizer.destroy?.();
      }
    } catch {
      /* not allowed, out of quota, unsupported language: try the next or fall back */
    }
  }
  return null;
}

// Translates line by line so list markers and headings stay Markdown.
async function translate(md: string, from: string | undefined, to: string): Promise<string | null> {
  const api = builtins().Translator;
  if (!api || !from) return null;
  try {
    const o = { sourceLanguage: from, targetLanguage: to };
    if ((await api.availability(o)) !== "available") return null;
    const translator = await api.create(o);
    try {
      const lines: string[] = [];
      for (const line of md.split("\n")) {
        const [, marker, rest] = line.match(/^(\s*(?:#{1,6}|[-*+]|\d+\.)\s+)?(.*)$/)!;
        lines.push(rest.trim() ? (marker ?? "") + (await translator.translate(rest)).trim() : line);
      }
      return lines.join("\n");
    } finally {
      translator.destroy?.();
    }
  } catch {
    return null;
  }
}

// How many key points a language model writes for each length.
const POINTS: Record<Length, number> = { short: 3, medium: 5, long: 8 };

// A language model's summary, written from the extractive long summary (the
// document's key sentences) so it stays with what the document says and
// fits a small model's context. The small model writes English only.
async function modelSummary(doc: Doc, length: Length, lang: string | undefined, out: string | undefined, aiModel: string): Promise<{ md: string; inOut: boolean } | null> {
  if (aiModel !== "small" && aiModel !== "large") return null;
  // The small model reads English only.
  if (aiModel === "small" && lang && !lang.startsWith("en")) return null;
  const { status, generator } = await import("./engine");
  if (!(await status()).stored[aiModel]) return null;
  const write = out ?? lang ?? "en";
  const inOut = aiModel === "large" || write.startsWith("en");
  const language = new Intl.DisplayNames(["en"], { type: "language" }).of(inOut ? write : "en") ?? "English";
  const facts = summarize(doc, "long", lang).replace(/^#+ .*$/gm, "").replace(/^- /gm, "").trim();
  const text = await generator(aiModel)(
    [
      { role: "system", content: `You summarise documents. Write exactly ${POINTS[length]} key points as a Markdown list, one line each starting with "- ". Use only facts from the user's text. Write in ${language}.` },
      { role: "user", content: facts },
    ],
    { maxNewTokens: 60 * POINTS[length] },
  );
  const points = text.split("\n").map((l) => l.trim()).filter((l) => /^([-*•]|\d+[.)])\s+\S/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "- "));
  return points.length ? { md: points.join("\n"), inOut: inOut && !!out } : null;
}

// How much of the document the cloud AI reads (functions/api/ai.ts takes up
// to 60,000 characters): all of it when it fits, else its key sentences and
// as much of its opening as fits beside them.
const CLOUD_CHARS = 58_000;
function cloudInput(doc: Doc, text: string, lang: string | undefined) {
  if (text.length <= CLOUD_CHARS) return text;
  const key = summarize(doc, "long", lang).replace(/^- /gm, "").trim();
  return `${text.slice(0, Math.max(0, CLOUD_CHARS - key.length - 40))}\n\n[…]\n\nKey sentences from the rest:\n${key}`.slice(0, CLOUD_CHARS);
}

// The cloud AI's summary (./cloud.ts), written in the wanted language. Only
// the document's text is sent, never the file. Null when it can't answer.
async function cloudSummary(doc: Doc, text: string, length: Length, lang: string | undefined, out: string | undefined) {
  const { cloudText } = await import("./cloud");
  try {
    const { text: reply, provider } = await cloudText({ task: "summarize", text: cloudInput(doc, text, lang), points: POINTS[length], language: out ?? lang ?? "en" });
    const points = reply.split("\n").map((l) => l.trim()).filter((l) => /^([-*•]|\d+[.)])\s+\S/.test(l)).map((l) => l.replace(/^([-*•]|\d+[.)])\s+/, "- "));
    return points.length ? { md: points.join("\n"), provider } : null;
  } catch (e) {
    console.warn("The cloud AI didn't answer; summarising on this device.", e);
    return null;
  }
}

const same = (a: string | undefined, b: string) => !!a && a.split("-")[0].toLowerCase() === b.split("-")[0].toLowerCase() && !(b === "zh-Hant" && a === "zh");

export async function summarizePdf(file: File, o: { summaryLength: string; summaryLang: string; aiModel?: string }, progress?: Progress): Promise<Output[]> {
  const length = (LENGTHS.includes(o.summaryLength as Length) ? o.summaryLength : "medium") as Length;
  const doc = await readDoc(file, progress);
  const text = doc.units.map((u) => u.text).join("\n");
  if (!text.trim()) throw new PdfError("no_text", file.name);
  const lang = await detectLanguage(text);
  const target = o.summaryLang && o.summaryLang !== "same" ? languageTag(o.summaryLang) : undefined;
  const wanted = target && !same(lang, target) ? target : undefined;

  if (o.aiModel === "cloud") {
    const cloud = await cloudSummary(doc, text, length, lang, wanted);
    progress?.(1, 1);
    if (cloud) return [{ name: `${baseName(file.name)}-summary.md`, blob: new Blob([cloud.md.trim() + "\n"], { type: "text/markdown" }), note: `summary:cloud:${cloud.provider}` }];
  }
  const model = o.aiModel
    ? await modelSummary(doc, length, lang, wanted, o.aiModel).catch(async (e) => {
        // The model didn't run here: offer server AI from now on.
        console.warn("The model didn't run on this device.", e);
        (await import("./engine")).markDeviceFailed();
        return null;
      })
    : null;
  const builtin = model ?? (await builtinSummary(doc, text, length, lang, wanted));
  let md = builtin?.md ?? summarize(doc, length, lang);
  if (!md.trim()) throw new PdfError("no_text", file.name);
  let note = `summary:${model ? "model" : builtin ? "builtin" : "extractive"}${o.aiModel === "cloud" ? ":cloudFailed" : ""}`;
  if (wanted && !builtin?.inOut) {
    const t = await translate(md, lang, wanted);
    if (t) md = t;
    else note += ":noLang";
  }
  progress?.(1, 1);
  return [{ name: `${baseName(file.name)}-summary.md`, blob: new Blob([md.trim() + "\n"], { type: "text/markdown" }), note }];
}

// Loads what a run loads (src/lib/offline.ts).
export const prepare = () => pdfjs();
