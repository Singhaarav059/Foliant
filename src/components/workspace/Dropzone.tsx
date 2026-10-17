"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Upload } from "lucide-react";
import { useI18n } from "../I18n";
import type { Tool } from "@/lib/tools";

export function acceptAttr(tool: Tool) {
  return tool.accept.map((e) => `.${e}`).join(",") + (tool.accept.includes("jpg") ? ",image/*" : "");
}

// The big first-step target. Also listens for files dropped anywhere on the page.
export function Dropzone({ tool, onFiles, compact = false }: { tool: Tool; onFiles: (f: File[]) => void; compact?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    if (compact) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setOver(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const over = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      onFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [compact, onFiles]);

  const picker = (
    <input
      ref={input}
      type="file"
      hidden
      multiple={tool.multiple}
      accept={acceptAttr(tool)}
      onChange={(e) => {
        if (e.target.files?.length) onFiles(Array.from(e.target.files));
        e.target.value = "";
      }}
    />
  );

  if (compact) {
    return (
      <>
        {picker}
        <button className="btn btn-quiet btn-sm" onClick={() => input.current?.click()}>
          <Plus size={16} /> {t("ws.addMore")}
        </button>
      </>
    );
  }

  return (
    <div
      data-over={over || undefined}
      className="dropzone relative mx-auto flex max-w-[760px] flex-col items-center rounded-2xl border border-dashed border-line-strong bg-surface px-4 py-16 text-center transition-[border-color,background-color] duration-200 data-[over]:border-solid data-[over]:border-ink sm:px-6 sm:py-24"
    >
      {picker}
      <button className="btn btn-lg btn-primary max-w-full whitespace-normal" onClick={() => input.current?.click()}>
        <Upload size={18} strokeWidth={1.75} /> {tool.multiple ? t("ws.select") : t("ws.selectOne")}
      </button>
      <p className="mt-3.5 text-[15px] text-muted">{over ? t("ws.dropActive") : tool.multiple ? t("ws.drop") : t("ws.dropOne")}</p>
      <p className="eyebrow mt-10">
        {t("ws.accepts", { types: tool.accept.filter((e) => e !== "jpeg").map((e) => e.toUpperCase()).join(" · ") })}
      </p>
    </div>
  );
}
