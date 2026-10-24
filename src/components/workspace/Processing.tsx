"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { useI18n } from "../I18n";
import { PaperStage } from "../paper/PaperStage";
import { paperAction, reducedMotion } from "@/lib/paper";
import type { ToolId } from "@/lib/tools";

// While a tool works: its sheet performs the tool's action, and the bar and
// percentage glide to each new value instead of jumping.
export function Processing({ tool, value, label }: { tool: ToolId; value: number; label?: string }) {
  const { t } = useI18n();
  const bar = useRef<HTMLDivElement>(null);
  const pct = useRef<HTMLParagraphElement>(null);
  const shown = useRef({ v: 0 });

  useEffect(() => {
    const target = Math.max(0.04, Math.min(1, value));
    const write = () => {
      if (bar.current) bar.current.style.transform = `scaleX(${shown.current.v})`;
      if (pct.current) pct.current.textContent = `${Math.round(shown.current.v * 100)}%`;
    };
    if (reducedMotion()) {
      shown.current.v = target;
      write();
      return;
    }
    const tween = gsap.to(shown.current, { v: target, duration: 0.6, ease: "power2.out", onUpdate: write });
    return () => {
      tween.kill();
    };
  }, [value]);

  return (
    <>
      <PaperStage mode={paperAction(tool)} className="h-[200px] w-full max-w-[320px] sm:h-[240px]" />
      <p className="mt-4 text-[17px] font-medium tracking-[-0.01em]">{t("ws.processing")}</p>
      {label && <p className="mt-1 text-[14px] text-muted">{label}</p>}
      <div className="relative mt-6 h-1.5 w-full overflow-hidden rounded-full bg-line">
        <div ref={bar} className="progress-fill absolute inset-0 origin-left rounded-full bg-ink rtl:origin-right" style={{ transform: "scaleX(0.04)" }} />
      </div>
      <p ref={pct} className="eyebrow mt-2.5 tabular">{Math.round(value * 100)}%</p>
    </>
  );
}
