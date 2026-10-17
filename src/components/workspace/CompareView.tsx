"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../I18n";
import { PdfThumb } from "../PdfThumb";
import type { PageDiff } from "@/lib/pdf/compare";

export function CompareView({ a, b }: { a: File; b: File }) {
  const { t } = useI18n();
  const [view, setView] = useState<"text" | "visual" | "side">("text");
  const [diffs, setDiffs] = useState<PageDiff[] | null>(null);
  const [page, setPage] = useState(0);
  const [overlay, setOverlay] = useState<{ url: string; pages: number } | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [holderWidth, setHolderWidth] = useState(800);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHolderWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => {
    import("@/lib/pdf/compare").then(({ textDiff }) => textDiff(a, b)).then(setDiffs).catch(() => setDiffs([]));
  }, [a, b]);

  useEffect(() => {
    if (view !== "visual") return;
    let live = true;
    const width = Math.min(1800, holderWidth * Math.min(2, window.devicePixelRatio || 1));
    import("@/lib/pdf/compare").then(({ visualOverlay }) => visualOverlay(a, b, page, width)).then((r) => {
      if (!live) return;
      setOverlay({ url: r.canvas.toDataURL("image/png"), pages: r.pages });
    });
    return () => {
      live = false;
    };
  }, [view, page, a, b, holderWidth]);

  const total = diffs ? diffs.length : 0;
  const changed = diffs?.filter((d) => d.added || d.removed) ?? [];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-0.5 rounded-[10px] bg-surface-2 p-0.5" role="tablist">
          {(["text", "visual", "side"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
              className={`rounded-lg px-3.5 py-1.5 text-[14px] font-medium transition-colors ${view === k ? "bg-surface text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-ink"}`}>
              {t(`cmp.${k}`)}
            </button>
          ))}
        </div>
        {diffs && <span className="tabular text-[14px] text-muted">{t("cmp.changes", { n: changed.length })}</span>}
        <span className="ms-auto flex items-center gap-3 text-[13px]">
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-[#dc2626]" />{t("cmp.removed")}</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-[#2563eb]" />{t("cmp.added")}</span>
        </span>
      </div>

      {view === "text" && (
        !diffs ? <div className="h-40 animate-pulse rounded-xl bg-surface-2" /> :
        changed.length === 0 ? <p className="card p-8 text-center text-muted">{t("cmp.noChanges")}</p> : (
          <div className="space-y-4">
            {changed.map((d) => (
              <article key={d.page} className="card p-5">
                <h3 className="mb-3 flex items-center gap-3 text-[14px] font-medium">
                  {t("ws.page", { n: d.page + 1 })}
                  <span className="tabular font-normal text-[#2563eb]">+{d.added}</span>
                  <span className="tabular font-normal text-[#dc2626]">−{d.removed}</span>
                </h3>
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">
                  {d.changes.map((c, i) =>
                    c.added ? <ins key={i} className="rounded bg-[#dbeafe] px-0.5 text-[#1e40af] no-underline">{c.value}</ins> :
                    c.removed ? <del key={i} className="rounded bg-[#fee2e2] px-0.5 text-[#991b1b]">{c.value}</del> :
                    <span key={i}>{c.value.length > 400 ? `${c.value.slice(0, 180)} … ${c.value.slice(-180)}` : c.value}</span>,
                  )}
                </p>
              </article>
            ))}
          </div>
        )
      )}

      {view !== "text" && (
        <div ref={holder}>
          <div className="mb-3 flex items-center justify-center gap-2">
            <button className="icon-btn" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label={t("ed.prevPage")}><ChevronLeft size={18} /></button>
            <span className="tabular text-[14px] text-muted">{page + 1} / {Math.max(total, overlay?.pages ?? 1)}</span>
            <button className="icon-btn" disabled={page >= Math.max(total, overlay?.pages ?? 1) - 1} onClick={() => setPage((p) => p + 1)} aria-label={t("ed.nextPage")}><ChevronRight size={18} /></button>
          </div>
          {view === "visual" ? (
            overlay ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={overlay.url} alt="" className="mx-auto w-full max-w-[900px] bg-white shadow-[0_0_0_1px_var(--line)]" />
            ) : <div className="mx-auto h-[60vh] max-w-[900px] animate-pulse rounded bg-surface-2" />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {[a, b].map((f, i) => (
                <figure key={i} className="flex flex-col items-center">
                  <figcaption className="mb-2 text-[13px] font-medium text-muted">{i === 0 ? t("cmp.original") : t("cmp.revised")} · <span className="font-normal">{f.name}</span></figcaption>
                  <PdfThumb key={`${i}-${page}`} file={f} page={page} width={Math.min(440, holderWidth / 2 - 12)} />
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
