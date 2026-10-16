export const LOCALES = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "ja", name: "日本語" },
  { code: "ru", name: "Русский" },
  { code: "ko", name: "한국어" },
  { code: "zh-cn", name: "中文 (简体)" },
  { code: "zh-tw", name: "中文 (繁體)" },
  { code: "ar", name: "العربية", rtl: true },
  { code: "bg", name: "Български" },
  { code: "ca", name: "Català" },
  { code: "nl", name: "Nederlands" },
  { code: "el", name: "Ελληνικά" },
  { code: "hi", name: "हिन्दी" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "ms", name: "Bahasa Melayu" },
  { code: "pl", name: "Polski" },
  { code: "sv", name: "Svenska" },
  { code: "th", name: "ภาษาไทย" },
  { code: "tr", name: "Türkçe" },
  { code: "uk", name: "Українська" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "sw", name: "Kiswahili" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_CODES = LOCALES.map((l) => l.code) as readonly Locale[];

export const hasLocale = (value: string): value is Locale =>
  (LOCALE_CODES as readonly string[]).includes(value);

export const isRtl = (locale: Locale) =>
  LOCALES.some((l) => l.code === locale && "rtl" in l && l.rtl);

// Picks the best supported locale from an Accept-Language header.
export function matchLocale(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE;
  const wanted = header
    .split(",")
    .map((part) => {
      const [tag, q] = part.trim().split(";q=");
      return { tag: tag.toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of wanted) {
    if (hasLocale(tag)) return tag;
    if (tag.startsWith("zh")) return /tw|hk|hant/.test(tag) ? "zh-tw" : "zh-cn";
    const base = tag.split("-")[0];
    if (hasLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
