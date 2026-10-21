"use client";

import { createContext, useCallback, useContext, useEffect } from "react";
import { format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";

type Ctx = { locale: Locale; dict: Dict };
const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ locale, dict, children }: Ctx & { children: React.ReactNode }) {
  // Remembered for the static build's start page; the server proxy uses a cookie.
  useEffect(() => {
    try {
      localStorage.setItem("locale", locale);
    } catch {
      /* storage blocked */
    }
  }, [locale]);
  return <I18nContext.Provider value={{ locale, dict }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  const { locale, dict } = ctx;
  const t = useCallback(
    (key: DictKey | string, vars?: Record<string, string | number>) =>
      format((dict as Record<string, string>)[key] ?? key, vars, locale),
    [dict, locale],
  );
  // A key that may not exist (option choices like OCR language codes) falls back to its raw value.
  const tOr = useCallback(
    (key: string, fallback: string) => (dict as Record<string, string>)[key] ?? fallback,
    [dict],
  );
  const href = useCallback((path: string) => `/${locale}${path === "/" ? "" : path}`, [locale]);
  return { t, tOr, locale, href };
}
