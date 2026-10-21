"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronLeft, ChevronRight, Loader2, Square } from "lucide-react";
import { useI18n } from "../I18n";
import { PdfThumb } from "../PdfThumb";
import { AiModels, prepareAi } from "./AiModels";
import { Options } from "./Options";
import type { Answer, DocIndex, Message } from "@/lib/ai/chat";
import type { OptionDef } from "@/lib/tools";

type Turn = { q: string; a?: Answer; text?: string; by?: "light" | "keywords" | "model"; failed?: boolean };

// Loads the chat code and the AI worker ahead of use (src/lib/offline.ts).
export const prepareChat = () => Promise.all([import("@/lib/ai/chat"), prepareAi()]);

// Questions about one PDF, answered from its own text, each answer citing
// its pages; a citation shows that page beside the chat. With no model the
// answer is the sentences that match best; the light model finds them by
// meaning; a language model writes the answer (src/lib/ai/chat.ts).
export function ChatView({ file, models, options, defs, onOption, onError }: {
  file: File;
  models: string[];
  options: Record<string, unknown>;
  defs: OptionDef[];
  onOption: (key: string, value: unknown) => void;
  onError: (e: unknown) => void;
}) {
  const { t } = useI18n();
  // The index of the file as read with these OCR options; others read it again.
  const [built, setBuilt] = useState<{ lang: string; ix: DocIndex; note?: string } | null>(null);
  const [reading, setReading] = useState(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<null | "loading" | "answering">(null);
  const [page, setPage] = useState(1);
  const stop = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  });
  const aiModel = String(options.aiModel ?? "");
  const ocrLang = `${options.ocr ?? "auto"}:${options.ocrLang ?? "eng"}`;
  const index = built?.lang === ocrLang ? built.ix : null;
  const note = built?.lang === ocrLang ? built.note : undefined;

  // Read and index the file once (again if the OCR language changes).
  useEffect(() => {
    let live = true;
    const [ocr, langs] = ocrLang.split(":");
    import("@/lib/ai/chat")
      .then(async (c) => {
        const { pages, note } = await c.readDocument(file, { ocr, ocrLang: langs }, (d, total) => live && setReading(total ? d / total : 0));
        if (!pages.some((p) => p.text.trim())) throw new (await import("@/lib/pdf/errors")).PdfError("no_text", file.name);
        return { ix: await c.buildIndex(pages), note };
      })
      .then(({ ix, note }) => live && setBuilt({ lang: ocrLang, ix, note }), (e) => live && failed.current(e));
    return () => {
      live = false;
    };
  }, [file, ocrLang]);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns]);

  const ask = async () => {
    const question = q.trim();
    if (!question || !index || busy) return;
    setQ("");
    const at = turns.length;
    const update = (u: Partial<Turn>) => setTurns((list) => list.map((x, i) => (i === at ? { ...x, ...u } : x)));
    setTurns((list) => [...list, { q: question }]);
    const ctl = new AbortController();
    stop.current = ctl;
    try {
      const [c, e] = await Promise.all([import("@/lib/ai/chat"), import("@/lib/ai/engine")]);
      // No worker (it failed to start): keywords only.
      const s = await e.status().catch(() => null);
      // Embeddings whenever the light model is on the device and runs;
      // keywords otherwise.
      let ix = index;
      let embed = s?.stored.light ? e.embed : undefined;
      if (embed && !ix.vectors) {
        setBusy("loading");
        try {
          ix = await c.buildIndex(index.pages, embed);
          setBuilt({ lang: ocrLang, ix, note });
        } catch (err) {
          console.warn("The light model didn't run; answering by keywords.", err);
          embed = undefined;
        }
      }
      let a: Answer;
      let by: Turn["by"];
      if ((aiModel === "small" || aiModel === "large") && s?.stored[aiModel]) {
        setBusy("loading");
        await e.loadModel(aiModel);
        setBusy("answering");
        const history: Message[] = turns.flatMap((x) => (x.a ? [{ role: "user" as const, content: x.q }, { role: "assistant" as const, content: x.a.parts.map((p) => p.text).join(" ") }] : []));
        a = await c.askModel(ix, question, { generate: e.generator(aiModel), embed, history, signal: ctl.signal, onPartial: (p) => update({ a: p }) });
        by = "model";
      } else {
        setBusy("answering");
        a = await c.askLight(ix, question, embed);
        by = embed ? "light" : "keywords";
      }
      update({ a, by });
      if (a.pages[0]) setPage(a.pages[0]);
    } catch (err) {
      const { Aborted } = await import("@/lib/ai/engine");
      if (!(err instanceof Aborted)) {
        console.warn("Answering failed.", err);
        update({ failed: true });
      }
    } finally {
      setBusy(null);
      stop.current = null;
    }
  };

  const pages = index?.pages.length ?? 0;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <section aria-label={t("chat.title")} className="card flex min-h-[420px] min-w-0 flex-col">
        <div ref={log} className="flex-1 space-y-5 overflow-auto p-5" aria-live="polite" data-chat-log>
          {!index && (
            <div className="flex items-center gap-2 text-[14px] text-muted">
              <Loader2 size={16} className="animate-spin" /> {t("chat.reading", { pct: Math.round(reading * 100) })}
            </div>
          )}
          {index && !turns.length && <p className="text-[15px] text-muted">{t("chat.empty", { n: pages })}</p>}
          {note && <p className="text-[13px] text-muted" data-ocr-note={note}>{t(`res.${note}`)}</p>}
          {turns.map((x, i) => (
            <div key={i} className="space-y-2">
              <p className="ms-auto w-fit max-w-[85%] rounded-xl bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface))] px-3.5 py-2 text-[15px]">{x.q}</p>
              <div className="max-w-[92%] text-[15px] leading-relaxed" data-answer={x.a && !(busy && i === turns.length - 1) ? "done" : "pending"}>
                {x.failed ? (
                  <p className="text-danger">{t("chat.failed")}</p>
                ) : x.a && x.a.parts.length ? (
                  <p>
                    {x.a.parts.map((p, k) => (
                      <span key={k}>
                        {k > 0 && !/^[.,;:!?)]/.test(p.text) && " "}
                        {p.text}
                        {p.pages?.map((n) => (
                          <button key={n} data-citation={n} onClick={() => setPage(n)} aria-label={t("chat.showPage", { n })}
                            className="mx-0.5 rounded border border-line px-1 align-baseline text-[12px] font-medium text-ink-2 hover:border-line-strong hover:text-ink">
                            {t("chat.pageShort", { n })}
                          </button>
                        ))}
                      </span>
                    ))}
                  </p>
                ) : x.a ? (
                  <p className="text-muted">{t("chat.notFound")}</p>
                ) : (
                  <Loader2 size={16} className="animate-spin text-muted" />
                )}
                {x.by && x.a?.parts.length ? <p className="mt-1 text-[12px] text-muted">{t(`chat.by.${x.by}`)}</p> : null}
              </div>
            </div>
          ))}
        </div>
        <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <label className="sr-only" htmlFor="chat-q">{t("chat.ask")}</label>
          <input id="chat-q" className="field h-11 flex-1 text-[15px]" placeholder={t("chat.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} disabled={!index} autoComplete="off" />
          {busy ? (
            <button type="button" className="btn btn-quiet" onClick={() => stop.current?.abort()} aria-label={t("chat.stop")}>
              {busy === "loading" ? <Loader2 size={18} className="animate-spin" /> : <Square size={16} />}
            </button>
          ) : (
            <button className="btn btn-primary" disabled={!index || !q.trim()} aria-label={t("chat.send")}><ArrowUp size={18} /></button>
          )}
        </form>
        {busy === "loading" && <p className="px-4 pb-3 text-[13px] text-muted">{t("chat.loadingModel")}</p>}
      </section>
      <aside className="space-y-4">
        <div className="card p-4" data-chat-page={page}>
          <div className="mb-3 flex items-center justify-between text-[13px] text-ink-2">
            <button className="btn btn-quiet btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t("chat.prevPage")}><ChevronLeft size={16} className="rtl:rotate-180" /></button>
            <span className="tabular">{pages ? t("chat.pageOf", { n: page, total: pages }) : ""}</span>
            <button className="btn btn-quiet btn-sm" disabled={!pages || page >= pages} onClick={() => setPage((p) => p + 1)} aria-label={t("chat.nextPage")}><ChevronRight size={16} className="rtl:rotate-180" /></button>
          </div>
          <PdfThumb key={page} file={file} page={page - 1} width={300} className="mx-auto rounded-sm border border-line" alt={t("chat.pageOf", { n: page, total: pages })} />
        </div>
        <div className="card p-5">
          <Options defs={defs} values={options} onChange={onOption} />
          <AiModels models={models} value={aiModel} onChange={(v) => onOption("aiModel", v)} />
        </div>
      </aside>
    </div>
  );
}
