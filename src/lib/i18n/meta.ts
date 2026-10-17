import type { Metadata } from "next";
import { getDictionary, type DictKey } from "./dictionary";
import { hasLocale } from "./locales";
import { pageMetadata } from "../seo";

// generateMetadata for simple pages whose title is one dictionary key. Given
// a page (its path after /{lang} and a description key), it also sets the
// canonical address, translations and social card.
export function titleFrom(key: DictKey, page?: { path: string; description: DictKey }) {
  return async ({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> => {
    const { lang } = await params;
    if (!hasLocale(lang)) return {};
    const t = await getDictionary(lang);
    if (!page) return { title: t[key] };
    const description = t[page.description];
    return { title: t[key], description, ...pageMetadata({ lang, path: page.path, title: t[key], description }) };
  };
}
