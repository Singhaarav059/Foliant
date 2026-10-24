"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Globe2, Menu, X } from "lucide-react";
import { Logo } from "./Logo";
import dynamic from "next/dynamic";
import { useI18n } from "./I18n";
import { CATEGORIES, TOOLS } from "@/lib/tools";
import { LOCALES, type Locale } from "@/lib/i18n/locales";
import { switchLanguage } from "@/lib/i18n/slugs";
import { ThemeMenu, ThemeSwitch } from "./ThemeMenu";

// Every tool's icon only shows in the phone menu: loaded when it opens (P3-03).
const ToolIcon = dynamic(() => import("./ToolIcon").then((m) => m.ToolIcon), { ssr: false });

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

export function Header() {
  const { t, href, locale } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState<null | "tools" | "lang" | "mobile">(null);
  const close = () => setMenu(null);
  const toolsRef = useDismiss(menu === "tools", close);
  const langRef = useDismiss(menu === "lang", close);

  // Close any open menu when the route changes.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMenu(null);
  }
  useEffect(() => {
    document.body.style.overflow = menu === "mobile" ? "hidden" : "";
  }, [menu]);

  const switchLocale = (code: Locale) => {
    router.push(switchLanguage(pathname, code));
    close();
  };

  return (
    <header className="sticky top-0 z-40 isolate px-3 pt-2 sm:px-4">
      <div className="relative mx-auto flex h-14 max-w-[1240px] items-center gap-2 rounded-full ps-4 pe-2 sm:ps-5">
        {/* The frosted island is its own layer: a backdrop-filter on an
            ancestor would make it the containing block of the fixed menus below. */}
        <div aria-hidden className="header-scroll absolute inset-0 -z-10 rounded-full border border-line bg-[color-mix(in_oklab,var(--surface)_86%,transparent)] backdrop-blur-[16px] backdrop-saturate-150" />
        <Link href={href("/")} className="me-4 rounded-full sm:me-6" aria-label={t("nav.home")}>
          <Logo />
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          <div ref={toolsRef} className="relative">
            <button
              className="inline-flex h-9 items-center gap-1 rounded-full px-3.5 text-[14px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink aria-expanded:bg-surface-2 aria-expanded:text-ink"
              aria-expanded={menu === "tools"}
              onClick={() => setMenu(menu === "tools" ? null : "tools")}
            >
              {t("nav.allTools")}
              <ChevronDown size={14} strokeWidth={2} className={`text-muted transition-transform duration-300 ease-(--ease-spring) ${menu === "tools" ? "rotate-180" : ""}`} />
            </button>
            {menu === "tools" && (
              <div className="fixed inset-x-0 top-[72px] mx-auto max-w-[1220px] px-4 sm:px-6">
                <div className="unfold card grid max-h-[75vh] grid-cols-3 gap-x-4 gap-y-6 overflow-auto rounded-[28px] p-5 shadow-lift lg:grid-cols-6">
                  {CATEGORIES.map((c, ci) => (
                    <div key={c.id} data-cat={c.id} className="stagger rounded-[20px] p-2 transition-colors hover:bg-(--tint)/40">
                      <p className="mb-2 flex items-center gap-2 px-2 pt-1" style={{ "--i": ci } as React.CSSProperties}>
                        <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-(--tint-ink)" />
                        <span className="text-[14px] font-semibold leading-none tracking-[-0.01em] text-ink">{t(`cat.${c.id}`)}</span>
                      </p>
                      {TOOLS.filter((x) => x.category === c.id).map((tool, i) => (
                        <Link
                          key={tool.id}
                          href={href(`/${tool.slug}`)}
                          style={{ "--i": ci + i * 0.6 } as React.CSSProperties}
                          className="block rounded-xl px-2 py-1.5 text-[14px] text-ink-2 transition-[background-color,color,translate] duration-300 ease-(--ease-out) hover:translate-x-0.5 hover:bg-surface hover:text-(--tint-ink) rtl:hover:-translate-x-0.5"
                        >
                          {t(`tool.${tool.id}.name`)}
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Link href={href("/workflows")} aria-current={pathname.endsWith("/workflows") ? "page" : undefined} className="inline-flex h-9 items-center rounded-full px-3.5 text-[14px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink aria-[current]:bg-surface-2 aria-[current]:text-ink">
            {t("nav.workflows")}
          </Link>
          <Link href={href("/guide")} aria-current={pathname.endsWith("/guide") ? "page" : undefined} className="inline-flex h-9 items-center rounded-full px-3.5 text-[14px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink aria-[current]:bg-surface-2 aria-[current]:text-ink">
            {t("foot.guide")}
          </Link>
        </nav>

        <div className="ms-auto flex items-center gap-1">
          <div ref={langRef} className="relative hidden sm:block">
            <button
              className="icon-btn h-9 w-auto gap-1.5 px-3 text-[13px] aria-expanded:bg-surface-2"
              aria-label={t("nav.language")}
              aria-expanded={menu === "lang"}
              onClick={() => setMenu(menu === "lang" ? null : "lang")}
            >
              <Globe2 size={16} strokeWidth={1.75} />
              <span className="font-medium uppercase">{locale === "zh-cn" ? "简" : locale === "zh-tw" ? "繁" : locale}</span>
            </button>
            {menu === "lang" && (
              <div className="unfold absolute end-0 top-12 card grid w-[420px] grid-cols-2 gap-0.5 rounded-[22px] p-1.5 shadow-lift">
                {/* Plain links to this page in each language: they work without
                    scripts, open in a new tab, and a language change loads a
                    new root layout (<html lang>) anyway. */}
                {LOCALES.map((l) => (
                  <a
                    key={l.code}
                    href={switchLanguage(pathname, l.code)}
                    hrefLang={l.code}
                    lang={l.code}
                    aria-current={l.code === locale ? "true" : undefined}
                    onClick={close}
                    className={`rounded-xl px-3 py-1.5 text-start text-[14px] transition-colors hover:bg-surface-2 ${l.code === locale ? "bg-surface-2 font-medium text-ink" : "text-ink-2"}`}
                  >
                    {l.name}
                  </a>
                ))}
              </div>
            )}
          </div>

          <ThemeMenu />

          <button className="icon-btn md:hidden" aria-label={t("nav.menu")} onClick={() => setMenu("mobile")}>
            <Menu size={22} />
          </button>
        </div>
      </div>

      {menu === "mobile" && (
        <div className="rise fixed inset-0 z-50 flex flex-col bg-bg md:hidden" role="dialog" aria-modal>
          <div className="flex h-16 items-center justify-between border-b border-line px-4">
            <Logo />
            <button className="icon-btn" aria-label={t("nav.close")} onClick={close}>
              <X size={22} />
            </button>
          </div>
          <div className="flex-1 overflow-auto px-4 pb-10 pt-4">
            <div className="mb-6 flex gap-2">
              <Link href={href("/workflows")} className="btn btn-quiet btn-sm flex-1">{t("nav.workflows")}</Link>
              <Link href={href("/guide")} className="btn btn-quiet btn-sm flex-1">{t("foot.guide")}</Link>
            </div>
            {CATEGORIES.map((c, ci) => (
              <div key={c.id} data-cat={c.id} className="stagger mb-8" style={{ "--i": ci } as React.CSSProperties}>
                <p className="mb-1 flex items-center gap-2">
                  <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-(--tint-ink)" />
                  <span className="text-[1.2rem] font-semibold leading-tight tracking-[-0.02em]">{t(`cat.${c.id}`)}</span>
                </p>
                <ul>
                  {TOOLS.filter((x) => x.category === c.id).map((tool) => (
                    <li key={tool.id}>
                      <Link href={href(`/${tool.slug}`)} className="group flex items-center gap-3 rounded-2xl px-1 py-2 text-[16px] transition-colors hover:bg-surface">
                        <ToolIcon tool={tool} size={32} />
                        {t(`tool.${tool.id}.name`)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="mt-2 mb-1.5 text-[13px] font-semibold text-muted">{t("theme.label")}</p>
            <ThemeSwitch />
            <label className="mt-6 block text-[13px] font-semibold text-muted" htmlFor="m-lang">{t("nav.language")}</label>
            <select id="m-lang" className="field mt-1.5" value={locale} onChange={(e) => switchLocale(e.target.value as Locale)}>
              {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
        </div>
      )}
    </header>
  );
}
