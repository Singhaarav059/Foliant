import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { ToolGrid } from "@/components/ToolGrid";
import { Comparison } from "@/components/Comparison";
import { PaperStack, Words } from "@/components/Motion";
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

  const formats = [...new Set(TOOLS.flatMap((x) => x.accept).filter((e) => e !== "jpeg"))].map((e) => e.toUpperCase());

  return (
    <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <section className="grid items-center gap-12 pb-16 pt-14 sm:pt-20 lg:grid-cols-[1.35fr_1fr] lg:gap-6 lg:pb-24 lg:pt-24">
        <div>
          <p className="fade-up eyebrow flex items-center gap-2" style={{ "--d": "0ms" } as React.CSSProperties}>
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60 [animation-duration:2.4s]" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            <span className="tabular">{local}/{TOOLS.length}</span>
            <span className="text-line-strong">·</span>
            {t["home.privateBadge"]}
          </p>
          <h1 className="display mt-6 max-w-[13ch] text-[3.3rem] sm:text-[5rem] lg:text-[6.4rem]">
            <Words text={t["home.title"]} />
          </h1>
          <p className="fade-up mt-7 max-w-[520px] text-pretty text-[17px] leading-[1.6] text-ink-2 sm:text-[18px]" style={{ "--d": "500ms" } as React.CSSProperties}>
            {t["home.subtitle"]}
          </p>
          <div data-promise className="fade-up mt-9 max-w-[680px]" style={{ "--d": "650ms" } as React.CSSProperties}>
            <h2 className="sr-only">{t["home.promiseLabel"]}</h2>
            <ul className="grid gap-x-8 gap-y-2.5 text-[15px] text-ink-2 sm:grid-cols-2">
              {(["home.promise1", "home.promise2", STATIC ? "home.promise3" : "home.promise3Server", "home.promise4"] as const).map((k) => (
                <li key={k} className="flex items-start gap-2.5">
                  <Check size={15} strokeWidth={2.25} className="mt-1 shrink-0 text-accent" aria-hidden />
                  {t[k]}
                </li>
              ))}
            </ul>
            <Link href={`/${lang}/security#check`} className="link-u mt-4 inline-block text-[14px] text-muted transition-colors hover:text-ink">
              {t["home.promiseCheck"]} →
            </Link>
          </div>
        </div>
        <div className="fade-up hidden py-10 sm:block" style={{ "--d": "350ms" } as React.CSSProperties}>
          <PaperStack />
        </div>
      </section>

      <div className="marquee -mx-4 mb-14 overflow-hidden border-y border-line py-4 sm:-mx-6" aria-hidden>
        <div>
          {[0, 1].map((n) => (
            <span key={n} className="flex shrink-0">
              {formats.map((f) => (
                <span key={f} className="flex items-center gap-8 pe-8 serif text-[1.75rem] leading-none text-ink-2">
                  {f}
                  <span className="h-1 w-1 rounded-full bg-accent" />
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      <ToolGrid />

      <section className="relative mt-24 overflow-hidden rounded-[28px] border border-line bg-surface px-6 py-14 sm:px-12 sm:py-20">
        <div aria-hidden className="pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
        <p className="reveal eyebrow">{t["nav.workflows"]}</p>
        <div className="mt-5 grid gap-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="min-w-0">
            <h2 className="reveal display max-w-[18ch] text-[2.4rem] sm:text-[3.4rem]">{t["home.workflowsTitle"]}</h2>
            <p className="reveal mt-5 max-w-[480px] text-pretty text-[16px] leading-relaxed text-muted">{t["home.workflowsBody"]}</p>
            <ol className="mt-10 flex min-w-0 flex-wrap items-center gap-x-0 gap-y-3" aria-label={t["nav.workflows"]}>
              {chain.map((tool, i) => (
                <li key={tool.id} className="reveal flex items-center" style={{ animationRangeEnd: `entry ${55 + i * 12}%` }}>
                  <span className="flex items-center gap-2.5 rounded-full border border-line bg-bg py-1.5 pe-4 ps-1.5 text-[14px] font-medium shadow-card">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-ink font-mono text-[11px] text-bg">{i + 1}</span>
                    {t[`tool.${tool.id}.name` as keyof typeof t]}
                  </span>
                  {i < chain.length - 1 && <span aria-hidden className="reveal-line mx-1.5 block h-px w-6 bg-line-strong sm:w-10" />}
                </li>
              ))}
            </ol>
          </div>
          <Link href={`/${lang}/workflows`} className="btn btn-primary btn-lg max-w-full justify-self-start whitespace-normal">
            {t["home.workflowsCta"]} <ArrowRight size={16} className="rtl:rotate-180" />
          </Link>
        </div>
      </section>

      <section className="mt-24">
        <h2 className="reveal eyebrow">{t["home.whyTitle"]}</h2>
        <dl className="mt-8 grid gap-px overflow-hidden rounded-[20px] border border-line bg-line md:grid-cols-3">
          {([
            ["home.why1Title", STATIC ? "home.why1BodyLocal" : "home.why1Body"],
            ["home.why2Title", "home.why2Body"],
            ["home.why3Title", "home.why3Body"],
          ] as const).map(([title, body], i) => (
            <div key={title} className="spot reveal bg-surface p-7 sm:p-9">
              <span className="serif text-[3.5rem] leading-none text-accent">{["i", "ii", "iii"][i]}.</span>
              <dt className="mt-6 text-[17px] font-medium tracking-[-0.01em]">{t[title]}</dt>
              <dd className="mt-2 max-w-[38ch] text-pretty text-[15px] leading-relaxed text-muted">{t[body]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Comparison t={t} lang={lang} />
    </div>
  );
}
