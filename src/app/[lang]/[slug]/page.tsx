import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ShieldCheck, Server, ArrowRight, Cloud } from "lucide-react";
import { Workspace } from "@/components/workspace/LazyWorkspace";
import { PrivacyChip } from "@/components/workspace/PrivacyChip";
import { ToolIcon } from "@/components/ToolIcon";
import { ToolContent, toolText } from "@/components/ToolContent";
import { getDictionary, format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import { hasLocale, LOCALE_CODES, type Locale } from "@/lib/i18n/locales";
import { CATEGORIES, LIMITS, TOOLS, descKey, toolById, toolBySlug, type Tool } from "@/lib/tools";
import { LEGAL, LEGAL_UPDATED } from "@/lib/legal";
import { BRAND, OPERATOR } from "@/lib/brand";
import { readLicenses, LICENSES_URL } from "@/lib/licenses";
import { AI_CLOUD, REPO_URL, STATIC } from "@/lib/mode";
import { INFO, pageMetadata, pageUrl, type Info } from "@/lib/seo";
import { englishSlug, localSlug, movedTo } from "@/lib/i18n/slugs";
import { INTENTS, intentBySlug, type Intent } from "@/lib/intents";
import { LANDINGS, landingBySlug } from "@/lib/landings";
import { LandingPage, landingText } from "@/components/LandingPage";
import { Words } from "@/components/Motion";
import { Wash } from "@/components/Decor";
import { Sparkle } from "@/components/Studio";

// Tools and intent pages at their slugs in each language; the old English
// slugs are redirects (scripts/static-extras.mjs, src/proxy.server.ts).
export function generateStaticParams() {
  const slugs = [...TOOLS.map((t) => t.slug), ...INTENTS.map((i) => i.slug), ...LANDINGS.map((l) => l.slug), ...INFO];
  return LOCALE_CODES.flatMap((lang) => slugs.map((slug) => ({ lang, slug: localSlug(slug, lang) })));
}

// What /{lang}/{slug} shows, by the page's English slug.
function pageOf(lang: Locale, slug: string) {
  const en = englishSlug(slug, lang);
  if (!en) return {};
  return { en, tool: toolBySlug(en), intent: intentBySlug(en), landing: landingBySlug(en), info: (INFO as readonly string[]).includes(en) ? (en as Info) : undefined };
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
  const { en, tool, intent, landing, info } = pageOf(lang, slug);
  if (tool) {
    // Tools without their own search title and description use their name and summary.
    const title = toolText(t, tool, "title") || t[`tool.${tool.id}.name` as DictKey];
    const description = toolText(t, tool, "meta") || t[descKey(tool) as DictKey];
    return { title, description, ...pageMetadata({ lang, path: `/${en}`, title, description, image: tool.slug }) };
  }
  if (intent) {
    const title = intent.title[lang];
    const description = intentDescription(intent, t);
    return { title, description, ...pageMetadata({ lang, path: `/${en}`, title, description }) };
  }
  if (landing) {
    const title = landingText(t, landing, "title");
    const description = landingText(t, landing, "meta");
    return { title, description, ...pageMetadata({ lang, path: `/${en}`, title, description, image: toolById(landing.tool).slug }) };
  }
  if (info) {
    const title = infoTitle(info, t);
    const description = infoDescription(info, t);
    return { title, description, ...pageMetadata({ lang, path: `/${en}`, title, description }) };
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
  // The server build's proxy redirects old addresses first; this is a fallback.
  const moved = movedTo(slug, lang);
  if (moved) permanentRedirect(moved);
  const t = await getDictionary(lang);
  const { tool, intent, landing, info } = pageOf(lang, slug);
  if (tool) return <ToolPage tool={tool} t={t} lang={lang} />;
  if (intent) return <IntentPage intent={intent} t={t} lang={lang} />;
  if (landing) return <LandingPage intent={landing} t={t} lang={lang} />;
  if (info) return <InfoPage slug={info} t={t} lang={lang} />;
  notFound();
}

function ToolPage({ tool, t, lang }: { tool: Tool; t: Dict; lang: Locale }) {
  const k = (s: string) => t[s as DictKey];
  const related = TOOLS.filter((x) => x.category === tool.category && x.id !== tool.id).slice(0, 4);
  // AI tools default to the cloud AI: they say so instead of "Runs on your device".
  const cloudAi = AI_CLOUD && !!tool.ai;
  const Badge = cloudAi ? Cloud : tool.runtime === "browser" ? ShieldCheck : Server;
  return (
    <div data-cat={tool.category} className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <header className="relative isolate mx-auto flex max-w-[760px] flex-col items-center pb-5 pt-6 text-center sm:pt-8">
        <div aria-hidden className="pointer-events-none absolute start-1/2 -top-10 -z-10 h-[360px] w-[min(760px,100%)] -translate-x-1/2 bg-[radial-gradient(closest-side,var(--tint),transparent)] rtl:translate-x-1/2" />
        <Sparkle className="absolute start-[8%] top-16 hidden w-5 text-coral md:block" delay="-0.5s" />
        <Sparkle className="absolute end-[10%] top-28 hidden w-3.5 text-(--tint-ink) md:block" delay="-1.4s" />
        <nav aria-label={t["nav.breadcrumb"]} className="flex items-center gap-1.5 text-[13px]">
          <Link href={`/${lang}`} className="rounded-full px-2.5 py-1 font-medium text-muted transition-colors hover:bg-surface hover:text-ink">{t["nav.allTools"]}</Link>
          <span aria-hidden className="text-line-strong">/</span>
          <span className="pill h-7">{k(`cat.${tool.category}`)}</span>
        </nav>
        <div className="mt-4 flex items-center justify-center gap-3 sm:gap-4">
          <span className="hop shrink-0" style={{ "--d": "100ms" } as React.CSSProperties}>
            <span className="block rounded-[18px] bg-surface p-1 shadow-lift">
              <ToolIcon tool={tool} size={44} />
            </span>
          </span>
          <h1 className="display text-start text-[2.1rem] sm:text-[3rem]"><Words text={k(`tool.${tool.id}.name`)} /></h1>
        </div>
        <p className="fade-up mt-3 max-w-[540px] text-pretty text-[17px] leading-relaxed text-ink-2">{k(descKey(tool))}</p>
        <div className="fade-up mt-4 flex flex-wrap items-center justify-center gap-2" style={{ "--d": "420ms" } as React.CSSProperties}>
          <p data-cat={tool.runtime === "browser" && !cloudAi ? "organize" : "optimize"} className="pill">
            <Badge size={14} strokeWidth={2} aria-hidden />
            {cloudAi ? t["home.aiBadge"] : tool.runtime === "browser" ? t["home.privateBadge"] : t["home.serverBadge"]}
          </p>
          <PrivacyChip />
        </div>
      </header>

      <Workspace toolId={tool.id} />

      <section className="mx-auto mt-28 max-w-[960px]">
        <ToolContent tool={tool} t={t} lang={lang} />
        {related.length > 0 && (
          <div className="mt-14">
            <h2 className="mb-4 text-[1.25rem] font-semibold tracking-[-0.02em]">{t[`cat.${tool.category}` as DictKey]}</h2>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((r) => (
                <li key={r.id}>
                  <Link href={pageUrl(lang, `/${r.slug}`)} className="spot group card flex items-center gap-3 p-3 transition-[border-color,box-shadow,translate] duration-500 ease-(--ease-out) hover:-translate-y-1 hover:border-line-strong hover:shadow-lift">
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

// A search-intent page (src/lib/intents.ts): the tools that answer one
// search, each with its own introduction and a link to it.
const toolsOf = (intent: Intent) => intent.tools.map((id) => TOOLS.find((x) => x.id === id)!);
const intentDescription = (intent: Intent, t: Dict) => toolsOf(intent).map((x) => t[`tool.${x.id}.name` as DictKey]).join(", ");

function IntentPage({ intent, t, lang }: { intent: Intent; t: Dict; lang: Locale }) {
  const k = (s: string) => t[s as DictKey];
  return (
    <div className="mx-auto max-w-[960px] px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
      <nav aria-label={t["nav.breadcrumb"]} className="eyebrow">
        <Link href={`/${lang}`} className="transition-colors hover:text-ink">{t["nav.allTools"]}</Link>
      </nav>
      <h1 className="mt-5 display text-[2.4rem] sm:text-[3.4rem]"><Words text={intent.title[lang]} /></h1>
      <p className="mt-4 max-w-[640px] text-pretty text-[17px] leading-relaxed text-ink-2">{intentDescription(intent, t)}</p>
      <ul className="mt-12 divide-y divide-line border-y border-line">
        {toolsOf(intent).map((tool) => (
          <li key={tool.id} className="reveal group flex gap-4 py-7">
            <ToolIcon tool={tool} size={40} />
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-medium tracking-[-0.015em]">
                <Link href={pageUrl(lang, `/${tool.slug}`)} className="transition-colors hover:text-ink-2">{k(`tool.${tool.id}.name`)}</Link>
              </h2>
              <p className="mt-1 text-[15px] text-muted">{k(`tool.${tool.id}.desc`)}</p>
              <p className="mt-3 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">{toolText(t, tool, "intro")}</p>
              <Link href={pageUrl(lang, `/${tool.slug}`)} className="btn btn-quiet btn-sm mt-4">
                {t["guide.open"]} <ArrowRight size={15} className="rtl:rotate-180" />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InfoPage({ slug, t, lang }: { slug: Info; t: Dict; lang: Locale }) {
  const k = (s: string, vars?: Record<string, string | number>) => format(t[s as DictKey] ?? s, vars);
  const wrap = (title: string, body: React.ReactNode, subtitle?: string) => (
    <div className="relative isolate mx-auto max-w-[860px] px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
      <Wash className="-end-32 -top-10 h-[340px] w-[340px]" />
      <h1 className="display text-[2.4rem] sm:text-[3.4rem]"><Words text={title} /></h1>
      {subtitle && <p className="fade-up mt-5 max-w-[560px] text-pretty text-[17px] leading-relaxed text-ink-2">{subtitle}</p>}
      <div className="fade-up mt-14" style={{ "--d": "450ms" } as React.CSSProperties}>{body}</div>
    </div>
  );

  if (slug === "features") {
    return wrap(t["feat.title"], (
      <div className="grid gap-x-10 sm:grid-cols-2">
        {[1, 2, 3, 4, 5, 6, 7].map((n) => (
          <div key={n} className="reveal border-t border-line py-7">
            <span className="font-mono text-[1.4rem] leading-none text-accent">{String(n).padStart(2, "0")}</span>
            <h2 className="mt-3 text-[17px] font-medium tracking-[-0.01em]">{k(`feat.f${n}t`)}</h2>
            <p className="mt-1.5 text-pretty text-[15px] leading-relaxed text-muted">{k(`feat.f${n}b`)}</p>
          </div>
        ))}
      </div>
    ), t["feat.subtitle"]);
  }
  if (slug === "faq") {
    return wrap(t["faq.title"], (
      <div className="divide-y divide-line border-y border-line">
        {/* The static build has no server (question 1). */}
        {(STATIC ? [2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7, 8]).map((n) => (
          <details key={n} className="reveal group py-6 [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-medium tracking-[-0.01em]">
              {k(`faq.q${n}`)}
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-line text-muted transition-[rotate,background-color,color] duration-500 ease-(--ease-spring) group-open:rotate-45 group-open:bg-ink group-open:text-bg" aria-hidden>+</span>
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
        {/* Server processing only exists on a server. */}
        {(STATIC ? [1, 4] : [1, 2, 4]).map((n) => (
          <section key={n}>
            <h2 className="text-[18px] font-medium tracking-[-0.015em]">{k(`sec.h${n}`)}</h2>
            <p className="mt-2 text-[16px] leading-relaxed text-ink-2">{k(`sec.b${n}`)}</p>
          </section>
        ))}
        <section id="check" className="scroll-mt-24">
          <h2 className="text-[18px] font-medium tracking-[-0.015em]">{t["sec.checkTitle"]}</h2>
          <ol className="mt-2 list-decimal space-y-2 ps-5 text-[16px] leading-relaxed text-ink-2">
            {[1, 2, 3, 4].map((n) => <li key={n}>{k(`sec.check${n}`)}</li>)}
          </ol>
        </section>
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
                <li key={tool.id} className="reveal group flex items-center gap-4 py-4">
                  <ToolIcon tool={tool} size={40} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium tracking-[-0.01em]">{k(`tool.${tool.id}.name`)}</p>
                    <p className="text-[15px] text-muted">{k(descKey(tool))}</p>
                  </div>
                  <Link href={pageUrl(lang, `/${tool.slug}`)} className="btn btn-quiet btn-sm hidden sm:inline-flex">
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
