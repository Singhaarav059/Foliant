"use client";

import { useSyncExternalStore } from "react";
import { Check, Lightbulb, X } from "lucide-react";
import { useI18n } from "../I18n";
import { Friend } from "../Studio";
import type { ToolMode } from "@/lib/tools";

// Where the visitor is in a tool: add files, set it up, download. The
// current step is announced to screen readers; done steps get a tick.
const STEPS = ["select", "work", "done"] as const;
const LABELS = ["ws.stepAdd", "ws.stepSet", "ws.stepGet"] as const;

// Tips can be switched off once, for every tool; the choice is kept on this
// device. Without storage they simply show.
const TIPS_KEY = "tips";
const tipListeners = new Set<() => void>();
const readTips = () => {
  try {
    return localStorage.getItem(TIPS_KEY) !== "off";
  } catch {
    return true;
  }
};
const setTips = (on: boolean) => {
  try {
    if (on) localStorage.removeItem(TIPS_KEY);
    else localStorage.setItem(TIPS_KEY, "off");
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
  tipListeners.forEach((fn) => fn());
};
const subscribeTips = (fn: () => void) => {
  tipListeners.add(fn);
  return () => tipListeners.delete(fn);
};

// One line of help for the step on show, never more.
function tipFor(view: string, mode: ToolMode) {
  if (view === "select") return "coach.select";
  if (view === "done") return "coach.done";
  if (view !== "work") return null;
  return mode === "pages" ? "coach.workPages" : mode === "editor" ? "coach.workEditor" : "coach.work";
}

export function StepTrail({ view, mode, cat }: { view: "select" | "work" | "busy" | "done"; mode: ToolMode; cat: string }) {
  const { t } = useI18n();
  const tips = useSyncExternalStore(subscribeTips, readTips, () => true);
  const current = view === "busy" ? 1 : STEPS.indexOf(view);
  const tip = tipFor(view, mode);
  return (
    <div data-cat={cat} className="mx-auto mb-5 flex max-w-[1040px] flex-col items-center gap-x-4 gap-y-2 lg:flex-row lg:justify-center">
      <ol aria-label={t("ws.steps")} className="flex items-center justify-center gap-1.5 rounded-full border border-line bg-surface p-1.5 shadow-card sm:gap-2">
        {LABELS.map((label, i) => {
          const state = i < current ? "done" : i === current ? "now" : "next";
          return (
            <li key={label} aria-current={state === "now" ? "step" : undefined} className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              {i > 0 && (
                <span aria-hidden className="relative h-0.5 w-3 overflow-hidden rounded-full bg-line sm:w-6">
                  <span className={`absolute inset-0 origin-left rounded-full bg-(--tint-ink) transition-transform duration-700 ease-(--ease-out) rtl:origin-right ${i <= current ? "scale-x-100" : "scale-x-0"}`} />
                </span>
              )}
              <span
                className={`flex h-8 min-w-0 items-center gap-2 rounded-full pe-3 ps-1 transition-[background-color,color] duration-500 ease-(--ease-out) ${
                  state === "now" ? "bg-(--tint) text-(--tint-ink)" : state === "done" ? "text-ink" : "text-muted"
                }`}
              >
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold transition-[background-color,color,scale] duration-500 ease-(--ease-spring) ${
                    state === "next" ? "bg-surface-2 text-muted" : "scale-105 bg-(--tint-ink) text-surface"
                  } ${state === "now" && view === "busy" ? "animate-pulse" : ""}`}
                >
                  {state === "done" ? <Check size={13} strokeWidth={3} aria-hidden /> : i + 1}
                </span>
                <span className="truncate text-[13px] font-medium sm:text-[14px]">{t(label)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {tip && tips && (
        <p key={tip} role="note" className="rise flex max-w-full items-center lg:max-w-[440px] gap-2.5 rounded-[18px] py-1 pe-1 ps-1 text-start text-[13.5px] leading-snug text-ink-2">
          <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-(--tint)">
            <Friend mood={view === "done" ? "proud" : "happy"} className="w-[62%]" />
          </span>
          <span className="sr-only">{t("coach.label")}: </span>
          <span className="min-w-0 text-pretty">{t(tip)}</span>
          <button type="button" className="icon-btn h-7 w-7 shrink-0 text-muted" aria-label={t("coach.hide")} title={t("coach.hide")} onClick={() => setTips(false)}>
            <X size={14} />
          </button>
        </p>
      )}
      {tip && !tips && (
        <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-ink" onClick={() => setTips(true)}>
          <Lightbulb size={13} aria-hidden /> {t("coach.show")}
        </button>
      )}
    </div>
  );
}
