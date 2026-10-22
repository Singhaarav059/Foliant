"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { useI18n } from "../I18n";
import type { Passage, Reader } from "@/lib/ai/speak";

export const prepareListen = () => import("@/lib/ai/speak");

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

// Read aloud (P2-16): the document's text in reading order, spoken by the
// browser's voices, the passage being read highlighted and, where the voice
// reports word boundaries, the word too. Clicking a passage reads from there.
export function ListenView({ file, onError }: { file: File; onError: (e: unknown) => void }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<{ lang: string; passages: Passage[] } | null>(null);
  const [reading, setReading] = useState(0);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState("");
  const [rate, setRate] = useState(1);
  const [state, setState] = useState<"idle" | "playing" | "paused">("idle");
  const [at, setAt] = useState<{ passage: number; word?: [number, number] }>({ passage: 0 });
  const reader = useRef<Reader | null>(null);
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  });
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

  useEffect(() => {
    let live = true;
    import("@/lib/ai/speak")
      .then((s) => s.readingOrder(file, (d, total) => live && setReading(d / total)))
      .then((d) => live && setDoc(d), (e) => live && failed.current(e));
    return () => {
      live = false;
    };
  }, [file]);

  // Voices arrive asynchronously in Chrome; listen for the list to change.
  useEffect(() => {
    if (!synth) return;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => {
      synth.removeEventListener?.("voiceschanged", load);
      synth.cancel();
    };
  }, [synth]);

  const [mod, setMod] = useState<typeof import("@/lib/ai/speak") | null>(null);
  useEffect(() => {
    void import("@/lib/ai/speak").then(setMod);
  }, []);
  const choices = useMemo(() => (doc && mod ? mod.voicesFor(voices, doc.lang) : []), [doc, mod, voices]);
  const voice = choices.find((v) => v.name === voiceName) ?? choices[0];

  const play = (from: number, o: { voice?: SpeechSynthesisVoice; rate?: number } = {}) => {
    if (!synth || !doc || !mod) return;
    reader.current?.stop();
    const r = new mod.Reader(synth, doc.passages, { voice: o.voice ?? voice, lang: doc.lang, rate: o.rate ?? rate }, {
      onPosition: (passage, word) => {
        setAt({ passage, word });
        if (!word) document.querySelector(`[data-passage="${passage}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      },
      onEnd: () => setState("idle"),
    });
    reader.current = r;
    r.start(from);
    setState("playing");
  };
  const toggle = () => {
    if (state === "playing") {
      reader.current?.pause();
      setState("paused");
    } else if (state === "paused") {
      reader.current?.resume();
      setState("playing");
    } else play(at.passage);
  };
  const stop = () => {
    reader.current?.stop();
    reader.current = null;
    setState("idle");
    setAt({ passage: 0 });
  };

  if (!synth) return <p className="mt-6 text-[15px] text-muted" role="alert">{t("listen.noSpeech")}</p>;
  if (!doc)
    return (
      <p className="mt-6 flex items-center gap-2 text-[15px] text-muted" role="status">
        <Loader2 size={16} className="animate-spin" /> {t("listen.loading")} {reading ? `${Math.round(reading * 100)}%` : ""}
      </p>
    );

  const last = doc.passages.length - 1;
  return (
    <div className="mt-6" data-listen={state}>
      <div className="sticky top-[72px] z-10 mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
        <button className="btn btn-primary" onClick={toggle} data-action="play">
          {state === "playing" ? <Pause size={17} /> : <Play size={17} />}
          {t(state === "playing" ? "listen.pause" : state === "paused" ? "listen.resume" : "listen.play")}
        </button>
        <button className="icon-btn" aria-label={t("listen.prev")} disabled={at.passage === 0} onClick={() => play(Math.max(0, at.passage - 1))}><SkipBack size={17} /></button>
        <button className="icon-btn" aria-label={t("listen.next")} disabled={at.passage >= last} onClick={() => play(Math.min(last, at.passage + 1))}><SkipForward size={17} /></button>
        <button className="icon-btn" aria-label={t("listen.stop")} disabled={state === "idle"} onClick={stop}><Square size={16} /></button>
        <label className="ms-auto flex items-center gap-2 text-[14px]">
          {t("listen.speed")}
          <select className="input h-9 w-auto py-0" value={rate} onChange={(e) => {
            const r = Number(e.target.value);
            setRate(r);
            // A new speed takes effect from the passage being read.
            if (state === "playing") play(at.passage, { rate: r });
          }}>
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-[14px]">
          {t("listen.voice")}
          <select className="input h-9 w-auto max-w-[220px] py-0" value={voice?.name ?? ""} onChange={(e) => {
            setVoiceName(e.target.value);
            if (state === "playing") play(at.passage, { voice: choices.find((v) => v.name === e.target.value) });
          }} disabled={!choices.length}>
            {!choices.length && <option value="">{t("listen.voiceDefault")}</option>}
            {choices.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </label>
      </div>
      {!choices.length && voices.length > 0 && <p className="mb-3 text-[14px] text-muted">{t("listen.noVoice")}</p>}
      <div lang={doc.lang} className="space-y-3 text-[16px] leading-relaxed">
        {doc.passages.map((p, i) => {
          const current = i === at.passage && state !== "idle";
          const word = current ? at.word : undefined;
          const Tag = p.kind === "heading" ? "h3" : "p";
          return (
            <div key={i}>
              {(i === 0 || doc.passages[i - 1].page !== p.page) && <p className="mb-1 text-[12px] uppercase tracking-wide text-muted">{t("ws.page", { n: p.page })}</p>}
              <Tag
                data-passage={i}
                aria-current={current || undefined}
                onClick={() => play(i)}
                className={`cursor-pointer rounded-md px-2 py-1 ${p.kind === "heading" ? "text-[18px] font-semibold" : ""} ${p.kind === "list" ? "ps-6" : ""} ${current ? "bg-[color-mix(in_oklab,var(--brand)_12%,var(--surface))]" : "hover:bg-surface-2"}`}
              >
                {word ? (
                  <>
                    {p.text.slice(0, word[0])}
                    <mark className="rounded bg-[color-mix(in_oklab,var(--brand)_35%,transparent)] text-ink">{p.text.slice(word[0], word[1])}</mark>
                    {p.text.slice(word[1])}
                  </>
                ) : p.text}
              </Tag>
            </div>
          );
        })}
      </div>
    </div>
  );
}
