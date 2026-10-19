// Extractive summaries: the document's own sentences, ranked with TextRank
// (Mihalcea & Tarau, 2004) over TF-IDF cosine similarity, with a nudge
// towards sentences that open a section or share words with the headings.
// No model and no download, so it runs anywhere, offline, at once.

export type Length = "short" | "medium" | "long";

// A paragraph or list item and the heading it sits under.
export type Unit = { text: string; heading?: string };
export type Doc = { units: Unit[]; headings: string[] };

// How many sentences each length keeps: a share of the document, within bounds.
const KEEP: Record<Length, { share: number; min: number; max: number }> = {
  short: { share: 0.15, min: 1, max: 3 },
  medium: { share: 0.3, min: 2, max: 7 },
  long: { share: 0.5, min: 3, max: 15 },
};

// Graphs over more sentences than this rank a pre-selection (the cost is quadratic).
const MAX_GRAPH = 1200;

// Common words of the languages told apart by their words, not their script.
const STOP: Record<string, string[]> = {
  en: "the of and to in is that it for on with as was are be by this from or at an not have has will which their they its were can been also but".split(" "),
  es: "el la de que los las y en del un una por con para es se no al lo como más sus su".split(" "),
  fr: "le la les de des du et est que un une pour dans en sur pas au aux par avec qui ce sont".split(" "),
  de: "der die das und ist nicht mit dem den des dass ein eine zu von für auf im sich auch wird werden".split(" "),
  it: "il lo la gli le di che e del della un una per non con sono nel alla dei".split(" "),
  pt: "o os a as de que e do da dos das em um uma para com não no na por se é".split(" "),
  nl: "de het een en van dat is in op te voor met niet zijn er aan ook wordt".split(" "),
};
const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)]));

const SCRIPTS: [RegExp, string][] = [
  [/[぀-ヿ]/g, "ja"],
  [/[가-힯]/g, "ko"],
  [/[一-鿿]/g, "zh"],
  [/[Ѐ-ӿ]/g, "ru"],
  [/[Ͱ-Ͽ]/g, "el"],
  [/[؀-ۿ]/g, "ar"],
  [/[฀-๿]/g, "th"],
  [/[ऀ-ॿ]/g, "hi"],
];

