"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../I18n";
import { PdfThumb } from "../PdfThumb";
import type { PageDiff } from "@/lib/pdf/compare";

// Loads the comparison code ahead of use (src/lib/offline.ts).
export const prepareCompare = () => import("@/lib/pdf/compare");

// Errors from src/lib/pdf/compare.ts say which file failed.
const sideOf = (e: unknown, a: File, b: File) => ((e as { side?: string }).side === "b" ? b : a);

// Every view walks the same rows: pages of the two files lined up by
// content, so an inserted page doesn't shift the rest. A file that can't be
// read goes to onError (the workspace shows why and drops it); nothing here
// ever reads as "no changes" after a failure.
export function CompareView({ a, b, onError }: { a: File; b: File; onError: (e: unknown, file: File) => void }) {
  const { t, href } = useI18n();
  const [view, setView] = useState<"text" | "visual" | "side">("text");
  const [rows, setRows] = useState<PageDiff[] | null>(null);
  const [row, setRow] = useState(0);
  const [overlay, setOverlay] = useState<{ key: string; url: string } | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [holderWidth, setHolderWidth] = useState(800);
  // The latest handler, without rerunning the diff when it changes.
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  });

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHolderWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  useEffect(() => {
    let live = true;
    import("@/lib/pdf/compare").then(({ textDiff }) => textDiff(a, b)).then(
      (r) => live && setRows(r),
      (e) => live && failed.current(e, sideOf(e, a, b)),
    );
    return () => {
      live = false;
    };
  }, [a, b]);

  const pair = rows?.[row];
  const width = Math.min(1800, holderWidth * Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
  const overlayKey = `${row}:${width}`;
  useEffect(() => {
    if (view !== "visual" || !pair) return;
    let live = true;
    import("@/lib/pdf/compare").then(({ visualOverlay }) => visualOverlay(a, b, pair, width)).then(
      (r) => live && setOverlay({ key: overlayKey, url: r.canvas.toDataURL("image/png") }),
      (e) => live && failed.current(e, sideOf(e, a, b)),
    );
    return () => {
      live = false;
    };
  }, [view, pair, a, b, width, overlayKey]);

  const changed = rows?.filter((d) => d.status !== "same") ?? [];
  // Scans and drawings have no text, so every page would read as unchanged.
  const noText = !!rows && rows.every((d) => d.changes.every((c) => !c.value.trim()));
  const title = (d: PageDiff) =>
    d.a === null ? t("cmp.pageAdded", { n: d.b! + 1 })
    : d.b === null ? t("cmp.pageRemoved", { n: d.a + 1 })
    : d.a === d.b ? t("ws.page", { n: d.a + 1 })
    : t("cmp.pageMoved", { a: d.a + 1, b: d.b + 1 });

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
        {rows && !noText && <span className="tabular text-[14px] text-muted">{t("cmp.changes", { n: changed.length })}</span>}
        <span className="ms-auto flex items-center gap-3 text-[13px]">
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-[#dc2626]" />{t("cmp.removed")}</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-[#2563eb]" />{t("cmp.added")}</span>
        </span>
      </div>

      {view === "text" && (
        !rows ? <div className="h-40 animate-pulse rounded-xl bg-surface-2" /> :
        noText ? (
          <div className="card p-8 text-center text-muted">
            <p>{t("cmp.noText")}</p>
            <Link href={href("/ocr-pdf")} className="mt-3 inline-flex items-center gap-1 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
              {t("tool.ocr.name")} <ArrowRight size={15} className="rtl:rotate-180" />
            </Link>
          </div>
        ) :
        changed.length === 0 ? <p className="card p-8 text-center text-muted">{t("cmp.noChanges")}</p> : (
          <div className="space-y-4">
            {changed.map((d) => (
              <article key={`${d.a}:${d.b}`} className="card p-5">
                <h3 className="mb-3 flex items-center gap-3 text-[14px] font-medium">
                  {title(d)}
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
            <button className="icon-btn" disabled={row === 0} onClick={() => setRow((p) => p - 1)} aria-label={t("ed.prevPage")}><ChevronLeft size={18} /></button>
            <span className="tabular text-[14px] text-muted">{row + 1} / {rows?.length ?? 1}</span>
            <button className="icon-btn" disabled={!rows || row >= rows.length - 1} onClick={() => setRow((p) => p + 1)} aria-label={t("ed.nextPage")}><ChevronRight size={18} /></button>
          </div>
          {pair && (pair.status !== "same" || pair.a !== pair.b) && <p className="mb-3 text-center text-[14px] font-medium">{title(pair)}</p>}
          {view === "visual" ? (
            overlay?.key === overlayKey ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={overlay.url} alt="" className="mx-auto w-full max-w-[900px] bg-white shadow-[0_0_0_1px_var(--line)]" />
            ) : <div className="mx-auto h-[60vh] max-w-[900px] animate-pulse rounded bg-surface-2" />
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {([[a, pair?.a], [b, pair?.b]] as const).map(([f, index], i) => (
                <figure key={i} className="flex flex-col items-center">
                  <figcaption className="mb-2 text-[13px] font-medium text-muted">
                    {i === 0 ? t("cmp.original") : t("cmp.revised")} · <span className="font-normal">{f.name}</span>
                    {typeof index === "number" && <span className="font-normal"> · {t("ws.page", { n: index + 1 })}</span>}
                  </figcaption>
                  {!rows ? <div className="h-[50vh] w-full animate-pulse rounded bg-surface-2" />
                    : typeof index === "number" ? <PdfThumb key={`${i}-${index}`} file={f} page={index} width={Math.min(440, holderWidth / 2 - 12)} />
                    : <p className="grid h-40 w-full place-items-center rounded border border-dashed border-line text-[14px] text-muted">{t("cmp.noPage")}</p>}
                </figure>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
