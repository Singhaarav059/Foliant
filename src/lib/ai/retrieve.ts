// Finds the chunks that answer a question: Okapi BM25 over the words
// (Robertson & Zaragoza, 2009), fused with the embedding model's cosine
// ranking when there is one by reciprocal rank fusion (Cormack, Clarke &
// Büttcher, 2009). Keywords catch names, numbers and codes; embeddings catch
// the same meaning in other words.

import type { Chunk } from "./chunk";

// Common words, and the words a question is phrased with, in the languages
// told apart by their words.
const STOP = new Set(
  (
    "the of and to in is that it for on with as was are be by this from or at an not have has will which their they its were can been also but " +
    "what who whom whose when where why how does do did much many me my you your please tell about there any here should would could " +
    "el la de que los las y en del un una por con para es se no al lo como más sus su qué cuál cuánto dónde cuándo " +
    "le les des du et est un une pour dans sur pas au aux par avec qui ce sont quel quelle combien où quand " +
    "der die das und ist nicht mit dem den des dass ein eine zu von für auf im sich auch wird werden was wer wie wo wann " +
    "il lo gli di che e della per sono nel alla dei cosa quanto dove quando " +
    "o os a as do da dos das em um uma não no na é qual quanto onde " +
    "het een en van op te voor zijn er aan ook wordt wat hoe waar wanneer"
  ).split(" "),
);
const CJK = /[぀-ヿ一-鿿가-힯]/;

// Words as the index sees them: lower case, no common words, plurals
// folded; Chinese, Japanese and Korean (no spaces) as character pairs.
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (CJK.test(raw)) {
      const chars = [...raw];
      if (chars.length === 1) out.push(raw);
      for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
      continue;
    }
    if (STOP.has(raw) || (raw.length < 2 && !/\d/.test(raw))) continue;
    out.push(raw.length > 4 && /[^s]s$/.test(raw) ? raw.slice(0, -1) : raw);
  }
  return out;
}

export type Hit = { chunk: Chunk; score: number };

const K1 = 1.2;
const B = 0.75;

function bm25(chunks: Chunk[], query: string[]): Hit[] {
  const docs = chunks.map((c) => tokens(c.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(query)];
  return chunks
    .map((chunk, i) => {
      const tf = new Map<string, number>();
      for (const t of docs[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t)!;
        const idf = Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * docs[i].length) / avg));
      }
      return { chunk, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Reciprocal rank fusion: an item's score is the sum of 1 / (60 + rank)
// over the lists it is in.
export function fuse<T>(lists: T[][], key: (x: T) => unknown, k = 60): { item: T; score: number }[] {
  const scores = new Map<unknown, { item: T; score: number }>();
  for (const list of lists)
    list.forEach((item, rank) => {
      const id = key(item);
      const e = scores.get(id) ?? { item, score: 0 };
      e.score += 1 / (k + rank + 1);
      scores.set(id, e);
    });
  return [...scores.values()].sort((a, b) => b.score - a.score);
}

export type Vectors = { query: ArrayLike<number>; chunks: ArrayLike<number>[] };

// The k chunks that best answer `query`, best first.
export function search(chunks: Chunk[], query: string, o: { k?: number; vectors?: Vectors } = {}): Hit[] {
  const k = o.k ?? 5;
  const words = bm25(chunks, tokens(query));
  if (!o.vectors) return words.slice(0, k);
  const { query: qv, chunks: cv } = o.vectors;
  const meaning = chunks.map((chunk, i) => ({ chunk, score: cosine(qv, cv[i]) })).sort((a, b) => b.score - a.score);
  return fuse([words.slice(0, 50), meaning.slice(0, 50)], (h) => h.chunk.id, 60)
    .slice(0, k)
    .map(({ item, score }) => ({ chunk: item.chunk, score }));
}
