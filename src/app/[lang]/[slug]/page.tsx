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
import { REPO_URL, STATIC } from "@/lib/mode";

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
      <header className="mx-auto flex max-w-[760px] flex-col items-center pb-10 pt-12 text-center sm:pt-16">
        <nav aria-label="Breadcrumb" className="eyebrow flex items-center gap-2">
          <Link href={`/${lang}`} className="transition-colors hover:text-ink">{t["nav.allTools"]}</Link>
          <span aria-hidden className="text-line-strong">/</span>
          <span>{k(`cat.${tool.category}`)}</span>
        </nav>
        <h1 className="mt-5 text-balance text-[2.25rem] font-semibold leading-[1.05] tracking-[-0.04em] sm:text-[3rem]">{k(`tool.${tool.id}.name`)}</h1>
        <p className="mt-3 max-w-[520px] text-pretty text-[17px] leading-relaxed text-ink-2">{k(`tool.${tool.id}.desc`)}</p>
        <p className="mt-4 flex items-center gap-1.5 text-[13px] text-muted">
          <Badge size={14} strokeWidth={1.75} className={tool.runtime === "browser" ? "text-success" : ""} />
          {tool.runtime === "browser" ? t["home.privateBadge"] : t["home.serverBadge"]}
        </p>
      </header>

      <Workspace toolId={tool.id} />

      <section className="mx-auto mt-28 max-w-[960px]">
        <ol className="grid border-y border-line sm:grid-cols-3">
          {(["guide.step1", "guide.step2", "guide.step3"] as const).map((s, i) => (
            <li key={s} className="flex flex-col gap-2 border-line py-6 not-first:border-t sm:px-6 sm:not-first:border-s sm:not-first:border-t-0 sm:first:ps-0">
              <span className="eyebrow">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-[15px] text-ink-2">{t[s]}</span>
            </li>
          ))}
        </ol>
        {related.length > 0 && (
          <div className="mt-14">
            <h2 className="eyebrow mb-3">{t[`cat.${tool.category}` as DictKey]}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((r) => (
                <li key={r.id}>
                  <Link href={`/${lang}/${r.slug}`} className="group card flex items-center gap-3 p-3 transition-colors hover:border-line-strong">
                    <ToolIcon tool={r} size={32} />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{k(`tool.${r.id}.name`)}</span>
                    <ArrowRight size={14} className="text-muted opacity-0 transition-opacity group-hover:opacity-100 rtl:rotate-180" />
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
      <h1 className="text-balance text-[2.4rem] font-semibold leading-[1.05] tracking-[-0.04em] sm:text-[3rem]">{title}</h1>
      {subtitle && <p className="mt-4 max-w-[560px] text-pretty text-[17px] leading-relaxed text-ink-2">{subtitle}</p>}
      <div className="mt-12">{body}</div>
    </div>
  );

  if (slug === "features") {
    return wrap(t["feat.title"], (
      <div className="grid gap-x-10 sm:grid-cols-2">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <div key={n} className="border-t border-line py-6">
            <span className="eyebrow">{String(n).padStart(2, "0")}</span>
            <h2 className="mt-2 text-[16px] font-medium tracking-[-0.01em]">{k(`feat.f${n}t`)}</h2>
            <p className="mt-1.5 text-pretty text-[15px] leading-relaxed text-muted">{k(`feat.f${n}b`)}</p>
          </div>
        ))}
      </div>
    ), t["feat.subtitle"]);
  }
  if (slug === "faq") {
    return wrap(t["faq.title"], (
      <div className="divide-y divide-line border-y border-line">
        {/* The static build has no server and no accounts (questions 1 and 3). */}
        {(STATIC ? [1, 2, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7, 8]).map((n) => (
          <details key={n} className="group py-5 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-medium tracking-[-0.01em]">
              {k(`faq.q${n}`)}
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line text-muted transition-transform duration-200 group-open:rotate-45" aria-hidden>+</span>
            </summary>
            <p className="mt-3 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">{k(STATIC && n === 1 ? "faq.a1Local" : `faq.a${n}`, { mb: LIMITS.mb })}</p>
          </details>
        ))}
      </div>
    ));
  }
  if (slug === "security") {
    return wrap(t["sec.title"], (
      <div className="space-y-8">
        {/* Server processing and accounts only exist on a server. */}
        {(STATIC ? [1, 4] : [1, 2, 3, 4]).map((n) => (
          <section key={n}>
            <h2 className="text-[18px] font-medium tracking-[-0.015em]">{k(`sec.h${n}`)}</h2>
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
        {!STATIC && <Link href={`/${lang}/contact`} className="btn btn-quiet mt-4">{t["foot.contact"]}</Link>}
        {STATIC && REPO_URL && <a href={`${REPO_URL}/issues`} className="btn btn-quiet mt-4">{t["foot.contact"]}</a>}
      </div>
    ));
  }
  if (slug === "guide") {
    return wrap(t["guide.title"], (
      <div className="space-y-10">
        {CATEGORIES.map((c) => (
          <section key={c.id}>
            <h2 className="eyebrow mb-3">{k(`cat.${c.id}`)}</h2>
            <ul className="divide-y divide-line border-y border-line">
              {TOOLS.filter((x) => x.category === c.id).map((tool) => (
                <li key={tool.id} className="group flex items-center gap-4 py-4">
                  <ToolIcon tool={tool} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium tracking-[-0.01em]">{k(`tool.${tool.id}.name`)}</p>
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
      {lang !== "en" && <p className="mb-6 rounded-lg border border-line bg-surface p-3 text-[14px] text-ink-2">{t["legal.englishOnly"]}</p>}
      <p className="eyebrow">{k("legal.updated", { date: LEGAL_UPDATED })}</p>
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
