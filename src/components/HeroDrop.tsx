"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileText, RotateCcw, Upload } from "lucide-react";
import { useI18n } from "./I18n";
import { ToolIcon } from "./ToolIcon";
import { Friend } from "./Studio";
import { useFileIntake } from "./workspace/Dropzone";
import { handOffTo, toolsFor } from "@/lib/handoff";
import type { Tool, ToolId } from "@/lib/tools";

// The jobs people come for most, first; everything else after, in the
// registry's order.
const FIRST: ToolId[] = [
  "compress", "merge", "split", "edit", "sign", "pdfToWord", "jpgToPdf", "protect", "rotate", "organize",
  "pdfToJpg", "ocr", "summarize", "chat", "watermark", "pageNumbers", "redact", "unlock", "translate", "wordToPdf",
];
const rank = (t: Tool) => {
  const i = FIRST.indexOf(t.id);
  return i < 0 ? FIRST.length : i;
};
const SHOWN = 6;

// "Not sure which tool?": drop or pick a file anywhere on the home page and
// the tools that take it appear. Choosing one hands the file over
// (src/lib/handoff.ts), as "Open with" does, so it never has to be picked twice.
export function HeroDrop() {
  const { t, href } = useI18n();
  const router = useRouter();
  const [files, setFiles] = useState<File[] | null>(null);
  const [all, setAll] = useState(false);
  const over = useFileIntake((f) => {
    setFiles(f);
    setAll(false);
  });

  const tools = files ? [...toolsFor(files)].sort((a, b) => rank(a) - rank(b)) : [];
  const shown = all ? tools : tools.slice(0, SHOWN);

  const open = async (tool: Tool) => {
    if (!files) return;
    await handOffTo(tool.id, files);
    router.push(href(`/${tool.slug}`));
  };

  if (files?.length) {
    return (
      <section aria-live="polite" className="rise rounded-[28px] border border-line bg-surface p-4 shadow-card sm:p-5">
        <div className="flex items-center gap-3">
          <span data-cat="edit" className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-(--tint) text-(--tint-ink)">
            <FileText size={20} strokeWidth={1.75} aria-hidden />
          </span>
          <p className="min-w-0 flex-1 text-pretty text-[15px] font-medium leading-snug">
            {t("handoff.pick", { name: files.length > 1 ? `${files[0].name} +${files.length - 1}` : files[0].name })}
          </p>
          <button type="button" className="icon-btn shrink-0" aria-label={t("res.startOver")} onClick={() => setFiles(null)}>
            <RotateCcw size={16} />
          </button>
        </div>
        {tools.length ? (
          <ul aria-label={t("open.tools")} className="stagger mt-4 grid gap-2 sm:grid-cols-2">
            {shown.map((tool, i) => (
              <li key={tool.id} style={{ "--i": i } as React.CSSProperties}>
                <a
                  href={href(`/${tool.slug}`)}
                  onClick={(e) => {
                    e.preventDefault();
                    void open(tool);
                  }}
                  className="group flex items-center gap-3 rounded-2xl border border-line bg-bg p-2 pe-3 transition-[border-color,box-shadow,translate] duration-300 ease-(--ease-out) hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card"
                >
                  <ToolIcon tool={tool} size={36} />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{t(`tool.${tool.id}.name`)}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-pretty text-[15px] text-ink-2">{t("open.noTool")}</p>
        )}
        {tools.length > SHOWN && !all && (
          <button type="button" className="btn btn-ghost btn-sm mt-3" onClick={() => setAll(true)}>
            {t("home.showAll", { n: tools.length })}
          </button>
        )}
      </section>
    );
  }

  return (
    <div
      data-over={over || undefined}
      className="group/drop dropzone relative flex items-center gap-4 rounded-[28px] border-2 border-dashed border-line-strong bg-surface p-4 transition-[border-color,background-color,scale] duration-500 ease-(--ease-out) data-[over]:scale-[1.02] data-[over]:border-brand sm:gap-5 sm:p-5"
    >
      <div data-cat="convertTo" className="w-14 shrink-0 transition-transform duration-500 ease-(--ease-spring) group-hover/drop:-rotate-6 group-data-[over]/drop:-translate-y-1 group-data-[over]/drop:scale-110 sm:w-16">
        <Friend mood={over ? "wow" : "happy"} className="w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-pretty text-[16px] font-semibold leading-snug tracking-[-0.01em]">{over ? t("ws.dropActive") : t("home.dropTitle")}</p>
        <p className="mt-1 text-pretty text-[14px] leading-snug text-muted">{t("home.dropBody")}</p>
      </div>
      <label className="btn btn-primary hidden shrink-0 cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--focus) sm:inline-flex">
        <Upload size={17} strokeWidth={1.75} /> {t("ws.selectOne")}
        <input
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) setFiles([...e.target.files]);
            e.target.value = "";
          }}
        />
      </label>
      {/* Phones: the whole card is the picker. */}
      <label className="absolute inset-0 cursor-pointer rounded-[28px] sm:hidden">
        <span className="sr-only">{t("ws.selectOne")}</span>
        <input
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) setFiles([...e.target.files]);
            e.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
