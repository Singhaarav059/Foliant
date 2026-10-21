// A landing page for one search intent (src/lib/landings.ts), such as
// "compress PDF to 100 KB": the tool with its options already set, then text
// about that job, with the same structured data a tool page has.
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { Workspace } from "@/components/workspace/Workspace";
import { format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { BRAND } from "@/lib/brand";
import { LANDINGS, type Landing } from "@/lib/landings";
import { toolById } from "@/lib/tools";
import { pageUrl, toolJsonLd } from "@/lib/seo";

// One of the intent texts (intent.{part}), with its placeholders filled.
export function landingText(t: Dict, intent: Landing, part: string) {
  return format(t[`intent.${part}` as DictKey] ?? "", { kb: intent.kb, bytes: (intent.kb * 1024).toLocaleString("en"), brand: BRAND.name });
}

export function LandingPage({ intent, t, lang }: { intent: Landing; t: Dict; lang: Locale }) {
  const tool = toolById(intent.tool);
  const x = (part: string) => landingText(t, intent, part);
  const name = x("h1");
  const steps = [1, 2, 3].map((n) => x(`step${n}`));
  const faq = [1, 2, 3, 4].map((n) => ({ q: x(`q${n}`), a: x(`a${n}`) }));
  const content = { name, description: x("meta"), howTo: format(t["tp.howTo"], { name }), steps, faq };
  const others = LANDINGS.filter((i) => i.slug !== intent.slug);
  return (
    <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <header className="mx-auto flex max-w-[760px] flex-col items-center pb-10 pt-12 text-center sm:pt-16">
        <nav aria-label="Breadcrumb" className="eyebrow flex items-center gap-2">
          <Link href={`/${lang}`} className="transition-colors hover:text-ink">{t["nav.allTools"]}</Link>
          <span aria-hidden className="text-line-strong">/</span>
          <Link href={pageUrl(lang, `/${tool.slug}`)} className="transition-colors hover:text-ink">{t[`tool.${tool.id}.name` as DictKey]}</Link>
        </nav>
        <h1 className="mt-5 text-balance text-[2.25rem] font-semibold leading-[1.05] tracking-[-0.04em] sm:text-[3rem]">{name}</h1>
        <p className="mt-3 max-w-[520px] text-pretty text-[17px] leading-relaxed text-ink-2">{x("desc")}</p>
        <p className="mt-4 flex items-center gap-1.5 text-[13px] text-muted">
          <ShieldCheck size={14} strokeWidth={1.75} className="text-success" />
          {t["home.privateBadge"]}
        </p>
      </header>

      <Workspace toolId={tool.id} preset={intent.preset} />

      <section className="mx-auto mt-28 max-w-[960px]">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: toolJsonLd({ lang, slug: intent.slug, home: t["nav.allTools"], content }) }} />
        <h2 className="mb-4 text-[20px] font-semibold tracking-[-0.02em]">{content.howTo}</h2>
        <ol className="grid border-y border-line sm:grid-cols-3">
          {steps.map((s, i) => (
            <li key={i} className="flex flex-col gap-2 border-line py-6 not-first:border-t sm:px-6 sm:not-first:border-s sm:not-first:border-t-0 sm:first:ps-0">
              <span className="eyebrow">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-pretty text-[15px] leading-relaxed text-ink-2">{s}</span>
            </li>
          ))}
        </ol>

        <div className="mt-14 grid gap-10 md:grid-cols-[3fr_2fr]">
          <section>
            <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{format(t["tp.about"], { name })}</h2>
            <p className="mt-3 max-w-[64ch] text-pretty text-[16px] leading-relaxed text-ink-2">{x("intro")}</p>
            <p className="mt-3 max-w-[64ch] text-pretty text-[16px] leading-relaxed text-ink-2">{x(String(intent.kb))}</p>
          </section>
          <section className="card self-start p-5">
            <h2 className="flex items-center gap-2 text-[16px] font-medium tracking-[-0.01em]">
              <ShieldCheck size={16} strokeWidth={1.75} className="text-success" aria-hidden />
              {t["tp.private"]}
            </h2>
            <p className="mt-2 text-pretty text-[15px] leading-relaxed text-ink-2">{format(t[`tool.${tool.id}.private` as DictKey], { brand: BRAND.name })}</p>
          </section>
        </div>

        <section className="mt-14">
          <h2 className="text-[20px] font-semibold tracking-[-0.02em]">{format(t["tp.faq"], { name })}</h2>
          <dl className="mt-4 divide-y divide-line border-y border-line">
            {faq.map(({ q, a }) => (
              <div key={q} className="py-5">
                <dt className="text-[16px] font-medium tracking-[-0.01em]">{q}</dt>
                <dd className="mt-2 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">{a}</dd>
              </div>
            ))}
          </dl>
        </section>

        <ul className="mt-14 grid gap-2 sm:grid-cols-3">
          {[...others.map((i) => ({ href: `/${lang}/${i.slug}`, label: landingText(t, i, "h1") })), { href: pageUrl(lang, `/${tool.slug}`), label: t[`tool.${tool.id}.name` as DictKey] }].map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="group card flex items-center gap-3 p-3 transition-colors hover:border-line-strong">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{l.label}</span>
                <ArrowRight size={14} className="text-muted opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
