import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { ToolGrid } from "@/components/ToolGrid";
import { getDictionary } from "@/lib/i18n/dictionary";
import { hasLocale } from "@/lib/i18n/locales";
import { TOOLS } from "@/lib/tools";
import { STATIC } from "@/lib/mode";
import { BRAND } from "@/lib/brand";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({ params }: PageProps<"/[lang]">): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const t = await getDictionary(lang);
  return pageMetadata({ lang, title: `${BRAND.name}: ${t["home.title"]}`, description: t["home.subtitle"] });
}

export default async function Home({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const t = await getDictionary(lang);
  const chain = ["merge", "compress", "pageNumbers", "protect"].map((id) => TOOLS.find((x) => x.id === id)!);
  const local = TOOLS.filter((x) => x.runtime === "browser").length;

  return (
    <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <section className="pb-12 pt-16 sm:pb-16 sm:pt-24">
        <p className="eyebrow flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
          <span className="tabular">{local}/{TOOLS.length}</span>
          <span className="text-line-strong">·</span>
          {t["home.privateBadge"]}
        </p>
        <h1 className="mt-5 max-w-[14ch] text-balance text-[2.6rem] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[4rem] lg:text-[4.75rem]">
          {t["home.title"]}
        </h1>
        <p className="mt-6 max-w-[560px] text-pretty text-[17px] leading-[1.6] text-ink-2 sm:text-[18px]">{t["home.subtitle"]}</p>
      </section>

      <ToolGrid />

      <section className="mt-16 grid gap-10 border-t border-line pt-12 lg:grid-cols-[200px_1fr] lg:gap-x-12">
        <p className="eyebrow">{t["nav.workflows"]}</p>
        <div className="grid gap-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="min-w-0">
            <h2 className="max-w-[20ch] text-balance text-[1.75rem] font-semibold leading-[1.15] tracking-[-0.03em] sm:text-[2.1rem]">
              {t["home.workflowsTitle"]}
            </h2>
            <p className="mt-3 max-w-[480px] text-pretty text-[16px] leading-relaxed text-muted">{t["home.workflowsBody"]}</p>
            <ol className="mt-7 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2" aria-label={t["nav.workflows"]}>
              {chain.map((tool, i) => (
                <li key={tool.id} className="flex items-center gap-2">
                  <span className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[14px] font-medium">
                    <span className="eyebrow me-2">{i + 1}</span>
                    {t[`tool.${tool.id}.name` as keyof typeof t]}
                  </span>
                  {i < chain.length - 1 && <ArrowRight size={14} className="text-line-strong rtl:rotate-180" aria-hidden />}
                </li>
              ))}
            </ol>
          </div>
          <Link href={`/${lang}/workflows`} className="btn btn-primary max-w-full justify-self-start whitespace-normal">
            {t["home.workflowsCta"]} <ArrowRight size={16} className="rtl:rotate-180" />
          </Link>
        </div>
      </section>

      <section className="mt-16 grid gap-10 border-t border-line pt-12 lg:grid-cols-[200px_1fr] lg:gap-x-12">
        <h2 className="eyebrow">{t["home.whyTitle"]}</h2>
        <dl className="grid gap-x-10 gap-y-8 md:grid-cols-3">
          {([
            ["home.why1Title", STATIC ? "home.why1BodyLocal" : "home.why1Body"],
            ["home.why2Title", "home.why2Body"],
            ["home.why3Title", "home.why3Body"],
          ] as const).map(([title, body]) => (
            <div key={title}>
              <dt className="text-[16px] font-medium tracking-[-0.01em]">{t[title]}</dt>
              <dd className="mt-2 max-w-[38ch] text-pretty text-[15px] leading-relaxed text-muted">{t[body]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
