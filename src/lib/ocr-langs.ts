// OCR languages: what an "ocrLang" option holds, how each language is named,
// and the viewer's remembered choice. The list itself is OCR_LANGS in tools.ts.
//
// An option value is one or more Tesseract codes joined with "+" ("eng+hin"),
// the form Tesseract itself takes. Names come from Intl.DisplayNames in the
// page's language, so no dictionary needs a string per language.

// Tesseract code → BCP 47 tag, plus the model's variant where the tag alone
// doesn't say it: vertical CJK, historical spelling, Fraktur type.
export type OcrVariant = "vert" | "old" | "fraktur";
const TAGS: Record<string, string> = {
  afr: "af", amh: "am", ara: "ar", asm: "as", aze: "az", aze_cyrl: "az-Cyrl", bel: "be", ben: "bn", bod: "bo",
  bos: "bs", bre: "br", bul: "bg", cat: "ca", ceb: "ceb", ces: "cs", chi_sim: "zh-Hans", chi_sim_vert: "zh-Hans",
  chi_tra: "zh-Hant", chi_tra_vert: "zh-Hant", chr: "chr", cos: "co", cym: "cy", dan: "da", deu: "de", div: "dv",
  dzo: "dz", ell: "el", eng: "en", enm: "enm", epo: "eo", est: "et", eus: "eu", fao: "fo", fas: "fa", fil: "fil",
  fin: "fi", fra: "fr", frk: "de", frm: "frm", fry: "fy", gla: "gd", gle: "ga", glg: "gl", grc: "grc", guj: "gu",
  hat: "ht", heb: "he", hin: "hi", hrv: "hr", hun: "hu", hye: "hy", iku: "iu", ind: "id", isl: "is", ita: "it",
  ita_old: "it", jav: "jv", jpn: "ja", jpn_vert: "ja", kan: "kn", kat: "ka", kat_old: "ka", kaz: "kk", khm: "km",
  kir: "ky", kmr: "kmr", kor: "ko", kor_vert: "ko", lao: "lo", lat: "la", lav: "lv", lit: "lt", ltz: "lb", mal: "ml",
  mar: "mr", mkd: "mk", mlt: "mt", mon: "mn", mri: "mi", msa: "ms", mya: "my", nep: "ne", nld: "nl", nor: "no",
  oci: "oc", ori: "or", pan: "pa", pol: "pl", por: "pt", pus: "ps", que: "qu", ron: "ro", rus: "ru", san: "sa",
  sin: "si", slk: "sk", slv: "sl", snd: "sd", spa: "es", spa_old: "es", sqi: "sq", srp: "sr-Cyrl", srp_latn: "sr-Latn",
  sun: "su", swa: "sw", swe: "sv", syr: "syr", tam: "ta", tat: "tt", tel: "te", tgk: "tg", tha: "th", tir: "ti",
  ton: "to", tur: "tr", uig: "ug", ukr: "uk", urd: "ur", uzb: "uz-Latn", uzb_cyrl: "uz-Cyrl", vie: "vi", yid: "yi",
  yor: "yo",
};

