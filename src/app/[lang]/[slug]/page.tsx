import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck, Server, ArrowRight } from "lucide-react";
import { Workspace } from "@/components/workspace/Workspace";
import { ToolIcon } from "@/components/ToolIcon";
import { ToolContent, toolText } from "@/components/ToolContent";
import { getDictionary, format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import { hasLocale, LOCALE_CODES, type Locale } from "@/lib/i18n/locales";
import { CATEGORIES, LIMITS, TOOLS, descKey, toolBySlug, type Tool } from "@/lib/tools";
import { LEGAL, LEGAL_UPDATED } from "@/lib/legal";
import { BRAND, OPERATOR } from "@/lib/brand";
import { readLicenses, LICENSES_URL } from "@/lib/licenses";
import { REPO_URL, STATIC } from "@/lib/mode";
import { INFO, pageMetadata, type Info } from "@/lib/seo";

export function generateStaticParams() {
  const slugs = [...TOOLS.map((t) => t.slug), ...INFO];
  return LOCALE_CODES.flatMap((lang) => slugs.map((slug) => ({ lang, slug })));
}

function infoTitle(slug: Info, t: Dict) {
  if (slug === "privacy" || slug === "terms" || slug === "cookies") return LEGAL[slug].title;
  const key = { features: "feat.title", faq: "faq.title", security: "sec.title", about: "about.title", guide: "guide.title", licenses: "lic.title" }[slug] as DictKey;
  return t[key];
}

// A line for search results and link previews.
function infoDescription(slug: Info, t: Dict) {
  if (slug === "privacy" || slug === "terms" || slug === "cookies") return LEGAL[slug].intro;
  if (slug === "about") return format(t["about.b1"], { brand: BRAND.name });
  if (slug === "licenses") return format(t["lic.subtitle"], { brand: BRAND.name });
  const key = { features: "feat.subtitle", faq: "home.subtitle", security: "sec.subtitle", guide: "guide.subtitle" }[slug] as DictKey;
  return t[key];
}

export async function generateMetadata({ params }: PageProps<"/[lang]/[slug]">): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!hasLocale(lang)) return {};
  const t = await getDictionary(lang);
  const tool = toolBySlug(slug);
  if (tool) {
    const title = toolText(t, tool, "title");
    const description = toolText(t, tool, "meta");
    return { title, description, ...pageMetadata({ lang, path: `/${slug}`, title, description, image: tool.slug }) };
  }
  if ((INFO as readonly string[]).includes(slug)) {
    const title = infoTitle(slug as Info, t);
    const description = infoDescription(slug as Info, t);
    return { title, description, ...pageMetadata({ lang, path: `/${slug}`, title, description }) };
  }
  return {};
}

