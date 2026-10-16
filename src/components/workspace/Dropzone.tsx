"use client";

import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useI18n } from "../I18n";
import type { Tool } from "@/lib/tools";
import { categoryColor } from "@/lib/tools";

export function acceptAttr(tool: Tool) {
  return tool.accept.map((e) => `.${e}`).join(",") + (tool.accept.includes("jpg") ? ",image/*" : "");
}

// The big first-step target. Also listens for files dropped anywhere on the page.
export function Dropzone({ tool, onFiles, compact = false }: { tool: Tool; onFiles: (f: File[]) => void; compact?: boolean }) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const color = categoryColor(tool.category);

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
          <Upload size={16} /> {t("ws.addMore")}
        </button>
      </>
    );
  }

  return (
    <div
      className="relative mx-auto flex max-w-[760px] flex-col items-center rounded-[22px] border-2 border-dashed px-4 py-14 sm:px-6 text-center transition-colors sm:py-20"
      style={{
        borderColor: over ? color : "var(--line-strong)",
        background: over ? `color-mix(in oklab, ${color} 7%, var(--surface))` : "var(--surface)",
      }}
    >
      {picker}
      <button className="btn btn-lg btn-primary max-w-full whitespace-normal" style={{ background: color }} onClick={() => input.current?.click()}>
        <Upload size={20} /> {tool.multiple ? t("ws.select") : t("ws.selectOne")}
      </button>
      <p className="mt-3 text-[15px] text-muted">{over ? t("ws.dropActive") : tool.multiple ? t("ws.drop") : t("ws.dropOne")}</p>
      <p className="mt-6 text-[13px] text-muted">
        {t("ws.accepts", { types: tool.accept.filter((e) => e !== "jpeg").map((e) => e.toUpperCase()).join(", ") })}
      </p>
    </div>
  );
}
