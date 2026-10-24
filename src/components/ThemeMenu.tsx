"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useI18n } from "./I18n";
import { THEME_COLOR, THEME_KEY, THEMES, type Theme } from "@/lib/theme";

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

// Theme changes made on this page, so every menu instance re-reads.
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const read = (): Theme => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
};

function apply(theme: Theme) {
  const root = document.documentElement;
  const set = () => {
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    // The browser bar follows: one colour for a chosen theme, the
    // light/dark pair for the device's.
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
      m.content = theme === "system" ? (m.media.includes("dark") ? THEME_COLOR.dark : THEME_COLOR.light) : THEME_COLOR[theme];
    });
    // After the change: a view transition runs this callback later.
    listeners.forEach((fn) => fn());
  };
  // Cross-fade the whole page where the browser can.
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !reduce) document.startViewTransition(set);
  else set();
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage blocked: the choice lasts for this page */
  }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, read, () => "system" as Theme);
  return [theme, apply] as const;
}

// The header's theme button and its three-way menu.
export function ThemeMenu() {
  const { t } = useI18n();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const Icon = ICONS[theme];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        className="icon-btn aria-expanded:bg-surface-2"
        aria-label={`${t("theme.label")}: ${t(`theme.${theme}`)}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        <Icon key={theme} size={16} strokeWidth={1.75} className="rise" />
      </button>
      {open && (
        <div role="menu" aria-label={t("theme.label")} className="unfold card absolute end-0 top-11 w-44 p-1.5 shadow-lift">
          {THEMES.map((option) => {
            const OptionIcon = ICONS[option];
            return (
              <button
                key={option}
                role="menuitemradio"
                aria-checked={theme === option}
                onClick={() => {
                  setTheme(option);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-start text-[14px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink aria-checked:bg-surface-2 aria-checked:font-medium aria-checked:text-ink"
              >
                <OptionIcon size={15} strokeWidth={1.75} aria-hidden />
                {t(`theme.${option}`)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// The same three choices as a segmented control, for the phone menu.
export function ThemeSwitch() {
  const { t } = useI18n();
  const [theme, setTheme] = useTheme();
  return (
    <div role="radiogroup" aria-label={t("theme.label")} className="grid grid-cols-3 gap-1 rounded-full border border-line bg-surface p-1">
      {THEMES.map((option) => {
        const OptionIcon = ICONS[option];
        return (
          <button
            key={option}
            role="radio"
            aria-checked={theme === option}
            onClick={() => setTheme(option)}
            className="flex h-9 items-center justify-center gap-1.5 rounded-full text-[13px] text-ink-2 transition-colors aria-checked:bg-ink aria-checked:text-bg"
          >
            <OptionIcon size={14} strokeWidth={1.75} aria-hidden />
            {t(`theme.${option}`)}
          </button>
        );
      })}
    </div>
  );
}
