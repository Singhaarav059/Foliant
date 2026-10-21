// Page citations. The model sees the retrieved chunks as numbered sources,
// each with its page, and is asked to cite them as [1], [2]. Its answer's
// markers are mapped back to pages here; a marker naming a source or page
// that wasn't given is dropped, so a citation always points at text the
// answer was built from. An answer with no markers gets the sources it
// borrows its words from. Without a model, the answer is the sentences that
// match the question best, each with its own page.

import { splitSentences } from "./extractive";
import { tokens, type Hit } from "./retrieve";

export type Source = { n: number; page: number; text: string };
// A stretch of answer text and the pages it cites.
export type Part = { text: string; pages?: number[] };
export type Answer = { parts: Part[]; pages: number[] };

export function numberSources(hits: Hit[]): { sources: Source[]; context: string } {
  const sources = hits.map((h, i) => ({ n: i + 1, page: h.chunk.page, text: h.chunk.text }));
  return { sources, context: sources.map((s) => `[${s.n}] (page ${s.page}) ${s.text}`).join("\n") };
}

// One or more markers in a row: [1], [1, 2], [p. 3], [page 3], (page 3), (p. 3).
const MARKER = /\[\s*\d+(?:\s*[,;]\s*\d+)*\s*\]|[[(]\s*p(?:age|\.|g\.?)?\s*\d+\s*[\])]/gi;
const GROUP = new RegExp(`(?:\\s*(?:${MARKER.source}))+`, "gi");

const unique = (xs: number[]) => [...new Set(xs)];

export function citations(answer: string, sources: Source[]): Answer {
  const byN = new Map(sources.map((s) => [s.n, s.page]));
  const known = new Set(sources.map((s) => s.page));
  const parts: Part[] = [];
  let last = 0;
  const add = (text: string, pages: number[]) => {
    if (text) parts.push({ text, pages });
    else if (parts.length) parts[parts.length - 1].pages = unique([...(parts[parts.length - 1].pages ?? []), ...pages]);
  };
  for (const g of answer.matchAll(GROUP)) {
    const pages: number[] = [];
    for (const [m] of g[0].matchAll(MARKER)) {
      const nums = (m.match(/\d+/g) ?? []).map(Number);
      if (/p/i.test(m)) pages.push(...nums.filter((p) => known.has(p)));
      else for (const n of nums) if (byN.has(n)) pages.push(byN.get(n)!);
    }
    // "…, as stated in [1]", "(see [1])": the chip says it already.
    const before = answer.slice(last, g.index).replace(/[,;]?\s*(?:\(\s*(?:see|source|sources)|(?:as\s+)?(?:cited|stated|mentioned|shown|given|found)\s+(?:in|on))\s*$/i, "");
    add(before.trim(), unique(pages));
    last = g.index! + g[0].length;
  }
  add(answer.slice(last).replace(/^\)/, "").trim(), []);
  return { parts, pages: unique(parts.flatMap((p) => p.pages ?? [])) };
}

// The pages of the sources most of an answer's words come from, sentence by sentence.
export function attribute(answer: string, sources: Source[]): number[] {
  const pages: number[] = [];
  const bags = sources.map((s) => new Set(tokens(s.text)));
  for (const sentence of splitSentences(answer)) {
    const words = [...new Set(tokens(sentence))];
    if (words.length < 2) continue;
    let best = -1, share = 0;
    bags.forEach((bag, i) => {
      const s = words.filter((w) => bag.has(w)).length / words.length;
      if (s > share) [best, share] = [i, s];
    });
    if (best >= 0 && share >= 0.6) pages.push(sources[best].page);
  }
  return unique(pages);
}

// Without a model: up to `max` sentences from the retrieved chunks that share
// the most (rare) words with the question, best first. A chunk that ranked
// higher breaks ties. `similar`, when given, scores by meaning instead
// (cosine similarity). Sentences well behind the best one are left out.
export function extractiveAnswer(question: string, hits: Hit[], o: { max?: number; similar?: number[] } = {}): { text: string; page: number }[] {
  const q = new Set(tokens(question));
  const sentences = hits.flatMap((h, rank) => splitSentences(h.chunk.text).map((text) => ({ text, page: h.chunk.page, rank })));
  // Rarer words count for more, as in the index.
  const df = new Map<string, number>();
  const bags = sentences.map((s) => new Set(tokens(s.text)));
  for (const bag of bags) for (const t of bag) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = sentences.map((s, i) => {
    let score = o.similar?.[i] ?? 0;
    if (!o.similar) for (const t of q) if (bags[i].has(t)) score += Math.log(1 + sentences.length / df.get(t)!);
    return { ...s, score: score - s.rank * 1e-3 };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  const floor = o.similar ? Math.max(0.2, best - 0.12) : best * 0.5;
  const seen = new Set<string>();
  return scored
    .filter((s) => s.score > 0 && s.score >= floor)
    .sort((a, b) => b.score - a.score)
    .filter((s) => {
      const key = s.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, o.max ?? 3)
    .map(({ text, page }) => ({ text, page }));
}

// The sentences of an extractive answer, with their sentence list in
// document order, for extractiveAnswer's `similar`.
export const answerSentences = (hits: Hit[]) => hits.flatMap((h) => splitSentences(h.chunk.text));