// Params are read inside a Suspense boundary so navigations between tools
// can show the shared shell instantly while the page content resolves.
// The static build has no navigations to wait for: every page is a file, so
// its content goes in the HTML as it is, readable before any script runs.
export default function SlugPage({ params }: PageProps<"/[lang]/[slug]">) {
  if (STATIC) return <SlugContent params={params} />;
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

function ToolPage({ tool, t, lang }: { tool: Tool; t: Dict; lang: Locale }) {
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
        <p className="mt-3 max-w-[520px] text-pretty text-[17px] leading-relaxed text-ink-2">{k(descKey(tool))}</p>
        <p className="mt-4 flex items-center gap-1.5 text-[13px] text-muted">
          <Badge size={14} strokeWidth={1.75} className={tool.runtime === "browser" ? "text-success" : ""} />
          {tool.runtime === "browser" ? t["home.privateBadge"] : t["home.serverBadge"]}
        </p>
      </header>

      <Workspace toolId={tool.id} />

      <section className="mx-auto mt-28 max-w-[960px]">
        <ToolContent tool={tool} t={t} lang={lang} />
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
    // Contact: the contact form on a server, the operator's address (once
    // set, see src/lib/brand.ts) in the static build.
    return wrap(t["about.title"], (
      <div className="space-y-4 text-[17px] leading-relaxed text-ink-2">
        {[1, 2, 3].map((n) => <p key={n}>{k(`about.b${n}`, { brand: BRAND.name })}</p>)}
        <div className="flex flex-wrap gap-2 pt-4">
          {!STATIC && <Link href={`/${lang}/contact`} className="btn btn-quiet">{t["foot.contact"]}</Link>}
          {STATIC && OPERATOR.contactHref && <a href={OPERATOR.contactHref} className="btn btn-quiet">{t["foot.contact"]}</a>}
          {REPO_URL && <a href={`${REPO_URL}/issues`} className="btn btn-quiet">{t["about.report"]}</a>}
        </div>
      </div>
    ));
  }
  if (slug === "licenses") return <Licenses wrap={wrap} t={t} />;
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
                    <p className="text-[15px] text-muted">{k(descKey(tool))}</p>
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
        <section key={s.h} id={s.id}>
          <h2>{s.h}</h2>
          {s.p.map((p) => <p key={p}>{p}</p>)}
          {s.list && <ul>{s.list.map((li) => <li key={li}>{li}</li>)}</ul>}
          {s.link && <p>{s.link[0]} {s.link[2] ? <a href={s.link[2]}>{s.link[1]}</a> : s.link[1]}</p>}
        </section>
      ))}
    </div>
  ));
}

// Every component and library the site ships, from the list scripts/vendor.mjs
// writes next to their licence texts. Names and versions are isolated (<bdi>)
// so they read left to right on right-to-left pages.
function Licenses({ wrap, t }: { wrap: (title: string, body: React.ReactNode, subtitle?: string) => React.ReactNode; t: Dict }) {
  const { components, libraries, librariesFile } = readLicenses();
  const link = "underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink";
  return wrap(t["lic.title"], (
    <div className="space-y-14">
      <section>
        <h2 className="eyebrow mb-3">{t["lic.components"]}</h2>
        <ul className="divide-y divide-line border-y border-line">
          {components.map((c) => (
            <li key={c.name} className="py-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <h3 className="text-[16px] font-medium tracking-[-0.01em]">{c.name}</h3>
                <a href={`${LICENSES_URL}${c.file}`} className={`text-[14px] text-ink-2 ${link}`}>{t["lic.text"]}</a>
              </div>
              {c.includes.map((i) => (
                <p key={i.name} className="mt-1 text-[15px] text-ink-2">
                  <bdi>{i.name} · {i.license}</bdi> · <a href={i.source} className={link}>{t["foot.source"]}</a>
                </p>
              ))}
              {c.packages.length > 0 && (
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  {c.packages.map((p, n) => (
                    <span key={p.name}>
                      {n > 0 && ", "}
                      <bdi><a href={p.source} className={link}>{p.name}</a> {p.version} ({p.license})</bdi>
                    </span>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-4 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">{t["lic.mpl"]}</p>
        <p className="mt-3 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">{t["lic.lgpl"]}</p>
      </section>
      <section>
        <h2 className="eyebrow mb-3">{t["lic.libraries"]}</h2>
        <p className="max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">
          {t["lic.librariesBody"]} <a href={`${LICENSES_URL}${librariesFile}`} className={link}>{t["lic.text"]}</a>
        </p>
        <ul className="mt-5 gap-x-8 text-[13px] leading-relaxed text-muted sm:columns-2 lg:columns-3">
          {libraries.map((l) => (
            <li key={`${l.name}@${l.version}`} className="break-inside-avoid">
              <bdi><a href={l.source} className={link}>{l.name}</a> {l.version} ({l.license})</bdi>
            </li>
          ))}
        </ul>
      </section>
      {REPO_URL && <a href={REPO_URL} className="btn btn-quiet">{format(t["lic.own"], { brand: BRAND.name })}</a>}
    </div>
  ), format(t["lic.subtitle"], { brand: BRAND.name }));
}
