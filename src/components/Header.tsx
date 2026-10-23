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
    <header className="header-scroll sticky top-0 z-40 border-b border-line bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] backdrop-blur-[14px] backdrop-saturate-150">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-2 px-4 sm:px-6">
        <Link href={href("/")} className="me-6 rounded-md" aria-label={t("nav.home")}>
          <Logo />
        </Link>

        <nav className="hidden items-center gap-5 md:flex">
          <div ref={toolsRef} className="relative">
            <button
              className="link-u inline-flex items-center gap-1 py-1 text-[14px] text-ink-2 transition-colors hover:text-ink aria-expanded:bg-[length:100%_1px] aria-expanded:text-ink"
              aria-expanded={menu === "tools"}
              onClick={() => setMenu(menu === "tools" ? null : "tools")}
            >
              {t("nav.allTools")}
              <ChevronDown size={14} strokeWidth={2} className={`text-muted transition-transform duration-300 ease-(--ease-spring) ${menu === "tools" ? "rotate-180" : ""}`} />
            </button>
            {menu === "tools" && (
              <div className="fixed inset-x-0 top-[72px] mx-auto max-w-[1200px] px-4 sm:px-6">
                <div className="unfold card grid max-h-[75vh] grid-cols-3 gap-x-8 gap-y-8 overflow-auto p-8 shadow-lift lg:grid-cols-6">
                  {CATEGORIES.map((c, ci) => (
                    <div key={c.id} className="stagger">
                      <p className="mb-3 flex items-baseline gap-2" style={{ "--i": ci } as React.CSSProperties}>
                        <span className="eyebrow text-accent">{String(ci + 1).padStart(2, "0")}</span>
                        <span className="font-display text-[1.3rem] leading-none tracking-[-0.01em]">{t(`cat.${c.id}`)}</span>
                      </p>
                      {TOOLS.filter((x) => x.category === c.id).map((tool, i) => (
                        <Link
                          key={tool.id}
                          href={href(`/${tool.slug}`)}
                          style={{ "--i": ci + i * 0.6 } as React.CSSProperties}
                          className="-mx-2 block rounded-lg px-2 py-1.5 text-[14px] text-ink-2 transition-[background-color,color,translate] duration-300 ease-(--ease-out) hover:translate-x-0.5 hover:bg-surface-2 hover:text-ink rtl:hover:-translate-x-0.5"
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
          <Link href={href("/workflows")} aria-current={pathname.endsWith("/workflows") ? "page" : undefined} className="link-u py-1 text-[14px] text-ink-2 transition-colors hover:text-ink aria-[current]:text-ink">
            {t("nav.workflows")}
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
              <span className="font-mono uppercase">{locale === "zh-cn" ? "简" : locale === "zh-tw" ? "繁" : locale}</span>
            </button>
            {menu === "lang" && (
              <div className="unfold absolute end-0 top-11 card grid w-[420px] grid-cols-2 gap-0.5 p-1.5 shadow-lift">
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
                    className={`rounded-lg px-3 py-1.5 text-start text-[14px] transition-colors hover:bg-surface-2 ${l.code === locale ? "bg-surface-2 font-medium text-ink" : "text-ink-2"}`}
                  >
                    {l.name}
                  </a>
                ))}
              </div>
            )}
          </div>

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
            </div>
            {CATEGORIES.map((c, ci) => (
              <div key={c.id} className="stagger mb-8" style={{ "--i": ci } as React.CSSProperties}>
                <p className="mb-1 flex items-baseline gap-2">
                  <span className="eyebrow text-accent">{String(ci + 1).padStart(2, "0")}</span>
                  <span className="font-display text-[1.6rem] leading-tight">{t(`cat.${c.id}`)}</span>
                </p>
                <ul>
                  {TOOLS.filter((x) => x.category === c.id).map((tool) => (
                    <li key={tool.id}>
                      <Link href={href(`/${tool.slug}`)} className="group flex items-center gap-3 border-b border-line py-2.5 text-[16px]">
                        <ToolIcon tool={tool} size={32} />
                        {t(`tool.${tool.id}.name`)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <label className="mt-2 block text-[13px] font-semibold text-muted" htmlFor="m-lang">{t("nav.language")}</label>
            <select id="m-lang" className="field mt-1.5" value={locale} onChange={(e) => switchLocale(e.target.value as Locale)}>
              {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </div>
        </div>
      )}
    </header>
  );
}
