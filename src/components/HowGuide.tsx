"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, MousePointer2 } from "lucide-react";
import { useI18n } from "./I18n";
import { Friend, Sparkle } from "./Studio";

const STEPS = [
  { label: "ws.stepAdd", body: "home.how1", cat: "convertTo" },
  { label: "ws.stepSet", body: "home.how2", cat: "edit" },
  { label: "ws.stepGet", body: "home.how3", cat: "organize" },
] as const;
const DWELL = 5200;

// How a tool works, in three steps you can click through. While it's on
// screen it moves on by itself, until the visitor picks a step, hovers it or
// asks for less motion; then it stays where they put it.
export function HowGuide() {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);
  const [seen, setSeen] = useState(false);
  const [paused, setPaused] = useState(false);
  const box = useRef<HTMLElement>(null);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = auto && seen && !paused;
  useEffect(() => {
    if (!running) return;
    const id = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), DWELL);
    return () => clearTimeout(id);
  }, [running, step]);

  const choose = (i: number) => {
    setAuto(false);
    setStep(i);
  };

  return (
    <section
      ref={box}
      aria-labelledby="how-title"
      className="relative"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <h2 id="how-title" className="reveal display max-w-[20ch] text-[2rem] sm:text-[2.75rem]">{t("home.howTitle")}</h2>
      <div className="mt-10 grid items-center gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14">
        <div role="tablist" aria-label={t("ws.steps")} aria-orientation="vertical" className="flex flex-col gap-2">
          {STEPS.map((s, i) => {
            const on = i === step;
            return (
              <button
                key={s.label}
                role="tab"
                id={`how-tab-${i}`}
                aria-selected={on}
                aria-controls="how-panel"
                tabIndex={on ? 0 : -1}
                data-cat={s.cat}
                onClick={() => choose(i)}
                onKeyDown={(e) => {
                  const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
                  if (!d) return;
                  e.preventDefault();
                  const next = (i + d + STEPS.length) % STEPS.length;
                  choose(next);
                  document.getElementById(`how-tab-${next}`)?.focus();
                }}
                className={`relative overflow-hidden rounded-[24px] border p-5 text-start transition-[background-color,border-color,box-shadow] duration-500 ease-(--ease-out) ${
                  on ? "border-line bg-surface shadow-card" : "border-transparent hover:bg-surface/60"
                }`}
              >
                <span className="flex items-center gap-3">
                  <span
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold transition-[background-color,color,scale] duration-500 ease-(--ease-spring) ${
                      on ? "scale-110 bg-(--tint) text-(--tint-ink)" : "bg-surface-2 text-muted"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className={`text-[17px] font-semibold tracking-[-0.015em] ${on ? "text-ink" : "text-ink-2"}`}>{t(s.label)}</span>
                </span>
                <span
                  className={`grid transition-[grid-template-rows,opacity] duration-500 ease-(--ease-out) ${on ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
                >
                  <span className="overflow-hidden">
                    <span className="block ps-12 pt-2 text-pretty text-[15px] leading-relaxed text-muted">{t(s.body)}</span>
                  </span>
                </span>
                {/* Time left on this step while it moves on by itself. */}
                {on && running && (
                  <span aria-hidden className="absolute inset-x-5 bottom-0 h-[3px] overflow-hidden rounded-full bg-surface-2">
                    <span key={step} className="how-timer block h-full rounded-full bg-(--tint-ink)" style={{ animationDuration: `${DWELL}ms` }} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div
          id="how-panel"
          role="tabpanel"
          aria-labelledby={`how-tab-${step}`}
          data-cat={STEPS[step].cat}
          className="relative aspect-[5/4] w-full overflow-hidden rounded-[32px] bg-(--tint) transition-colors duration-700"
        >
          <div aria-hidden className="absolute inset-0">
            <AddScene on={step === 0} />
            <SetScene on={step === 1} label={t("ws.options")} />
            <GetScene on={step === 2} label={t("res.download")} />
          </div>
        </div>
      </div>
    </section>
  );
}

const scene = (on: boolean) =>
  `how-scene absolute inset-0 grid place-items-center transition-[opacity,translate,scale] duration-700 ease-(--ease-out) ${
    on ? "is-on opacity-100" : "pointer-events-none translate-y-4 scale-[0.97] opacity-0"
  }`;

// 1. A file is dragged in and drops into the tray.
function AddScene({ on }: { on: boolean }) {
  return (
    <div className={scene(on)}>
      <div className="relative h-[62%] w-[66%]">
        <div className="dropzone absolute inset-x-0 bottom-0 h-[62%] rounded-[24px] border-2 border-dashed border-(--tint-ink)/40 bg-surface/70" />
        <div className="how-drop absolute start-[36%] top-0 w-[28%]">
          <div data-cat="convertTo">
            <Friend mood="wow" className="w-full drop-shadow-[0_14px_18px_rgb(60_40_120/0.18)]" />
          </div>
          <MousePointer2 className="absolute -end-4 bottom-[18%] h-7 w-7 fill-ink text-ink" strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
}

// 2. The options set themselves: a switch flips, a slider slides.
function SetScene({ on, label }: { on: boolean; label: string }) {
  return (
    <div className={scene(on)}>
      <div className="flex w-[78%] items-end gap-[6%]">
        <div data-cat="edit" className="w-[26%] shrink-0">
          <Friend mood="proud" className="w-full" />
        </div>
        <div className="flex-1 rounded-[22px] border border-line bg-surface p-[5%] shadow-lift">
          <p className="text-[clamp(11px,1.5vw,14px)] font-semibold">{label}</p>
          <div className="mt-[8%] flex items-center justify-between gap-3">
            <span className="h-2 w-[46%] rounded-full bg-surface-2" />
            <span className="how-switch relative h-5 w-9 rounded-full bg-line-strong">
              <span className="absolute start-0.5 top-0.5 h-4 w-4 rounded-full bg-surface shadow" />
            </span>
          </div>
          <div className="mt-[9%]">
            <span className="h-2 w-[34%] rounded-full bg-surface-2 block" />
            <span className="relative mt-3 block h-1.5 rounded-full bg-surface-2">
              <span className="how-slide absolute inset-y-0 start-0 rounded-full bg-brand" />
              <span className="how-knob absolute top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-brand bg-surface" />
            </span>
          </div>
          <div className="mt-[9%] flex gap-2">
            <span className="h-6 flex-1 rounded-full bg-surface-2" />
            <span className="how-chip h-6 flex-1 rounded-full bg-surface-2" />
          </div>
        </div>
      </div>
    </div>
  );
}

// 3. The button is pressed; the finished file lands with a tick.
function GetScene({ on, label }: { on: boolean; label: string }) {
  return (
    <div className={scene(on)}>
      <div className="relative flex w-[70%] flex-col items-center">
        <div data-cat="organize" className="relative w-[30%]">
          <Friend mood="happy" wave className="how-land w-full" />
          <span className="how-tick absolute -end-3 -top-2 grid h-9 w-9 place-items-center rounded-full bg-success text-white shadow-card">
            <Check size={18} strokeWidth={3} />
          </span>
        </div>
        <span className="how-press btn btn-primary mt-[8%] pointer-events-none">
          <Download size={17} strokeWidth={1.75} /> {label}
        </span>
        <Sparkle className="absolute start-[8%] top-[6%] w-6 text-coral" delay="-0.3s" />
        <Sparkle className="absolute end-[10%] top-[24%] w-4 text-brand" delay="-1.2s" />
        <Sparkle className="absolute start-[22%] bottom-[30%] w-3.5 text-[#f2b53c]" delay="-0.8s" />
      </div>
    </div>
  );
}
