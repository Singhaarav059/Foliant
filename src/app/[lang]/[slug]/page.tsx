import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck, Server, ArrowRight } from "lucide-react";
import { Workspace } from "@/components/workspace/Workspace";
import { ToolIcon } from "@/components/ToolIcon";
import { getDictionary, format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import { hasLocale, LOCALE_CODES } from "@/lib/i18n/locales";
import { CATEGORIES, LIMITS, TOOLS, toolBySlug, type Tool } from "@/lib/tools";
import { LEGAL, LEGAL_UPDATED } from "@/lib/legal";
import { BRAND } from "@/lib/brand";

const INFO = ["features", "faq", "security", "about", "guide", "privacy", "terms", "cookies"] as const;
type Info = (typeof INFO)[number];

export function generateStaticParams() {
  const slugs = [...TOOLS.map((t) => t.slug), ...INFO];
  return LOCALE_CODES.flatMap((lang) => slugs.map((slug) => ({ lang, slug })));
}

function infoTitle(slug: Info, t: Dict) {
  if (slug === "privacy" || slug === "terms" || slug === "cookies") return LEGAL[slug].title;
  const key = { features: "feat.title", faq: "faq.title", security: "sec.title", about: "about.title", guide: "guide.title" }[slug] as DictKey;
  return t[key];
}

export async function generateMetadata({ params }: PageProps<"/[lang]/[slug]">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!hasLocale(lang)) return {};
  const t = await getDictionary(lang);
  const tool = toolBySlug(slug);
  if (tool) return { title: t[`tool.${tool.id}.name` as DictKey], description: t[`tool.${tool.id}.desc` as DictKey] };
  if ((INFO as readonly string[]).includes(slug)) return { title: infoTitle(slug as Info, t) };
  return {};
}

// Params are read inside a Suspense boundary so navigations between tools
// can show the shared shell instantly while the page content resolves.
export default function SlugPage({ params }: PageProps<"/[lang]/[slug]">) {
  return (
    <Suspense fallback={<div className="min-h-[70vh]" />}>
      <SlugContent params={params} />
    </Suspense>
  );
}

async function SlugContent({ params }: { params: PageProps<"/[lang]/[slug]">["params"] }) {
  const { lang, slug } = await params;
  if (!hasLocale(lang)) notFound();
  const t = await getDictionary(lang);
  const tool = toolBySlug(slug);
  if (tool) return <ToolPage tool={tool} t={t} lang={lang} />;
  if ((INFO as readonly string[]).includes(slug)) return <InfoPage slug={slug as Info} t={t} lang={lang} />;
  notFound();
}

