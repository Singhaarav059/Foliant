"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, FileArchive, RefreshCw, ShieldCheck, Server } from "lucide-react";
import { useI18n } from "../I18n";
import { ToolIcon } from "../ToolIcon";
import { PdfThumb } from "../PdfThumb";
import { handOff } from "@/lib/handoff";
import { humanSize, type Output } from "@/lib/pdf/common";
import { markdownToText } from "@/lib/ai/extractive";
import { TOOLS, type Tool, type ToolId } from "@/lib/tools";

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

  const saved = first?.note?.startsWith("saved:") ? first.note.split(":").map(Number) : null;
  const pdfaLevel = outputs.find((o) => o.note?.startsWith("pdfaDowngraded:"))?.note?.split(":")[1];

  return (
    <div className="rise mx-auto max-w-[760px] text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-[color-mix(in_oklab,var(--success)_14%,var(--surface))] text-success">
        <Check size={20} strokeWidth={2.25} />
      </span>
      <h2 className="mt-5 text-[1.75rem] font-semibold tracking-[-0.035em]">
        {summary ? t(outputs.length > 1 ? "res.summaryTitlePlural" : "res.summaryTitle") : outputs.length > 1 ? t("res.doneTitlePlural") : t("res.doneTitle")}
      </h2>
      {saved && (
        <p className="tabular mt-2 text-[15px] text-ink-2">
          {t("res.saved", { pct: Math.round((1 - saved[2] / saved[1]) * 100), from: humanSize(saved[1]), to: humanSize(saved[2]) })}
        </p>
      )}
      {first?.note === "notSmaller" && <p className="mt-2 text-[15px] text-muted">{t("res.notSmaller")}</p>}
      {first?.note === "rebuilt" && <p className="mt-2 text-[15px] text-muted">{t("res.rebuilt")}</p>}
      {first?.note?.startsWith("translate:") && <p className="mt-2 text-[15px] text-muted">{t(first.note === "translate:builtin" ? "res.translateBuiltin" : "res.translateModel")}</p>}
      {first?.note === "ocrNone" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrNone")}</p>}
      {first?.note === "ocrDoubtful" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrDoubtful")}</p>}
      {pdfaLevel && <p className="mt-2 text-[15px] text-muted">{t("res.pdfaDowngraded", { level: pdfaLevel })}</p>}
      {summary && (
        <p className="mt-2 text-[15px] text-muted">
          {t(outputs.every((o) => o.note?.startsWith("summary:model")) ? "res.summaryModel" : outputs.every((o) => o.note?.startsWith("summary:builtin")) ? "res.summaryBuiltin" : "res.summaryExtractive")}
          {outputs.some((o) => o.note?.endsWith(":noLang")) && <> {t("res.summaryNoLang")}</>}
        </p>
      )}
      {first?.note === "ocrUsed" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrUsed")}</p>}
      {first?.note === "ocrSkipped" && <p className="mt-2 text-[15px] text-muted">{t("res.ocrSkipped")}</p>}
      {outputs.some((o) => o.unrestricted) && <p className="mt-2 text-[15px] text-muted">{t("res.unrestricted")}</p>}
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[13px] text-muted">
        {tool.runtime === "browser" ? <ShieldCheck size={14} strokeWidth={1.75} /> : <Server size={14} strokeWidth={1.75} />}
        {tool.runtime === "browser" ? t("ws.processedLocally") : t("ws.processedServer")}
      </p>

      {pdfs.length === 1 && outputs.length === 1 && (
        <div className="mt-6 flex justify-center">
          <PdfThumb file={pdfs[0].blob} page={0} width={150} className="rounded-sm" />
        </div>
      )}

      {summary && outputs.map((o, i) => <Summary key={i} output={o} named={outputs.length > 1} />)}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {summary && outputs.length === 1 ? null : outputs.length === 1 ? (
          <button className="btn btn-primary btn-lg" onClick={() => save(first.blob, first.name)}>
            <Download size={20} /> {t("res.download")}
          </button>
        ) : (
          <button className="btn btn-primary btn-lg" disabled={zipping} onClick={async () => {
            setZipping(true);
            try {
              save(await zipAll(outputs), `${tool.slug}-${outputs.length}-files.zip`);
            } finally {
              setZipping(false);
            }
          }}>
            <FileArchive size={20} /> {t("res.downloadAll")}
          </button>
        )}
        <button className="btn btn-quiet btn-lg" onClick={onReset}><RefreshCw size={18} /> {t("res.startOver")}</button>
      </div>

      {outputs.length > 1 && !summary && (
        <ul className="mx-auto mt-6 max-h-[320px] max-w-[520px] divide-y divide-line overflow-auto rounded-xl border border-line bg-surface text-start">
          {outputs.map((o, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[15px]">{o.name}</span>
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