// A best guess at the language (BCP 47), or undefined when unsure.
export function guessLanguage(text: string): string | undefined {
  const sample = text.slice(0, 20000);
  const letters = (sample.match(/\p{L}/gu) ?? []).length;
  if (!letters) return undefined;
  const counts = SCRIPTS.map(([re, lang]) => [lang, (sample.match(re) ?? []).length] as const);
  // Japanese mixes kana with Han; a little kana is enough to tell it from Chinese.
  const kana = counts.find(([l]) => l === "ja")![1];
  if (kana > letters * 0.05) return "ja";
  const [lang, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (n > letters * 0.3) {
    if (lang === "ru") return /[іїєґ]/i.test(sample) ? "uk" : "ru";
    return lang;
  }
  const words = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best: string | undefined;
  let max = 1;
  for (const [l, set] of Object.entries(STOPSETS)) {
    const hits = words.filter((w) => set.has(w)).length;
    if (hits > max) [best, max] = [l, hits];
  }
  return best;
}

const segmenter = (lang: string | undefined, granularity: "sentence" | "word") => {
  try {
    return new Intl.Segmenter(lang, { granularity });
  } catch {
    return null;
  }
};

export function splitSentences(text: string, lang?: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const seg = segmenter(lang, "sentence");
  const parts = seg
    ? [...seg.segment(clean)].map((s) => s.segment)
    : clean.split(/(?<=[.!?。！？])\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

const CJK = /[぀-ヿ一-鿿가-힯฀-๿]/;

function words(sentence: string, lang?: string): string[] {
  const seg = segmenter(lang, "word");
  const raw = seg
    ? [...seg.segment(sentence)].filter((s) => s.isWordLike).map((s) => s.segment)
    : sentence.match(/[\p{L}\p{N}]+/gu) ?? [];
  return raw.map((w) => w.toLowerCase());
}

// Content words: no common words, no one-letter Latin words, plurals folded.
function terms(sentence: string, lang?: string): string[] {
  const stop = lang ? STOPSETS[lang] : STOPSETS.en;
  return words(sentence, lang)
    .filter((w) => !stop?.has(w) && (CJK.test(w) || w.length > 1) && !/^\d+$/.test(w))
    .map((w) => (w.length > 4 && /[^s]s$/.test(w) ? w.slice(0, -1) : w));
}

// Fragments, figures and runs of numbers make poor summary sentences.
function usable(s: string, lang?: string) {
  if (s.length > 600) return false;
  const letters = (s.match(/\p{L}/gu) ?? []).length;
  if (letters < s.length * 0.5) return false;
  return CJK.test(s) ? s.length >= 10 : words(s, lang).length >= 4;
}

type Sentence = { text: string; order: number; heading?: string; first: boolean; vec: Map<string, number>; norm: number; score: number };

function cosine(a: Sentence, b: Sentence) {
  if (!a.norm || !b.norm) return 0;
  const [small, big] = a.vec.size < b.vec.size ? [a.vec, b.vec] : [b.vec, a.vec];
  let dot = 0;
  for (const [k, v] of small) dot += v * (big.get(k) ?? 0);
  return dot / (a.norm * b.norm);
}

// The document's sentences, scored, in document order (duplicates dropped).
export function rank(doc: Doc, lang?: string): Sentence[] {
  const seen = new Set<string>();
  const list: (Omit<Sentence, "vec" | "norm" | "score"> & { terms: string[] })[] = [];
  let lastHeading: string | undefined = "\u0000";
  for (const u of doc.units) {
    const first = u.heading !== lastHeading;
    lastHeading = u.heading;
    splitSentences(u.text, lang).forEach((text, i) => {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key) || !usable(text, lang)) return;
      seen.add(key);
      list.push({ text, order: list.length, heading: u.heading, first: first && i === 0, terms: terms(text, lang) });
    });
  }
  const df = new Map<string, number>();
  for (const s of list) for (const t of new Set(s.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = list.length;
  const sentences: Sentence[] = list.map(({ terms: ts, ...s }) => {
    const vec = new Map<string, number>();
    for (const t of ts) vec.set(t, (vec.get(t) ?? 0) + 1);
    let norm = 0;
    for (const [t, tf] of vec) {
      const w = tf * Math.log(1 + n / df.get(t)!);
      vec.set(t, w);
      norm += w * w;
    }
    return { ...s, vec, norm: Math.sqrt(norm), score: 0 };
  });
  if (!n) return sentences;

  // Long documents: the graph covers the sentences closest to the document as a whole.
  let nodes = sentences;
  if (n > MAX_GRAPH) {
    const centroid: Sentence = { text: "", order: -1, first: false, vec: new Map(), norm: 0, score: 0 };
    for (const s of sentences) for (const [k, v] of s.vec) centroid.vec.set(k, (centroid.vec.get(k) ?? 0) + v);
    centroid.norm = Math.sqrt([...centroid.vec.values()].reduce((a, v) => a + v * v, 0));
    nodes = [...sentences].sort((a, b) => cosine(b, centroid) - cosine(a, centroid)).slice(0, MAX_GRAPH);
  }

  // Where a sentence sits and what it talks about: opening a section, early
  // in the document, sharing words with the headings, long enough to say something.
  const headingTerms = new Set(doc.headings.flatMap((h) => terms(h, lang)));
  const prior = nodes.map((s) => {
    const keys = [...s.vec.keys()];
    const onTopic = keys.length ? keys.filter((k) => headingTerms.has(k)).length / keys.length : 0;
    const size = Math.min(1, 0.5 + words(s.text, lang).length / 20);
    return (1 + 0.5 * onTopic) * (s.first ? 1.3 : 1) * (1 + 0.2 * (1 - s.order / n)) * size;
  });
  const total = prior.reduce((a, b) => a + b, 0);
  for (let i = 0; i < prior.length; i++) prior[i] /= total;

  // TextRank: PageRank over the similarity graph, teleporting by the prior.
  // Each sentence also links to itself, so one that resembles no other keeps
  // its prior instead of losing out to any pair of look-alikes: within a
  // connected document the score follows how much a sentence shares with the rest.
  const m = nodes.length;
  const w: Float64Array[] = nodes.map(() => new Float64Array(m));
  const out = new Float64Array(m).fill(1);
  for (let i = 0; i < m; i++)
    for (let j = i + 1; j < m; j++) {
      const c = cosine(nodes[i], nodes[j]);
      if (c > 0) {
        w[i][j] = w[j][i] = c;
        out[i] += c;
        out[j] += c;
      }
    }
  const d = 0.85;
  let pr = Float64Array.from(prior);
  for (let iter = 0; iter < 100; iter++) {
    const next = Float64Array.from(prior, (p) => (1 - d) * p);
    for (let j = 0; j < m; j++) {
      const share = (d * pr[j]) / out[j];
      next[j] += share;
      const row = w[j];
      for (let i = 0; i < m; i++) if (row[i]) next[i] += share * row[i];
    }
    let delta = 0;
    for (let i = 0; i < m; i++) delta += Math.abs(next[i] - pr[i]);
    pr = next;
    if (delta < 1e-9) break;
  }
  nodes.forEach((s, i) => (s.score = pr[i] * m));
  return sentences;
}

// Picks the best sentences, skipping ones that repeat a sentence already kept.
export function pick(sentences: Sentence[], length: Length): Sentence[] {
  const scored = sentences.filter((s) => s.score > 0);
  const { share, min, max } = KEEP[length];
  const k = Math.min(scored.length, Math.max(min, Math.min(max, Math.ceil(scored.length * share))));
  const kept: Sentence[] = [];
  for (const s of [...scored].sort((a, b) => b.score - a.score || a.order - b.order)) {
    if (kept.length >= k) break;
    if (kept.some((x) => cosine(x, s) > 0.5)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.order - b.order);
}

// Markdown: key points as a list, under their section headings in a long
// summary that spans more than one section.
export function summarize(doc: Doc, length: Length, lang?: string): string {
  const kept = pick(rank(doc, lang), length);
  const item = (s: Sentence) => `- ${mdEscape(s.text)}`;
  const sections = new Set(kept.map((s) => s.heading));
  if (length !== "long" || sections.size < 2) return kept.map(item).join("\n");
  const out: string[] = [];
  let heading: string | undefined = "\u0000";
  for (const s of kept) {
    if (s.heading !== heading) {
      if (out.length) out.push("");
      if (s.heading) out.push(`### ${mdEscape(s.heading)}`, "");
      heading = s.heading;
    }
    out.push(item(s));
  }
  return out.join("\n");
}

const mdEscape = (s: string) => s.replace(/([\\`*_[\]<>#|])/g, "\\$1");

// For copying and .txt: no Markdown markers.
export function markdownToText(md: string): string {
  return md
    .split("\n")
    .map((l) =>
      l
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/(^|[^\\])[*_](\S(?:.*?\S)?)[*_]/g, "$1$2")
        .replace(/\\([\\`*_[\]<>#|])/g, "$1"),
    )
    .join("\n")
    .trim();
}
