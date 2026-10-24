"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, FileArchive, RefreshCw, ShieldCheck, Server } from "lucide-react";
import { Friend, Sparkle } from "../Studio";
import { useI18n } from "../I18n";
import { ToolIcon } from "../ToolIcon";
import { PdfThumb } from "../PdfThumb";
import { ReportView } from "./ReportView";
import { handOff } from "@/lib/handoff";
import { humanSize, type Output } from "@/lib/pdf/common";
import { markdownToText } from "@/lib/ai/extractive";
import { TOOLS, type Tool, type ToolId } from "@/lib/tools";
import { reducedMotion } from "@/lib/paper";
import { gsap } from "gsap";

const NEXT: ToolId[] = ["compress", "merge", "split", "pageNumbers", "watermark", "protect", "sign", "organize", "rotate", "pdfToWord", "ocr", "edit"];

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function zipAll(outputs: Output[]) {
  const { zipSync } = await import("fflate");
  const used = new Set<string>();
  const entries: Record<string, Uint8Array> = {};
  for (const o of outputs) {
    let name = o.name;
    for (let k = 2; used.has(name); k++) name = o.name.replace(/(\.[^.]+)$/, `-${k}$1`);
    used.add(name);
    entries[name] = new Uint8Array(await o.blob.arrayBuffer());
  }
  return new Blob([zipSync(entries, { level: 0 }) as BlobPart], { type: "application/zip" });
}

