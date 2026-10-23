"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Upload } from "lucide-react";
import { useI18n } from "../I18n";
import type { Tool } from "@/lib/tools";

export function acceptAttr(tool: Tool) {
  return tool.accept.map((e) => `.${e}`).join(",") + (tool.accept.includes("jpg") ? ",image/*" : "");
}

const editable = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// Files dropped anywhere on the page, or pasted, at any stage. A file drag
// is always cancelled, so the browser never opens the file in place of the
// page and loses the session. Returns whether files are being dragged over.
export function useFileIntake(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const handler = useRef(onFiles);
  useEffect(() => {
    handler.current = onFiles;
  });

  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const dragover = (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (!isFiles(e) && !e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (e.dataTransfer?.files.length) handler.current(Array.from(e.dataTransfer.files));
    };
    // Pasting into a text field stays a text paste.
    const paste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files?.length || editable(e.target)) return;
      e.preventDefault();
      handler.current(Array.from(files));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", dragover);
      window.removeEventListener("drop", drop);
      window.removeEventListener("paste", paste);
    };
  }, []);
  return over;
}

// The big first-step target, or a compact "Add more" button. Drops and
// pastes are handled page-wide by useFileIntake; `over` only styles it.
export function Dropzone({ tool, onFiles, compact = false, over = false }: { tool: Tool; onFiles: (f: File[]) => void; compact?: boolean; over?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);

  // The picker is a label around the input, so it opens before React has
  // hydrated. A file chosen in that moment never fired onChange: take it now.
  useEffect(() => {
    const el = input.current;
    if (!el?.files?.length) return;
    onFiles(Array.from(el.files));
    el.value = "";
  }, [onFiles]);

  const picker = (
    <input
      ref={input}
      type="file"
      className="sr-only"
      multiple={tool.multiple}
      accept={acceptAttr(tool)}
      onChange={(e) => {
        if (e.target.files?.length) onFiles(Array.from(e.target.files));
        e.target.value = "";
      }}
    />
  );
  // Keyboard focus lands on the visually hidden input; show it on the label.
  const focus = "cursor-pointer has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-(--focus)";

  if (compact) {
    return (
      <label className={`btn btn-quiet btn-sm ${focus}`}>
        {picker}
        <Plus size={16} /> {t("ws.addMore")}
      </label>
    );
  }

  return (
    <div
      data-over={over || undefined}
      className="dropzone group/drop relative mx-auto flex max-w-[780px] flex-col items-center rounded-[28px] bg-surface px-4 py-16 text-center shadow-card transition-[background-color,box-shadow,scale] duration-500 ease-(--ease-out) data-[over]:scale-[1.015] data-[over]:shadow-lift sm:px-6 sm:py-24"
    >
      <svg aria-hidden className="dropzone-edge pointer-events-none absolute inset-0 h-full w-full overflow-visible">
        <rect width="100%" height="100%" rx="28" fill="none" stroke="var(--line-strong)" strokeWidth="1" />
      </svg>
      {/* Two sheets that lift apart while files are dragged over. */}
      <div aria-hidden className="relative mb-9 h-16 w-12">
        <span className="absolute inset-0 rounded-[4px] border border-line-strong bg-bg transition-transform duration-700 ease-(--ease-spring) -rotate-6 group-hover/drop:-translate-x-1.5 group-hover/drop:-rotate-12 group-data-[over]/drop:-translate-x-4 group-data-[over]/drop:-rotate-[18deg]" />
        <span className="absolute inset-0 overflow-hidden rounded-[4px] border border-line-strong bg-surface transition-transform duration-700 ease-(--ease-spring) rotate-3 group-hover/drop:translate-x-1.5 group-hover/drop:rotate-6 group-data-[over]/drop:-translate-y-3 group-data-[over]/drop:translate-x-4 group-data-[over]/drop:rotate-12">
          <span className="absolute end-0 top-0 h-3.5 w-3.5 bg-accent [clip-path:polygon(0_0,100%_100%,0_100%)]" />
          <span className="absolute inset-x-2 top-5 h-px bg-line-strong" />
          <span className="absolute inset-x-2 top-7 h-px bg-line-strong" />
          <span className="absolute start-2 end-4 top-9 h-px bg-line-strong" />
        </span>
      </div>
      <label className={`btn btn-lg btn-primary max-w-full whitespace-normal ${focus}`}>
        {picker}
        <Upload size={18} strokeWidth={1.75} /> {tool.multiple ? t("ws.select") : t("ws.selectOne")}
      </label>
      <p className="mt-4 font-display text-[1.35rem] text-muted transition-colors group-data-[over]/drop:text-ink">{over ? t("ws.dropActive") : tool.multiple ? t("ws.drop") : t("ws.dropOne")}</p>
      <p className="eyebrow mt-10">
        {t("ws.accepts", { types: tool.accept.filter((e) => e !== "jpeg").map((e) => e.toUpperCase()).join(" · ") })}
      </p>
    </div>
  );
}