function ToolPage({ tool, t, lang }: { tool: Tool; t: Dict; lang: string }) {
  const k = (s: string) => t[s as DictKey];
  const related = TOOLS.filter((x) => x.category === tool.category && x.id !== tool.id).slice(0, 4);
  const Badge = tool.runtime === "browser" ? ShieldCheck : Server;
  return (
    <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <header className="flex flex-col items-center pb-8 pt-10 text-center sm:pt-14">
        <ToolIcon tool={tool} size={56} />
        <h1 className="mt-4 text-[2rem] font-bold leading-tight tracking-[-0.03em] sm:text-[2.6rem]">{k(`tool.${tool.id}.name`)}</h1>
        <p className="mt-2 max-w-[560px] text-pretty text-[17px] text-muted">{k(`tool.${tool.id}.desc`)}</p>
        <p className="mt-3 flex items-center gap-1.5 text-[13px] text-muted">
          <Badge size={14} />
          {tool.runtime === "browser" ? t["home.privateBadge"] : t["home.serverBadge"]}
        </p>
      </header>

      <Workspace toolId={tool.id} />

      <section className="mx-auto mt-24 max-w-[960px]">
        <ol className="grid gap-4 sm:grid-cols-3">
          {(["guide.step1", "guide.step2", "guide.step3"] as const).map((s, i) => (
            <li key={s} className="flex items-start gap-3">
              <span className="tabular grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[14px] font-semibold">{i + 1}</span>
              <span className="pt-1 text-[15px] text-ink-2">{t[s]}</span>
            </li>
          ))}
        </ol>
        {related.length > 0 && (
          <div className="mt-14">
            <h2 className="mb-4 text-[13px] font-semibold text-muted">{t[`cat.${tool.category}` as DictKey]}</h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((r) => (
                <li key={r.id}>
                  <Link href={`/${lang}/${r.slug}`} className="card flex items-center gap-3 p-4 hover:border-line-strong">
                    <ToolIcon tool={r} size={36} />
                    <span className="text-[15px] font-medium">{k(`tool.${r.id}.name`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function InfoPage({ slug, t, lang }: { slug: Info; t: Dict; lang: string }) {
  const k = (s: string, vars?: Record<string, string | number>) => format(t[s as DictKey] ?? s, vars);
  const wrap = (title: string, body: React.ReactNode, subtitle?: string) => (
    <div className="mx-auto max-w-[860px] px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
      <h1 className="text-[2.2rem] font-bold leading-tight tracking-[-0.03em]">{title}</h1>
      {subtitle && <p className="mt-2 text-[17px] text-muted">{subtitle}</p>}
      <div className="mt-10">{body}</div>
    </div>
  );

  if (slug === "features") {
    return wrap(t["feat.title"], (
      <div className="grid gap-4 sm:grid-cols-2">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <div key={n} className="card p-6 sm:last:col-span-2">
            <h2 className="text-[17px] font-semibold">{k(`feat.f${n}t`)}</h2>
            <p className="mt-1.5 text-[15px] text-muted">{k(`feat.f${n}b`)}</p>
          </div>
        ))}
      </div>
    ), t["feat.subtitle"]);
  }
  if (slug === "faq") {
    return wrap(t["faq.title"], (
      <div className="divide-y divide-line rounded-2xl border border-line bg-surface">
        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
          <details key={n} className="group p-5 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-semibold">
              {k(`faq.q${n}`)}
              <span className="text-muted transition-transform group-open:rotate-45" aria-hidden>+</span>
            </summary>
            <p className="mt-3 text-[15px] text-ink-2">{k(`faq.a${n}`, { mb: LIMITS.mb })}</p>
          </details>
        ))}
      </div>
    ));
  }
  if (slug === "security") {
    return wrap(t["sec.title"], (
      <div className="space-y-8">
        {[1, 2, 3, 4].map((n) => (
          <section key={n}>
            <h2 className="text-[18px] font-semibold">{k(`sec.h${n}`)}</h2>
            <p className="mt-2 text-[16px] leading-relaxed text-ink-2">{k(`sec.b${n}`)}</p>
          </section>
        ))}
      </div>
    ), t["sec.subtitle"]);
  }
  if (slug === "about") {
    return wrap(t["about.title"], (
      <div className="space-y-4 text-[17px] leading-relaxed text-ink-2">
        {[1, 2, 3].map((n) => <p key={n}>{k(`about.b${n}`, { brand: BRAND.name })}</p>)}
        <Link href={`/${lang}/contact`} className="btn btn-quiet mt-4">{t["foot.contact"]}</Link>
      </div>
    ));
  }
  if (slug === "guide") {
    return wrap(t["guide.title"], (
      <div className="space-y-10">
        {CATEGORIES.map((c) => (
          <section key={c.id}>
            <h2 className="mb-3 text-[13px] font-semibold" style={{ color: c.color }}>{k(`cat.${c.id}`)}</h2>
            <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
              {TOOLS.filter((x) => x.category === c.id).map((tool) => (
                <li key={tool.id} className="flex items-center gap-4 p-4">
                  <ToolIcon tool={tool} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{k(`tool.${tool.id}.name`)}</p>
                    <p className="text-[15px] text-muted">{k(`tool.${tool.id}.desc`)}</p>
                  </div>
                  <Link href={`/${lang}/${tool.slug}`} className="btn btn-quiet btn-sm hidden sm:inline-flex">
                    {t["guide.open"]} <ArrowRight size={15} className="rtl:rotate-180" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    ), t["guide.subtitle"]);
  }
  const doc = LEGAL[slug];
  return wrap(doc.title, (
    <div className="legal" lang="en">
      {lang !== "en" && <p className="mb-6 rounded-xl bg-surface-2 p-3 text-[14px]">{t["legal.englishOnly"]}</p>}
      <p className="text-[13px] text-muted">{k("legal.updated", { date: LEGAL_UPDATED })}</p>
      <p className="mt-4 text-[17px]">{doc.intro}</p>
      {doc.sections.map((s) => (
        <section key={s.h}>
          <h2>{s.h}</h2>
          {s.p.map((p) => <p key={p}>{p}</p>)}
          {s.list && <ul>{s.list.map((li) => <li key={li}>{li}</li>)}</ul>}
        </section>
      ))}
    </div>
  ));
}
