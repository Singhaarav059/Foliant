"use client";

// Read aloud (P2-16): a PDF's text in reading order (text.ts's headings,
// paragraphs and list items, page by page), spoken by the browser's own
// speech synthesis. Nothing is sent anywhere; the voices are the device's.

import { closePdf, openPdf, bytesOf } from "../pdf/common";
import { PdfError } from "../pdf/errors";
import { blocks, bodySizeOf, documentText } from "../pdf/text";
import { guessLanguage } from "./extractive";

export type Passage = { page: number; kind: "heading" | "paragraph" | "list"; text: string };

export async function readingOrder(file: File, onPage?: (done: number, total: number) => void): Promise<{ lang: string; passages: Passage[] }> {
  const pdf = await openPdf(await bytesOf(file));
  try {
    const pages = await documentText(pdf, (i) => onPage?.(i, pdf.numPages));
    const body = bodySizeOf(pages);
    const passages = pages.flatMap((p, i) => blocks(p.lines, body).map((b) => ({ page: i + 1, kind: b.kind, text: b.text.replace(/\s+/g, " ").trim() })))
      .filter((p) => p.text);
    if (!passages.length) throw new PdfError("no_text", file.name);
    return { lang: guessLanguage(passages.map((p) => p.text).join(" ")) ?? "en", passages };
  } finally {
    await closePdf(pdf);
  }
}

// Utterances are kept to a sentence or two: Chrome stops a long one after
// about 15 seconds, and a short one lets pause and skip respond at once.
// Each piece keeps its offset in the passage, for word highlighting.
export function pieces(text: string, max = 220): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const sentences = text.match(/[^.!?。！？।]+[.!?。！？।]*\s*/g) ?? [text];
  let at = 0, cur = "", curAt = 0;
  const flush = () => {
    if (cur.trim()) out.push({ text: cur, at: curAt });
    cur = "";
  };
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) flush();
    if (!cur) curAt = at;
    if (s.length > max) {
      // A run-on sentence is cut at word boundaries.
      for (const w of s.match(/\S+\s*/g) ?? [s]) {
        if (cur && cur.length + w.length > max) flush();
        if (!cur) curAt = at;
        cur += w;
        at += w.length;
      }
      continue;
    }
    cur += s;
    at += s.length;
  }
  flush();
  return out;
}

// The voices for a language, best first: its own region's, local ones before
// network ones (which send the text to a server).
export function voicesFor(all: SpeechSynthesisVoice[], lang: string) {
  const base = lang.toLowerCase().split("-")[0];
  return all
    .filter((v) => v.lang.toLowerCase().replace("_", "-").split("-")[0] === base)
    .sort((a, b) => Number(b.localService) - Number(a.localService) || Number(b.default) - Number(a.default));
}

export type SpeakEvents = {
  // The passage being read and, when the voice reports word boundaries, the word in it.
  onPosition: (passage: number, word?: [number, number]) => void;
  onEnd: () => void;
};

// Reads passages from `from` onwards, one utterance per piece. `stop()` ends
// it; reading again starts a new Reader.
export class Reader {
  private stopped = false;
  constructor(private synth: SpeechSynthesis, private passages: Passage[], private o: { voice?: SpeechSynthesisVoice; lang: string; rate: number }, private ev: SpeakEvents) {}

  start(from: number) {
    this.synth.cancel();
    this.queue(from);
  }

  private queue(i: number) {
    if (this.stopped) return;
    if (i >= this.passages.length) return this.ev.onEnd();
    const passage = this.passages[i];
    const parts = pieces(passage.text);
    this.ev.onPosition(i);
    parts.forEach((p, k) => {
      const u = new SpeechSynthesisUtterance(p.text);
      u.lang = this.o.voice?.lang ?? this.o.lang;
      if (this.o.voice) u.voice = this.o.voice;
      u.rate = this.o.rate;
      u.onboundary = (e) => {
        if (this.stopped || e.name === "sentence") return;
        const start = p.at + e.charIndex;
        const len = e.charLength || (p.text.slice(e.charIndex).match(/^\S+/)?.[0].length ?? 0);
        this.ev.onPosition(i, [start, start + len]);
      };
      if (k === parts.length - 1) u.onend = () => this.queue(i + 1);
      this.synth.speak(u);
    });
  }

  pause() {
    this.synth.pause();
  }
  resume() {
    this.synth.resume();
  }
  stop() {
    this.stopped = true;
    this.synth.cancel();
  }
}
