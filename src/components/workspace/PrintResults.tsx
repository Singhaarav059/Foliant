"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Printer, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "../I18n";
import type { Output } from "@/lib/pdf/common";

// Static build: an HTML page (or an Office file that couldn't be drawn as a
// PDF) is shown here and saved through the browser's print dialog ("Save as
// PDF"), which needs a click to open.
export function PrintResults({ outputs, onReset }: { outputs: Output[]; onReset: () => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const urls = useMemo(() => outputs.map((o) => URL.createObjectURL(o.blob)), [outputs]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const print = () => frame.current?.contentWindow?.print();

  return (
    <div className="rise mx-auto max-w-[760px] text-center">
      <span className="mx-auto grid h-11 w-11 place-items-center rounded-full border border-line bg-surface text-ink">
        <Printer size={19} strokeWidth={1.75} />
      </span>
      <h2 className="mt-5 text-[1.75rem] font-semibold tracking-[-0.035em]">{t("ws.printTitle")}</h2>
      <p className="mx-auto mt-2 max-w-[520px] text-[15px] text-ink-2">{t("ws.printHint")}</p>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[13px] text-muted">
        <ShieldCheck size={14} /> {t("ws.processedLocally")}
      </p>

      {/* HTML that pointed at other sites: those parts were left out (src/lib/office/html.ts). */}
      {outputs[current].note?.startsWith("remote:") && (
        <p role="status" className="mx-auto mt-4 flex max-w-[560px] items-start gap-2 rounded-xl border border-line bg-surface p-3 text-left text-[14px] text-ink-2">
          <ShieldCheck size={16} className="mt-0.5 shrink-0" /> {t("ws.remoteBlocked", { n: Number(outputs[current].note!.slice(7)) })}
        </p>
      )}

      {outputs.length > 1 && (
        <div className="mt-6 flex flex-wrap justify-center gap-2" role="tablist">
          {outputs.map((o, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === current}
              onClick={() => setCurrent(i)}
              className={`max-w-[240px] truncate rounded-lg border px-3 py-1.5 text-[14px] ${i === current ? "border-ink bg-surface font-medium" : "border-line bg-surface hover:border-line-strong"}`}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button className="btn btn-primary btn-lg" onClick={print}>
          <Printer size={20} /> {t("ws.printSave")}
        </button>
        <button className="btn btn-quiet btn-lg" onClick={onReset}><RefreshCw size={18} /> {t("res.startOver")}</button>
      </div>

      {/* No allow-scripts: scripts in an uploaded HTML file never run here. */}
      <iframe
        key={urls[current]}
        ref={frame}
        src={urls[current]}
        title={outputs[current].name}
        sandbox="allow-same-origin allow-modals"
        className="mt-6 h-[560px] w-full rounded-xl border border-line bg-white"
      />
    </div>
  );
}
