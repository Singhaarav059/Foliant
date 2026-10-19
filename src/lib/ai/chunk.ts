// Cuts a document into chunks a question can be matched against. A chunk
// never crosses a page, so every chunk, and every answer built from it, has
// exactly one page to cite. Chunks are cut between sentences and overlap by
// one sentence, so a fact split across a cut is still whole in one of them.

import { splitSentences } from "./extractive";

export type PageText = { page: number; text: string };
export type Chunk = { id: number; page: number; text: string };

const count = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function chunkPages(pages: PageText[], o: { maxWords?: number; lang?: string } = {}): Chunk[] {
  const max = o.maxWords ?? 120;
  const chunks: Chunk[] = [];
  const push = (page: number, text: string) => chunks.push({ id: chunks.length, page, text });
  for (const { page, text } of pages) {
    // A sentence longer than a chunk is cut at words.
    const sentences = splitSentences(text, o.lang).flatMap((s) => {
      const w = s.split(/\s+/).filter(Boolean);
      if (w.length <= max) return [s];
      const out: string[] = [];
      for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max).join(" "));
      return out;
    });
    let cur: string[] = [];
    let words = 0;
    for (const s of sentences) {
      const n = count(s);
      if (cur.length && words + n > max) {
        push(page, cur.join(" "));
        // Start the next chunk with the last sentence, if it leaves room.
        const last = cur[cur.length - 1];
        cur = count(last) + n <= max ? [last] : [];
        words = cur.length ? count(last) : 0;
      }
      cur.push(s);
      words += n;
    }
    if (cur.length) push(page, cur.join(" "));
  }
  return chunks;
}
