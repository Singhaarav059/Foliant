"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Globe2, Menu, X, UserRound, LogOut } from "lucide-react";
import { Logo } from "./Logo";
import { ToolIcon } from "./ToolIcon";
import { useI18n } from "./I18n";
import { useUser, postJson } from "./User";
import { CATEGORIES, TOOLS } from "@/lib/tools";
import { LOCALES, type Locale } from "@/lib/i18n/locales";
import { switchLanguage } from "@/lib/i18n/slugs";
import { STATIC } from "@/lib/mode";

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
  const { user, ready, setUser } = useUser();
  const pathname = usePathname();
  const router = useRouter();
  const [menu, setMenu] = useState<null | "tools" | "lang" | "user" | "mobile">(null);
  const close = () => setMenu(null);
  const toolsRef = useDismiss(menu === "tools", close);
  const langRef = useDismiss(menu === "lang", close);
  const userRef = useDismiss(menu === "user", close);

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

  const logout = async () => {
    await postJson("/api/auth/logout");
    setUser(null);
    close();
    router.push(href("/"));
  };

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-[color-mix(in_oklab,var(--bg)_86%,transparent)] backdrop-blur-md backdrop-saturate-150">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-2 px-4 sm:px-6">
        <Link href={href("/")} className="me-4 rounded-md" aria-label="Home">
          <Logo />
        </Link>

        <nav className="hidden items-center gap-0.5 md:flex">
          <div ref={toolsRef} className="relative">
            <button
              className="btn btn-sm btn-ghost gap-1 aria-expanded:bg-surface-2 aria-expanded:text-ink"
              aria-expanded={menu === "tools"}
              onClick={() => setMenu(menu === "tools" ? null : "tools")}
            >
              {t("nav.allTools")}
              <ChevronDown size={14} strokeWidth={2} className={`text-muted transition-transform duration-200 ${menu === "tools" ? "rotate-180" : ""}`} />
            </button>
            {menu === "tools" && (
              <div className="rise fixed inset-x-0 top-[72px] mx-auto max-w-[1200px] px-4 sm:px-6">
                <div className="card grid max-h-[75vh] grid-cols-3 gap-x-8 gap-y-7 overflow-auto p-7 shadow-card lg:grid-cols-6">
                  {CATEGORIES.map((c) => (
                    <div key={c.id}>
                      <p className="mb-2.5 text-[13px] text-muted">
                        {t(`cat.${c.id}`)}
                      </p>
                      <ul className="space-y-0.5">
                        {TOOLS.filter((x) => x.category === c.id).map((tool) => (
                          <li key={tool.id}>
                            <Link
                              href={href(`/${tool.slug}`)}
                              className="-mx-2 block rounded-md px-2 py-1.5 text-[14px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                            >
                              {t(`tool.${tool.id}.name`)}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <Link href={href("/workflows")} aria-current={pathname.endsWith("/workflows") ? "page" : undefined} className="btn btn-sm btn-ghost aria-[current]:text-ink">
            {t("nav.workflows")}
          </Link>
        </nav>

        <div className="ms-auto flex items-center gap-1">
          <div ref={langRef} className="relative hidden sm:block">
            <button
              className="icon-btn h-9 w-auto gap-1.5 px-2.5 text-[13px] aria-expanded:bg-surface-2"
              aria-label={t("nav.language")}
              aria-expanded={menu === "lang"}
              onClick={() => setMenu(menu === "lang" ? null : "lang")}
            >
              <Globe2 size={16} strokeWidth={1.75} />
              <span className="font-mono uppercase">{locale === "zh-cn" ? "简" : locale === "zh-tw" ? "繁" : locale}</span>
            </button>
            {menu === "lang" && (
              <div className="rise absolute end-0 top-11 card grid w-[420px] grid-cols-2 gap-0.5 p-1.5 shadow-card">
                {LOCALES.map((l) => (
                  <button
                    key={l.code}
                    lang={l.code}
                    onClick={() => switchLocale(l.code)}
                    className={`rounded-md px-3 py-1.5 text-start text-[14px] hover:bg-surface-2 ${l.code === locale ? "bg-surface-2 font-medium text-ink" : "text-ink-2"}`}
                  >
                    {l.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!STATIC && ready && !user && (
            <>
              <Link href={href("/login")} className="btn btn-sm btn-ghost hidden sm:inline-flex">
                {t("nav.login")}
              </Link>
              <Link href={href("/register")} className="btn btn-sm btn-primary hidden sm:inline-flex">
                {t("nav.signup")}
              </Link>
            </>
          )}
          {ready && user && (
            <div ref={userRef} className="relative hidden sm:block">
              <button
                className="flex h-9 items-center gap-2 rounded-lg border border-line bg-surface ps-1 pe-3 text-[13px] transition-colors hover:border-line-strong"
                aria-expanded={menu === "user"}
                onClick={() => setMenu(menu === "user" ? null : "user")}
              >
                <span className="grid h-7 w-7 place-items-center rounded-md bg-ink text-[12px] font-semibold text-bg">
                  {(user.name || user.email)[0].toUpperCase()}
                </span>
                <span className="max-w-[140px] truncate">{user.name || user.email}</span>
              </button>
              {menu === "user" && (
                <div className="rise absolute end-0 top-11 card w-56 p-1.5 shadow-card">
                  <Link href={href("/account")} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[14px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                    <UserRound size={16} /> {t("nav.account")}
                  </Link>
                  <Link href={href("/workflows")} className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[14px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                    <LayoutGridIcon /> {t("nav.workflows")}
                  </Link>
                  <button onClick={logout} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-start text-[14px] text-ink-2 hover:bg-surface-2 hover:text-ink">
                    <LogOut size={16} /> {t("nav.logout")}
                  </button>
                </div>
              )}
            </div>
          )}

          <button className="icon-btn md:hidden" aria-label={t("nav.menu")} onClick={() => setMenu("mobile")}>
            <Menu size={22} />
          </button>
        </div>
      </div>

      {menu === "mobile" && (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg md:hidden" role="dialog" aria-modal>
          <div className="flex h-16 items-center justify-between border-b border-line px-4">
            <Logo />
            <button className="icon-btn" aria-label={t("nav.close")} onClick={close}>
              <X size={22} />
            </button>
          </div>
          <div className="flex-1 overflow-auto px-4 pb-10 pt-4">
            {!STATIC && <div className="mb-5 flex gap-2">
              {user ? (
                <>
                  <Link href={href("/account")} className="btn btn-quiet flex-1">{t("nav.account")}</Link>
                  <button onClick={logout} className="btn btn-quiet flex-1">{t("nav.logout")}</button>
                </>
              ) : (
                <>
                  <Link href={href("/login")} className="btn btn-quiet flex-1">{t("nav.login")}</Link>
                  <Link href={href("/register")} className="btn btn-primary flex-1">{t("nav.signup")}</Link>
                </>
              )}
            </div>}
            <div className="mb-6 flex gap-2">
              <Link href={href("/workflows")} className="btn btn-quiet btn-sm flex-1">{t("nav.workflows")}</Link>
            </div>
            {CATEGORIES.map((c) => (
              <div key={c.id} className="mb-7">
                <p className="eyebrow mb-1">{t(`cat.${c.id}`)}</p>
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

function LayoutGridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 6h16M4 12h10M4 18h6" strokeLinecap="round" />
    </svg>
  );
}