// English names, for a browser whose Intl data lacks a language (Chrome 155
// has no name for Tibetan, Dzongkha, Inuktitut, Syriac, Ancient Greek, Middle
// English or Middle French).
const ENGLISH: Record<string, string> = {
  "af": "Afrikaans", "am": "Amharic", "ar": "Arabic", "as": "Assamese", "az": "Azerbaijani",
  "az-Cyrl": "Azerbaijani (Cyrillic)", "be": "Belarusian", "bn": "Bangla", "bo": "Tibetan", "bs": "Bosnian",
  "br": "Breton", "bg": "Bulgarian", "ca": "Catalan", "ceb": "Cebuano", "cs": "Czech",
  "zh-Hans": "Simplified Chinese", "zh-Hant": "Traditional Chinese", "chr": "Cherokee", "co": "Corsican",
  "cy": "Welsh", "da": "Danish", "de": "German", "dv": "Divehi", "dz": "Dzongkha", "el": "Greek", "en": "English",
  "enm": "Middle English", "eo": "Esperanto", "et": "Estonian", "eu": "Basque", "fo": "Faroese", "fa": "Persian",
  "fil": "Filipino", "fi": "Finnish", "fr": "French", "frm": "Middle French", "fy": "Western Frisian",
  "gd": "Scottish Gaelic", "ga": "Irish", "gl": "Galician", "grc": "Ancient Greek", "gu": "Gujarati",
  "ht": "Haitian Creole", "he": "Hebrew", "hi": "Hindi", "hr": "Croatian", "hu": "Hungarian", "hy": "Armenian",
  "iu": "Inuktitut", "id": "Indonesian", "is": "Icelandic", "it": "Italian", "jv": "Javanese", "ja": "Japanese",
  "kn": "Kannada", "ka": "Georgian", "kk": "Kazakh", "km": "Khmer", "ky": "Kyrgyz", "kmr": "Kurdish", "ko": "Korean",
  "lo": "Lao", "la": "Latin", "lv": "Latvian", "lt": "Lithuanian", "lb": "Luxembourgish", "ml": "Malayalam",
  "mr": "Marathi", "mk": "Macedonian", "mt": "Maltese", "mn": "Mongolian", "mi": "Māori", "ms": "Malay",
  "my": "Burmese", "ne": "Nepali", "nl": "Dutch", "no": "Norwegian", "oc": "Occitan", "or": "Odia", "pa": "Punjabi",
  "pl": "Polish", "pt": "Portuguese", "ps": "Pashto", "qu": "Quechua", "ro": "Romanian", "ru": "Russian",
  "sa": "Sanskrit", "si": "Sinhala", "sk": "Slovak", "sl": "Slovenian", "sd": "Sindhi", "es": "Spanish",
  "sq": "Albanian", "sr-Cyrl": "Serbian (Cyrillic)", "sr-Latn": "Serbian (Latin)", "su": "Sundanese",
  "sw": "Swahili", "sv": "Swedish", "syr": "Syriac", "ta": "Tamil", "tt": "Tatar", "te": "Telugu", "tg": "Tajik",
  "th": "Thai", "ti": "Tigrinya", "to": "Tongan", "tr": "Turkish", "ug": "Uyghur", "uk": "Ukrainian", "ur": "Urdu",
  "uz-Latn": "Uzbek (Latin)", "uz-Cyrl": "Uzbek (Cyrillic)", "vi": "Vietnamese", "yi": "Yiddish", "yo": "Yoruba",
};

export function ocrVariant(code: string): OcrVariant | undefined {
  if (code.endsWith("_vert")) return "vert";
  if (code.endsWith("_old")) return "old";
  if (code === "frk") return "fraktur";
  return undefined;
}

// Each language read at once costs a model download and time on every page.
export const MAX_OCR_LANGS = 3;

// The languages in an option value: known ones, each once, at most MAX_OCR_LANGS,
// and English when none is left.
export function ocrLangs(value: unknown, known: readonly string[]): string[] {
  const out: string[] = [];
  for (const code of String(value ?? "").split("+")) {
    if (known.includes(code) && !out.includes(code) && out.length < MAX_OCR_LANGS) out.push(code);
  }
  return out.length ? out : ["eng"];
}

const namers = new Map<string, Intl.DisplayNames | null>();
function namer(locale: string) {
  if (!namers.has(locale)) {
    try {
      namers.set(locale, new Intl.DisplayNames([locale], { type: "language", fallback: "none" }));
    } catch {
      namers.set(locale, null);
    }
  }
  return namers.get(locale) ?? null;
}

// The language's name in `locale`, and in itself ("Hindi", "हिन्दी"). The
// variant, if any, is for the caller to add in words.
// `tag` is the language's BCP 47 tag, for lang attributes.
export function ocrLangName(code: string, locale: string): { name: string; native: string; tag?: string; variant?: OcrVariant } {
  const tag = TAGS[code];
  const name = (tag && (namer(locale)?.of(tag) ?? ENGLISH[tag])) || code;
  const native = (tag && namer(tag)?.of(tag)) || name;
  return { name, native, tag, variant: ocrVariant(code) };
}

// The viewer's last choice, for the next document. Storage can be blocked.
const KEY = "ocrLang";
export function rememberedOcrLang(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
export function rememberOcrLang(value: string) {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* storage blocked */
  }
}
