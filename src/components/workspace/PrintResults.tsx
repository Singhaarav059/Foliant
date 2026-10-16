"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Printer, RefreshCw, ShieldCheck } from "lucide-react";
import { useI18n } from "../I18n";
import type { Output } from "@/lib/pdf/common";

// Static build: the converted document is shown here and saved through the
// browser's print dialog ("Save as PDF"), which needs a click to open.
export function PrintResults({ outputs, onReset }: { outputs: Output[]; onReset: () => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const urls = useMemo(() => outputs.map((o) => URL.createObjectURL(o.blob)), [outputs]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  const print = () => frame.current?.contentWindow?.print();

  return (
    <div className="rise mx-auto max-w-[760px] text-center">
      <Printer size={44} className="mx-auto text-brand" strokeWidth={1.8} />
      <h2 className="mt-3 text-2xl font-bold tracking-[-0.02em]">{t("ws.printTitle")}</h2>
      <p className="mx-auto mt-2 max-w-[520px] text-[15px] text-ink-2">{t("ws.printHint")}</p>
      <p className="mt-2 flex items-center justify-center gap-1.5 text-[13px] text-muted">
        <ShieldCheck size={14} /> {t("ws.processedLocally")}
      </p>

      {outputs.length > 1 && (
        <div className="mt-6 flex flex-wrap justify-center gap-2" role="tablist">
          {outputs.map((o, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === current}
              onClick={() => setCurrent(i)}
              className={`max-w-[240px] truncate rounded-full border px-3.5 py-1.5 text-[14px] ${i === current ? "border-brand bg-surface font-semibold" : "border-line bg-surface hover:border-line-strong"}`}
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
        className="mt-6 h-[560px] w-full rounded-2xl border border-line bg-white"
      />
    </div>
  );
}