export function Results({ tool, outputs, onReset }: { tool: Tool; outputs: Output[]; onReset: () => void }) {
  const { t, href } = useI18n();
  const [zipping, setZipping] = useState(false);
  const pdfs = outputs.filter((o) => o.name.toLowerCase().endsWith(".pdf"));
  const first = outputs[0];
  // Summaries are read on the page; downloading is the user's choice.
  const summary = tool.id === "summarize";

  // Focus moves to the heading, so keyboard and screen-reader users land on the result.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  // The result arrives: the tick pops, the finished sheet lifts out of the
  // page and the rest rises in after it. Styles are cleared afterwards.
  // Opacity only, never visibility: a hidden heading would drop its focus.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || reducedMotion()) return;
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out", clearProps: "all" } });
      tl.from("[data-badge]", { scale: 0, rotate: -40, duration: 0.6, ease: "back.out(2.2)" })
        .from(el.querySelectorAll(":scope > :not([data-badge]):not([data-sheet])"), { y: 18, opacity: 0, duration: 0.6, stagger: 0.05 }, 0.12)
        .from("[data-sheet]", { y: 46, rotationX: 55, opacity: 0, transformPerspective: 900, transformOrigin: "50% 100%", duration: 0.9, ease: "expo.out" }, 0.2);
    }, el);
    return () => ctx.revert();
  }, []);

  // The download button's arrow drops into the tray on each click.
  const [drops, setDrops] = useState(0);

  // Single file: start the download right away, like users expect.
  const autoSaved = useRef<Output[] | null>(null);
  useEffect(() => {
    if (autoSaved.current === outputs) return; // effects can run twice; download once
    autoSaved.current = outputs;
    if (outputs.length === 1 && !outputs[0].note?.startsWith("notSmaller") && !summary) save(outputs[0].blob, outputs[0].name);
  }, [outputs, summary]);

  const next = useMemo(
    () => NEXT.filter((id) => id !== tool.id).map((id) => TOOLS.find((x) => x.id === id)!).slice(0, 8),
    [tool.id],
  );

  // Compress: each file's sizes (a file kept as it was is the same size both
  // ways), and for a batch the totals, so one file that didn't shrink can't
  // stand for all of them.
  const sizes = outputs.map((o) => o.note?.startsWith("saved:") ? o.note.split(":").slice(1).map(Number) as [number, number]
    : o.note === "notSmaller" ? [o.blob.size, o.blob.size] as [number, number] : null);
  const sized = sizes.filter((x): x is [number, number] => !!x);
  const saved = sized.length && sized.some(([a, b]) => b < a)
    ? [0, sized.reduce((n, [a]) => n + a, 0), sized.reduce((n, [, b]) => n + b, 0)] : null;
  // The cloud AI wrote these (summary:cloud:<provider>, translate:cloud:<provider>):
  // "cloudflare" when the backup answered any of them.
  const providers = outputs.flatMap((o) => (/^(summary|translate):cloud:/.test(o.note ?? "") ? [o.note!.split(":")[2]] : []));
  const cloud = providers.includes("cloudflare") ? "cloudflare" : providers.length ? "anthropic" : null;
  const cloudFailed = outputs.some((o) => o.note?.includes(":cloudFailed"));
  const pdfaLevel = outputs.find((o) => o.note?.startsWith("pdfaDowngraded:"))?.note?.split(":")[1];
  // Pages drawn at less than the chosen dpi (too big for the browser's canvas), and what failed.
  const lowerDpi = outputs.flatMap((o) => (o.note?.startsWith("lowerDpi:") ? [Number(o.note.slice(9))] : []));
  const skipped = outputs.flatMap((o) => o.skipped ?? []);
  // Compress to a size and the exam kit (src/lib/pdf/targetsize.ts, examkit.ts).
  const [kind, ...nums] = first?.note?.split(":") ?? [];
  const [n1, n2, n3, n4, n5] = nums.map(Number);
  const kb = (b: number) => `${(b / 1024).toFixed(1)} KB`;
  // Sanitize: what was taken out of any of the files (src/lib/pdf/structure.ts).
  // A count summed over a batch's outputs: "blankRemoved:3".
  const total = (prefix: string) => outputs.reduce((sum, o) => sum + (o.note?.startsWith(prefix) ? Number(o.note.slice(prefix.length)) || 0 : 0), 0);
  const sanitized = outputs.some((o) => o.note?.startsWith("sanitized:"))
    ? [...new Set(outputs.flatMap((o) => (o.note?.startsWith("sanitized:") ? o.note.slice(10).split(",").filter(Boolean) : [])))]
    : null;

  return (
    <div ref={box} className="mx-auto max-w-[760px] text-center" role="status">
      {/* The friend, pleased, with a tick and a few sparkles. */}
      <span data-badge data-cat={tool.category} className="relative mx-auto grid h-24 w-24 place-items-center rounded-full bg-(--tint)">
        <Friend mood="proud" wave className="w-[50%]" />
        <span className="absolute -end-1 top-0 grid h-9 w-9 place-items-center rounded-full bg-success text-white shadow-card">
          <Check size={18} strokeWidth={3} className="ink-check" />
        </span>
        <Sparkle className="absolute -start-4 top-2 w-5 text-coral" delay="-0.4s" />
        <Sparkle className="absolute -end-6 bottom-3 w-3.5 text-brand" delay="-1.3s" />
      </span>
      <h2 ref={heading} tabIndex={-1} data-result className="mt-5 text-[1.75rem] font-semibold tracking-[-0.035em] outline-none">
        {summary ? t(outputs.length > 1 ? "res.summaryTitlePlural" : "res.summaryTitle") : outputs.length > 1 ? t("res.doneTitlePlural") : t("res.doneTitle")}
      </h2>
      {saved && (
        <p className="tabular mt-2 text-[15px] text-ink-2" data-saved>
          {t("res.saved", { pct: Math.round((1 - saved[2] / saved[1]) * 100), from: humanSize(saved[1]), to: humanSize(saved[2]) })}
        </p>
      )}
      {kind === "target" && (
        <p className="tabular mt-2 text-[15px] text-ink-2">
          {t("res.target", { to: kb(n3), target: kb(n1), from: humanSize(n2) })}
          {n5 === 1 && ` ${t("res.targetGray")}`}
          {n4 < 100 && ` ${t("res.targetLowDpi", { dpi: n4 })}`}
        </p>
      )}
      {kind === "targetMissed" && <p className="tabular mt-2 text-[15px] text-ink-2">{t("res.targetMissed", { to: kb(n3), target: kb(n1), from: humanSize(n2) })}</p>}
      {kind === "underTarget" && <p className="tabular mt-2 text-[15px] text-muted">{t("res.underTarget", { size: kb(n2), target: kb(n1) })}</p>}
      {kind === "exam" && (
        <p className="tabular mt-2 text-[15px] text-ink-2">
          {t(nums[0] === "tooBig" ? "res.examTooBig" : "res.exam", { w: n2, h: n3, size: kb(n4), min: n5, max: Number(nums[5]) })}
          {nums[0] === "padded" && ` ${t("res.examPadded", { min: n5 })}`}
        </p>
      )}
      {sized.length > 0 && sized.every(([a, b]) => a === b) && <p className="mt-2 text-[15px] text-muted">{t(outputs.length > 1 ? "res.notSmallerAll" : "res.notSmaller")}</p>}
      {first?.note?.startsWith("textFallback:") && <p className="mt-2 text-[15px] text-muted">{t("res.textFallback", { fonts: first.note.slice(13) })}</p>}
      {first?.note === "rebuilt" && <p className="mt-2 text-[15px] text-muted">{t("res.rebuilt")}</p>}
      {kind === "bookmarks" && <p className="mt-2 text-[15px] text-ink-2">{n1 ? t("res.bookmarks", { n: n1 }) : t("res.bookmarksNone")}</p>}
      {outputs.some((o) => o.note?.startsWith("blank")) && (
        <p className="mt-2 text-[15px] text-ink-2">
          {total("blankRemoved:") ? t("res.blankRemoved", { n: total("blankRemoved:") }) : t("res.blankNone")}
        </p>
      )}
      {kind === "tagged" && (
        <p className="mt-2 text-[15px] text-ink-2">
          {t("res.tagged", { n: n1 })}{n2 > 0 && <> {t("res.taggedFigures", { n: n2 })}</>}
        </p>
      )}
      {first?.note === "tagKept" && <p className="mt-2 text-[15px] text-ink-2">{t("res.tagKept")}</p>}
      {total("grayPartial:") > 0 && <p className="mt-2 text-[15px] text-muted">{t("res.grayPartial", { n: total("grayPartial:") })}</p>}
      {kind === "attached" && <p className="mt-2 text-[15px] text-ink-2">{t("res.attached", { n: n1 })}</p>}
      {sanitized && (
        <p className="mt-2 text-[15px] text-ink-2">
          {sanitized.length ? t("res.sanitized", { list: sanitized.map((k) => t(`res.sanitized.${k}`)).join(", ") }) : t("res.sanitizedNone")}
        </p>
      )}
      {first?.note?.startsWith("translate:") && (
        <p className="mt-2 text-[15px] text-muted">
          {cloudFailed && <>{t("res.cloudFailed")} </>}
          {t(cloud ? `res.translateCloud.${cloud}` : first.note.startsWith("translate:builtin") ? "res.translateBuiltin" : "res.translateModel")}
        </p>
      )}
      {first?.note === "ocrNone" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrNone")}</p>}
      {first?.note === "ocrDoubtful" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrDoubtful")}</p>}
      {first?.note === "ocrUsed" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrUsed")}</p>}
      {first?.note === "ocrSkipped" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrSkipped")}</p>}
      {lowerDpi.length > 0 && <p className="mt-2 text-[15px] text-muted">{t("res.lowerDpi", { dpi: Math.min(...lowerDpi) })}</p>}
      {skipped.length > 0 && (
        <p className="mt-2 text-[15px] text-muted">
          {t("res.skipped", { list: skipped.map((x) => (x.page ? t("res.skippedPage", { file: x.file, n: x.page }) : x.file)).join("; ") })}
        </p>
      )}
      {outputs.some((o) => o.unrestricted) && <p className="mt-2 text-[15px] text-muted">{t("res.unrestricted")}</p>}
      {pdfaLevel && <p className="mt-2 text-[15px] text-muted">{t("res.pdfaDowngraded", { level: pdfaLevel })}</p>}
      {summary && (
        <p className="mt-2 text-[15px] text-muted">
          {cloudFailed && <>{t("res.cloudFailed")} </>}
          {t(cloud ? `res.summaryCloud.${cloud}` : outputs.every((o) => o.note?.startsWith("summary:model")) ? "res.summaryModel" : outputs.every((o) => o.note?.startsWith("summary:builtin")) ? "res.summaryBuiltin" : "res.summaryExtractive")}
          {outputs.some((o) => o.note?.endsWith(":noLang")) && <> {t("res.summaryNoLang")}</>}
        </p>
      )}
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[13px] text-muted">
        {tool.runtime === "browser" && !cloud ? <ShieldCheck size={14} strokeWidth={1.75} /> : <Server size={14} strokeWidth={1.75} />}
        {cloud ? t(`ws.processedCloud.${cloud}`) : tool.runtime === "browser" ? t("ws.processedLocally") : t("ws.processedServer")}
      </p>

      {pdfs.length === 1 && outputs.length === 1 && (
        <div data-sheet className="mt-6 flex justify-center">
          <PdfThumb file={pdfs[0].blob} page={0} width={150} className="rounded-sm shadow-lift" />
        </div>
      )}

      {summary && outputs.map((o, i) => <Summary key={i} output={o} named={outputs.length > 1} />)}
      <ReportView outputs={outputs} />

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {summary && outputs.length === 1 ? null : outputs.length === 1 ? (
          <button className="btn btn-primary btn-lg" onClick={() => { save(first.blob, first.name); setDrops((n) => n + 1); }}>
            <Download key={drops} size={20} className={drops ? "dl-drop" : ""} /> {t("res.download")}
          </button>
        ) : (
          <button className="btn btn-primary btn-lg" disabled={zipping} onClick={async () => {
            setZipping(true);
            try {
              save(await zipAll(outputs), `${tool.slug}-${outputs.length}-files.zip`);
              setDrops((n) => n + 1);
            } finally {
              setZipping(false);
            }
          }}>
            <FileArchive key={drops} size={20} className={drops ? "dl-drop" : ""} /> {t("res.downloadAll")}
          </button>
        )}
        <button className="btn btn-quiet btn-lg" onClick={onReset}><RefreshCw size={18} /> {t("res.startOver")}</button>
      </div>

      {outputs.length > 1 && !summary && (
        <ul className="mx-auto mt-6 max-h-[320px] max-w-[520px] divide-y divide-line overflow-auto rounded-xl border border-line bg-surface text-start">
          {outputs.map((o, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{o.name}</span>
                {sizes[i] && (
                  <span className="block text-[13px] text-muted" data-file-note>
                    {sizes[i]![1] < sizes[i]![0] ? t("res.fileSaved", { pct: Math.round((1 - sizes[i]![1] / sizes[i]![0]) * 100) }) : t("res.fileKept")}
                  </span>
                )}
              </span>
              <span className="tabular text-[13px] text-muted">{humanSize(o.blob.size)}</span>
              <button className="icon-btn" aria-label={`${t("res.download")} ${o.name}`} onClick={() => save(o.blob, o.name)}><Download size={17} /></button>
            </li>
          ))}
        </ul>
      )}

      {pdfs.length > 0 && (
        <div className="mt-12 text-start">
          <p className="eyebrow mb-3 text-center">{t("res.continue")}</p>
          <div className="flex flex-wrap justify-center gap-2">
            {next.map((n) => (
              <Link
                key={n.id}
                href={href(`/${n.slug}`)}
                onClick={() => handOff(pdfs.map((o) => new File([o.blob], o.name, { type: "application/pdf" })))}
                className="group flex items-center gap-2 rounded-lg border border-line bg-surface py-1 ps-1 pe-3 text-[14px] transition-colors hover:border-line-strong"
              >
                <ToolIcon tool={n} size={26} />
                {t(`tool.${n.id}.name`)}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One summary, readable on the page, to copy or save as Markdown or text.
function Summary({ output, named }: { output: Output; named: boolean }) {
  const { t } = useI18n();
  const [md, setMd] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    output.blob.text().then((s) => live && setMd(s));
    return () => {
      live = false;
    };
  }, [output]);
  const text = useMemo(() => markdownToText(md), [md]);
  const base = output.name.replace(/\.md$/i, "");
  return (
    <section className="mx-auto mt-6 max-w-[640px] rounded-xl border border-line bg-surface text-start">
      {named && <h3 className="truncate border-b border-line px-4 py-2.5 text-[14px] font-medium">{base}</h3>}
      <div data-summary className="max-h-[420px] overflow-auto whitespace-pre-wrap px-4 py-3 text-[15px] leading-relaxed">{text}</div>
      <div className="flex flex-wrap gap-2 border-t border-line px-4 py-2.5">
        <button className="btn btn-quiet" onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* clipboard blocked: the text can still be selected */
          }
        }}>
          {copied ? <Check size={17} /> : <Copy size={17} />} <span aria-live="polite">{t(copied ? "res.copied" : "res.copy")}</span>
        </button>
        <button className="btn btn-quiet" onClick={() => save(output.blob, output.name)}><Download size={17} /> {t("res.downloadMd")}</button>
        <button className="btn btn-quiet" onClick={() => save(new Blob([text + "\n"], { type: "text/plain" }), `${base}.txt`)}><Download size={17} /> {t("res.downloadTxt")}</button>
      </div>
    </section>
  );
}
