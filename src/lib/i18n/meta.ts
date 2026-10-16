import type { Metadata } from "next";
import { getDictionary, type DictKey } from "./dictionary";
import { hasLocale } from "./locales";

// generateMetadata for simple pages whose title is one dictionary key.
export function titleFrom(key: DictKey) {
  return async ({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> => {
    const { lang } = await params;
    if (!hasLocale(lang)) return {};
    return { title: (await getDictionary(lang))[key] };
  };
}
