import en, { type Dict, type DictKey } from "./dict/en";
import type { Locale } from "./locales";

type Partial = { [K in DictKey]?: string };

const loaders: Record<Exclude<Locale, "en">, () => Promise<{ default: Partial }>> = {
  es: () => import("./dict/es"),
  fr: () => import("./dict/fr"),
  de: () => import("./dict/de"),
  it: () => import("./dict/it"),
  pt: () => import("./dict/pt"),
  ja: () => import("./dict/ja"),
  ru: () => import("./dict/ru"),
  ko: () => import("./dict/ko"),
  "zh-cn": () => import("./dict/zh-cn"),
  "zh-tw": () => import("./dict/zh-tw"),
  ar: () => import("./dict/ar"),
  bg: () => import("./dict/bg"),
  ca: () => import("./dict/ca"),
  nl: () => import("./dict/nl"),
  el: () => import("./dict/el"),
  hi: () => import("./dict/hi"),
  id: () => import("./dict/id"),
  ms: () => import("./dict/ms"),
  pl: () => import("./dict/pl"),
  sv: () => import("./dict/sv"),
  th: () => import("./dict/th"),
  tr: () => import("./dict/tr"),
  uk: () => import("./dict/uk"),
  vi: () => import("./dict/vi"),
  sw: () => import("./dict/sw"),
};

export async function getDictionary(locale: Locale): Promise<Dict> {
  if (locale === "en") return en;
  const override = (await loaders[locale]()).default;
  return { ...en, ...override } as Dict;
}

export type { Dict, DictKey };

export { format } from "./format";
