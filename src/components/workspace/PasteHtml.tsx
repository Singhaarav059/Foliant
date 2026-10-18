"use client";

import { useState } from "react";
import { ClipboardPaste } from "lucide-react";
import { useI18n } from "../I18n";

// HTML to PDF in the static build: pasted HTML becomes a file like any other.
export function PasteHtml({ onFile }: { onFile: (file: File) => void }) {
  const { t } = useI18n();
  const [html, setHtml] = useState("");
  return (
    <form
      className="mx-auto mt-6 max-w-[760px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (html.trim()) onFile(new File([html], "pasted.html", { type: "text/html" }));
      }}
    >
      <label htmlFor="paste-html" className="block text-[14px] font-medium text-ink-2">{t("ws.pasteHtml")}</label>
      <textarea
        id="paste-html"
        className="field mt-2 h-32 w-full resize-y p-3 font-mono text-[14px]"
        placeholder="<h1>…</h1>"
        spellCheck={false}
        value={html}
        onChange={(e) => setHtml(e.target.value)}
      />
      <button className="btn btn-quiet mt-2" disabled={!html.trim()}>
        <ClipboardPaste size={18} /> {t("ws.pasteHtmlUse")}
      </button>
    </form>
  );
}
