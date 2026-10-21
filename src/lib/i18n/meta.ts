import type { Metadata } from "next";
import { getDictionary, type Dict, type DictKey } from "./dictionary";
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

// Texts only server-rendered pages use: each tool page's long-form content
// (src/components/ToolContent.tsx) and the landing pages' (LandingPage.tsx). Left out of the dictionary the browser
// receives, which every page carries, so they don't weigh on every page.
const SERVER_ONLY = /^(tp\.|intent\.|tool\.[^.]+\.(title|meta|intro|private|step\d+|q\d+|a\d+)$)/;

export function clientDict(dict: Dict): Dict {
  return Object.fromEntries(Object.entries(dict).filter(([k]) => !SERVER_ONLY.test(k))) as Dict;
}
