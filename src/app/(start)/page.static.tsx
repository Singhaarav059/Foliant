import { DEFAULT_LOCALE, LOCALE_CODES, LOCALES } from "@/lib/i18n/locales";

// Static hosts can't read Accept-Language, so the language is picked in the
// browser: the one used last, else the browser's, as the server proxy does.
// The build also copies this page to 404.html, so links without a language
// prefix still arrive.
function pick(codes: readonly string[], fallback: string) {
  const has = (c: string) => codes.includes(c);
  const path = location.pathname;
  if (has(path.split("/")[1]?.toLowerCase() ?? "")) return; // a missing page inside a language
  let lang = "";
  try {
    lang = localStorage.getItem("locale") ?? "";
  } catch {
    /* storage blocked */
  }
  if (!has(lang)) {
    lang = fallback;
    for (const raw of navigator.languages ?? [navigator.language]) {
      const tag = raw.toLowerCase();
      if (has(tag)) { lang = tag; break; }
      if (tag.startsWith("zh")) { lang = /tw|hk|hant/.test(tag) ? "zh-tw" : "zh-cn"; break; }
      const base = tag.split("-")[0];
      if (has(base)) { lang = base; break; }
    }
  }
  location.replace(`/${lang}${path === "/" ? "" : path}${location.search}${location.hash}`);
}

const script = `(${pick.toString()})(${JSON.stringify(LOCALE_CODES)}, ${JSON.stringify(DEFAULT_LOCALE)})`;

export default function Start() {
  return (
    <main style={{ maxWidth: 520, margin: "0 auto", padding: "64px 16px" }}>
      <script dangerouslySetInnerHTML={{ __html: script }} />
      <ul style={{ listStyle: "none", padding: 0, columns: 2 }}>
        {LOCALES.map((l) => (
          <li key={l.code} style={{ padding: "4px 0" }}>
            <a href={`/${l.code}`} lang={l.code} style={{ color: "#191917" }}>{l.name}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
