"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Cloud, Search, Server, X } from "lucide-react";
import { ToolIcon } from "./ToolIcon";
import { CategoryBadge } from "./Studio";
import { useI18n } from "./I18n";
import { CATEGORIES, TOOLS, descKey, type CategoryId } from "@/lib/tools";
import { AI_CLOUD } from "@/lib/mode";

// The tools by family, each in its own colour, with a search field and
// family chips that stay at the top while the list scrolls.
export function ToolGrid() {
  const { t, href } = useI18n();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<CategoryId | "all">("all");
  const input = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLElement>(null);

  // "/" jumps to the search field, as on many sites, unless already typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // A chip filters the list and brings its start into view.
  const choose = (id: CategoryId | "all") => {
    setCat(id);
    const y = (top.current?.getBoundingClientRect().top ?? 0) + scrollY - 64;
    if (scrollY > y) scrollTo({ top: y, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // Recomputed per render; the React Compiler memoizes it.
  const sections = (() => {
    const needle = q.trim().toLowerCase();
    return CATEGORIES.map((c) => ({
      id: c.id,
      tools: TOOLS.filter((tool) => {
        if (tool.category !== c.id) return false;
        if (!needle) return true;
        return `${t(`tool.${tool.id}.name`)} ${t(descKey(tool))} ${tool.slug} ${tool.accept.join(" ")}`
          .toLowerCase()
          .includes(needle);
      }),
    })).filter((s) => s.tools.length && (cat === "all" || s.id === cat));
  })();

  return (
    <section ref={top} id="tools" aria-labelledby="tools-title" className="scroll-mt-20">
      <div className="max-w-[640px]">
        <h2 id="tools-title" className="reveal display text-[2rem] sm:text-[2.75rem]">{t("home.toolsTitle")}</h2>
        <p className="reveal mt-4 text-pretty text-[16px] leading-relaxed text-muted">{t("home.toolsBody")}</p>
      </div>
      <div className="sticky top-16 z-20 -mx-4 mt-8 bg-[color-mix(in_oklab,var(--bg)_86%,transparent)] px-4 py-3 backdrop-blur-[14px] sm:-mx-6 sm:px-6">
        <label className="relative block">
          <span className="sr-only">{t("home.searchPlaceholder")}</span>
          <Search size={18} strokeWidth={1.75} className="pointer-events-none absolute start-5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="field h-14 rounded-full ps-12 pe-12 text-[16px] shadow-card [&::-webkit-search-cancel-button]:hidden"
          />
          {!q && (
            <kbd aria-hidden className="pointer-events-none absolute end-4 top-1/2 hidden h-7 min-w-7 -translate-y-1/2 place-items-center rounded-lg border border-line bg-surface-2 px-1.5 font-mono text-[12px] text-muted sm:grid">/</kbd>
          )}
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label={t("nav.close")}
              className="icon-btn absolute end-2.5 top-1/2 h-9 w-9 -translate-y-1/2"
            >
              <X size={16} />
            </button>
          )}
        </label>
        {/* Scrolls sideways on narrow screens; the edges fade out. */}
        <div role="group" aria-label={t("nav.allTools")} className="-mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(90deg,transparent,#000_16px,#000_calc(100%-16px),transparent)] [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 sm:[mask-image:none]">
          {(["all", ...CATEGORIES.map((c) => c.id)] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={cat === id}
              data-cat={id === "all" ? undefined : id}
              onClick={() => choose(id)}
              className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13px] font-medium text-ink-2 transition-[background-color,border-color,color,scale] duration-300 ease-(--ease-spring) hover:border-line-strong hover:text-ink active:scale-95 aria-pressed:border-transparent aria-pressed:bg-(--tint) aria-pressed:text-(--tint-ink) [&:not([data-cat])]:aria-pressed:bg-ink [&:not([data-cat])]:aria-pressed:text-bg"
            >
              {id !== "all" && <span aria-hidden className="h-2 w-2 rounded-full bg-(--tint-ink)" />}
              {id === "all" ? t("home.filterAll") : t(`cat.${id}`)}
            </button>
          ))}
        </div>
      </div>

      {sections.length === 0 ? (
        <div className="rise flex flex-col items-center py-24 text-center">
          <p className="text-[1.4rem] font-medium tracking-[-0.02em] text-muted">{t("home.noResults")}</p>
        </div>
      ) : (
        sections.map((s) => (
          <section
            key={s.id}
            data-cat={s.id}
            aria-labelledby={`cat-${s.id}`}
            className="pt-12"
          >
            <header className="reveal mb-5 flex items-center gap-4">
              <CategoryBadge id={s.id} size={52} />
              <div className="min-w-0 flex-1">
                <h3 id={`cat-${s.id}`} className="display text-[1.5rem] sm:text-[1.75rem]">{t(`cat.${s.id}`)}</h3>
                <p className="mt-1 text-pretty text-[14.5px] text-muted">{t(`cat.${s.id}.blurb`)}</p>
              </div>
              <span className="pill hidden tabular sm:inline-flex">{s.tools.length}</span>
            </header>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {s.tools.map((tool) => (
                <li key={tool.id} className="reveal">
                  <Link
                    href={href(`/${tool.slug}`)}
                    data-tool={tool.id}
                    className="spot group flex h-full items-start gap-3.5 rounded-[22px] border border-line bg-surface p-4 transition-[border-color,box-shadow,translate] duration-500 ease-(--ease-out) hover:-translate-y-1 hover:border-(--tint-ink)/30 hover:shadow-lift"
                  >
                    <ToolIcon tool={tool} size={44} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-semibold tracking-[-0.01em]">{t(`tool.${tool.id}.name`)}</span>
                        {tool.isNew && <span data-cat="convertTo" className="pill h-5 px-2 text-[11px]">{t("home.new")}</span>}
                        {tool.runtime === "server" && (
                          <Server size={12} className="text-muted" aria-label={t("home.serverBadge")} />
                        )}
                        {AI_CLOUD && tool.ai && <Cloud size={12} className="text-muted" aria-label={t("home.aiBadge")} />}
                      </span>
                      <span className="mt-1 block text-pretty text-[14px] leading-snug text-muted">{t(descKey(tool))}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
