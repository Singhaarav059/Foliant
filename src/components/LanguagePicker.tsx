import { DEFAULT_LOCALE, LOCALE_CODES, LOCALES } from "@/lib/i18n/locales";

// Static build only: the language picker, at "/" and as the site-wide 404
// page (src/app/global-not-found.static.tsx), so links without a language
// prefix still arrive. Static hosts can't read Accept-Language, so the
// language is picked in the browser: the one used last, else the browser's,
// as the server proxy does.
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

// Outside the [lang] layout, these pages bring their own document.
export function PickerDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, font: "16px/1.5 system-ui, sans-serif", background: "#f7f7f5", color: "#191917" }}>{children}</body>
    </html>
  );
}

export function LanguagePicker() {
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
