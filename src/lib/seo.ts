// What search engines and link previews see: every page's address, its
// translations and its social card, the sitemap and robots.txt.
import type { Metadata } from "next";
import { BRAND, SITE_URL } from "./brand";
import { DEFAULT_LOCALE, LOCALE_CODES, type Locale } from "./i18n/locales";
import { STATIC } from "./mode";
import { TOOLS } from "./tools";

// Pages under /{lang}/{slug} that aren't tools.
export const INFO = ["features", "faq", "security", "about", "guide", "privacy", "terms", "cookies", "licenses"] as const;
export type Info = (typeof INFO)[number];

// Every page, as the path after /{lang}. Each exists in every language.
export const PAGES = ["", "/workflows", ...TOOLS.map((t) => `/${t.slug}`), ...INFO.map((s) => `/${s}`)];

// The same page in every language, plus x-default for everyone else: English
// for a page, the language picker at "/" for the home page. Paths are
// relative; metadataBase (SITE_URL, set in the layouts) makes them absolute.
export function languages(path: string): Record<string, string> {
  return {
    ...Object.fromEntries(LOCALE_CODES.map((l) => [l, `/${l}${path}`])),
    "x-default": path ? `/${DEFAULT_LOCALE}${path}` : "/",
  };
}

// Social cards are drawn at build time by src/app/og: one per tool, named by
// its slug, and "home" for every other page. All languages share them.
export const OG_SIZE = { width: 1200, height: 630 };

type Page = { lang?: Locale; path?: string; title: string; description: string; image?: string };

// Canonical address, translations and social card of one page. Without a
// language it describes "/".
export function pageMetadata({ lang, path = "", title, description, image = "home" }: Page): Metadata {
  const url = lang ? `/${lang}${path}` : "/";
  const images = [{ url: `/og/${image}.png`, ...OG_SIZE }];
  return {
    alternates: { canonical: url, languages: languages(path) },
    openGraph: { type: "website", siteName: BRAND.name, url, title, description, images },
    twitter: { card: "summary_large_image", title, description, images },
  };
}

// sitemap.xml: every page in every language, each listing its translations,
// plus, in the static build, the language picker at "/". The server answers
// "/" with a redirect to a language, so there it is only the x-default.
export function sitemapXml() {
  const abs = (path: string) => `${SITE_URL}${path}`;
  const entry = (path: string, url: string) =>
    `<url><loc>${abs(url)}</loc>${Object.entries(languages(path))
      .map(([l, p]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${abs(p)}"/>`)
      .join("")}</url>`;
  const urls = [...(STATIC ? [entry("", "/")] : []), ...PAGES.flatMap((path) => LOCALE_CODES.map((l) => entry(path, `/${l}${path}`)))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
}

export const robotsTxt = () => `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
