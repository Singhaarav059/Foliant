"use client";

import { Check } from "lucide-react";
import { useI18n } from "../I18n";

// Where the visitor is in a tool: add files, set it up, download. The
// current step is announced to screen readers; done steps get a tick.
const STEPS = ["select", "work", "done"] as const;
const LABELS = ["ws.stepAdd", "ws.stepSet", "ws.stepGet"] as const;

export function StepTrail({ view }: { view: "select" | "work" | "busy" | "done" }) {
  const { t } = useI18n();
  const current = view === "busy" ? 1 : STEPS.indexOf(view);
  return (
    <ol aria-label={t("ws.steps")} className="mx-auto mb-8 flex max-w-[560px] items-center justify-center gap-2 sm:gap-3">
      {LABELS.map((label, i) => {
        const state = i < current ? "done" : i === current ? "now" : "next";
        return (
          <li key={label} aria-current={state === "now" ? "step" : undefined} className="flex min-w-0 items-center gap-2 sm:gap-3">
            {i > 0 && (
              <span aria-hidden className="relative h-px w-6 overflow-hidden bg-line-strong sm:w-12">
                <span className={`absolute inset-0 origin-left bg-ink transition-transform duration-700 ease-(--ease-out) rtl:origin-right ${i <= current ? "scale-x-100" : "scale-x-0"}`} />
              </span>
            )}
            <span
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border font-mono text-[12px] transition-[background-color,border-color,color,scale] duration-500 ease-(--ease-spring) ${
                state === "next" ? "border-line-strong text-muted" : "scale-105 border-ink bg-ink text-bg"
              } ${state === "now" && view === "busy" ? "animate-pulse" : ""}`}
            >
              {state === "done" ? <Check size={14} strokeWidth={2.5} aria-hidden /> : i + 1}
            </span>
            <span className={`truncate text-[13px] transition-colors sm:text-[14px] ${state === "next" ? "text-muted" : "font-medium text-ink"}`}>
              {t(label)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
