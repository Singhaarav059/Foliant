import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowDown, ArrowRight, Check } from "lucide-react";
import { ToolGrid } from "@/components/ToolGrid";
import { ToolIcon } from "@/components/ToolIcon";
import { Comparison } from "@/components/Comparison";
import { PaperStack, Words } from "@/components/Motion";
import { Bolt, Clip, CropMarks, Flourish, Padlock, PenNib, RegMark, Scissors, Squiggle, Stamp, Tape, Tray, Wash } from "@/components/Decor";
import { format, getDictionary } from "@/lib/i18n/dictionary";
import { hasLocale } from "@/lib/i18n/locales";
import { TOOLS } from "@/lib/tools";
import { STATIC } from "@/lib/mode";
import { BRAND } from "@/lib/brand";
import { pageMetadata, pageUrl } from "@/lib/seo";

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
  const popular = ["merge", "compress", "pdfToWord", "jpgToPdf", "edit", "sign", "split"].map((id) => TOOLS.find((x) => x.id === id)!);
  const chain = ["merge", "compress", "pageNumbers", "protect"].map((id) => TOOLS.find((x) => x.id === id)!);
  const local = TOOLS.filter((x) => x.runtime === "browser").length;

  const formats = [...new Set(TOOLS.flatMap((x) => x.accept).filter((e) => e !== "jpeg"))].map((e) => e.toUpperCase());

  return (
    <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <section className="relative isolate grid items-center gap-12 pb-16 pt-14 sm:pt-20 lg:grid-cols-[1.35fr_1fr] lg:gap-6 lg:pb-24 lg:pt-24">
        <Wash className="-end-40 -top-24 h-[520px] w-[520px]" />
        <Wash className="wash-amber -start-48 top-40 h-[420px] w-[420px] [animation-delay:-6s]" />
        {/* On phones the popular tools come before the promise list, within the first screen. */}
        <div className="flex flex-col">
          <p className="fade-up eyebrow flex items-center gap-2" style={{ "--d": "0ms" } as React.CSSProperties}>
            <span className="relative flex h-1.5 w-1.5" aria-hidden>
              <span className="absolute inset-0 animate-ping rounded-full bg-accent opacity-60 [animation-duration:2.4s]" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-accent" />
            </span>
            <span className="tabular">{local}/{TOOLS.length}</span>
            <span className="text-line-strong">·</span>
            {t["home.privateBadge"]}
          </p>
          <h1 className="display mt-6 max-w-[14ch] text-[2.9rem] sm:text-[4.2rem] lg:text-[5.2rem]">
            <Words text={t["home.title"]} />
          </h1>
          <Squiggle className="mt-3 w-[min(260px,60%)]" />
          <p className="fade-up mt-7 max-w-[520px] text-pretty text-[17px] leading-[1.6] text-ink-2 sm:text-[18px]" style={{ "--d": "500ms" } as React.CSSProperties}>
            {t["home.subtitle"]}
          </p>
          <div data-promise className="fade-up mt-9 max-w-[680px] max-sm:order-last" style={{ "--d": "650ms" } as React.CSSProperties}>
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
          <nav aria-label={t["home.popular"]} className="fade-up mt-8 sm:mt-10" style={{ "--d": "800ms" } as React.CSSProperties}>
            <p className="eyebrow mb-3">{t["home.popular"]}</p>
            <ul className="flex flex-wrap gap-2">
              {popular.map((tool) => (
                <li key={tool.id}>
                  <Link
                    href={pageUrl(lang, `/${tool.slug}`)}
                    className="group flex h-11 items-center gap-2 rounded-full border border-line bg-surface ps-1.5 pe-4 text-[14px] font-medium shadow-card transition-[border-color,box-shadow,translate] duration-300 ease-(--ease-out) hover:-translate-y-0.5 hover:border-line-strong hover:shadow-lift"
                  >
                    <ToolIcon tool={tool} size={32} />
                    {t[`tool.${tool.id}.name` as keyof typeof t]}
                  </Link>
                </li>
              ))}
            </ul>
            <a href="#tools" className="link-u mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-ink-2 hover:text-ink">
              {format(t["home.browseAll"], { n: TOOLS.length })} <ArrowDown size={14} aria-hidden />
            </a>
          </nav>
        </div>
        <div className="fade-up relative hidden py-10 sm:block" style={{ "--d": "350ms" } as React.CSSProperties}>
          <div className="relative mx-auto w-max">
            <CropMarks inset={-28} />
            <RegMark className="absolute -start-12 top-1/2" />
            <RegMark size={14} className="absolute -end-10 -top-8 [animation-delay:300ms]" />
            <PaperStack />
            <Clip className="absolute -top-7 start-[30%] z-10 h-16 w-7 rotate-[8deg] text-ink-2" style={{ "--d": "900ms" } as React.CSSProperties} />
            <Scissors className="absolute -bottom-6 -start-16 h-14 w-14 -rotate-12 text-muted" style={{ "--d": "1100ms" } as React.CSSProperties} />
            <Stamp className="absolute -end-14 bottom-10 h-14 w-14 rotate-12 text-accent" style={{ "--d": "1300ms" } as React.CSSProperties} />
            <PenNib className="absolute -end-6 -top-14 h-12 w-12 rotate-[24deg] text-muted" style={{ "--d": "1500ms" } as React.CSSProperties} />
          </div>
        </div>
      </section>

      <div className="marquee -mx-4 mb-14 overflow-hidden border-y border-line py-4 sm:-mx-6" aria-hidden>
        <div>
          {[0, 1].map((n) => (
            <span key={n} className="flex shrink-0">
              {formats.map((f) => (
                <span key={f} className="flex items-center gap-8 pe-8 text-[1.4rem] font-medium leading-none tracking-[-0.02em] text-ink-2">
                  {f}
                  <span className="h-1 w-1 rounded-full bg-accent" />
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      <ToolGrid />

      <section className="ruled relative mt-24 overflow-hidden rounded-[28px] border border-line bg-surface px-6 py-14 sm:px-12 sm:py-20">
        <div aria-hidden className="pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
        <Tape className="-start-5 top-5 -rotate-[32deg]" />
        <Tape className="-end-5 bottom-6 -rotate-[32deg]" />
        <p className="reveal eyebrow">{t["nav.workflows"]}</p>
        <div className="mt-5 grid gap-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="min-w-0">
            <h2 className="reveal display max-w-[18ch] text-[2rem] sm:text-[2.75rem]">{t["home.workflowsTitle"]}</h2>
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

      <Flourish className="mt-24" />

      <section className="mt-16">
        <h2 className="reveal eyebrow">{t["home.whyTitle"]}</h2>
        <dl className="mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
          {([
            ["home.why1Title", STATIC ? "home.why1BodyLocal" : "home.why1Body", Padlock],
            ["home.why2Title", "home.why2Body", Bolt],
            ["home.why3Title", "home.why3Body", Tray],
          ] as const).map(([title, body, Doodle], i) => (
            <div
              key={title}
              className={`reveal group drop-shadow-[0_10px_18px_rgb(60_44_20_/_0.10)] transition-[rotate,translate] duration-700 ease-(--ease-spring) hover:-translate-y-1 hover:rotate-0 ${["md:-rotate-[1.2deg]", "md:rotate-[0.8deg] md:translate-y-4", "md:-rotate-[0.6deg]"][i]}`}
            >
              <div className="perforated bg-surface p-3">
                <div className="fold spot relative h-full [--fold-bg:var(--surface)] border border-dashed border-line-strong p-6 sm:p-7">
                  <div className="flex items-start justify-between">
                    <span className="font-mono text-[2rem] leading-none text-accent">{String(i + 1).padStart(2, "0")}</span>
                    <Doodle className="h-11 w-11 text-ink-2" style={{ "--d": `${400 + i * 200}ms` } as React.CSSProperties} />
                  </div>
                  <dt className="mt-6 text-[17px] font-medium tracking-[-0.01em]">{t[title]}</dt>
                  <dd className="mt-2 max-w-[38ch] text-pretty text-[15px] leading-relaxed text-muted">{t[body]}</dd>
                </div>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <Flourish className="mt-28" />

      <Comparison t={t} lang={lang} />
    </div>
  );
}
