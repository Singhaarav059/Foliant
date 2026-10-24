"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, Server, X } from "lucide-react";
import { ToolIcon } from "./ToolIcon";
import { CATEGORY_DOODLE } from "./Decor";
import { useI18n } from "./I18n";
import { CATEGORIES, TOOLS, descKey } from "@/lib/tools";

// The tools as an index: one numbered section per category, hairline rows.
export function ToolGrid() {
  const { t, href } = useI18n();
  const [q, setQ] = useState("");

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return CATEGORIES.map((c, i) => ({
      id: c.id,
      index: String(i + 1).padStart(2, "0"),
      tools: TOOLS.filter((tool) => {
        if (tool.category !== c.id) return false;
        if (!needle) return true;
        return `${t(`tool.${tool.id}.name`)} ${t(descKey(tool))} ${tool.slug} ${tool.accept.join(" ")}`
          .toLowerCase()
          .includes(needle);
      }),
    })).filter((s) => s.tools.length);
  }, [q, t]);

  return (
    <section aria-label={t("nav.allTools")}>
      <div className="sticky top-16 z-20 -mx-4 bg-[color-mix(in_oklab,var(--bg)_82%,transparent)] px-4 py-3 backdrop-blur-[14px] sm:-mx-6 sm:px-6">
        <label className="relative block">
          <span className="sr-only">{t("home.searchPlaceholder")}</span>
          <Search size={17} strokeWidth={1.75} className="pointer-events-none absolute start-4.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="field h-14 rounded-full ps-11 pe-12 text-[16px] shadow-card [&::-webkit-search-cancel-button]:hidden"
          />
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
      </div>

      {sections.length === 0 ? (
        <p className="rise py-28 text-center text-[1.5rem] font-medium tracking-[-0.02em] text-muted">{t("home.noResults")}</p>
      ) : (
        sections.map((s) => {
          const Doodle = CATEGORY_DOODLE[s.id];
          return (
          <section
            key={s.id}
            aria-labelledby={`cat-${s.id}`}
            className="grid gap-x-12 gap-y-5 pb-14 pt-10 lg:grid-cols-[240px_1fr]"
          >
            <header className="relative flex items-baseline gap-3 lg:sticky lg:top-[150px] lg:h-max lg:flex-col lg:gap-2">
              <span aria-hidden className="reveal-line absolute inset-x-0 -top-10 h-px bg-line lg:-end-12" />
              <span className="font-mono text-[0.8rem] leading-none text-accent">{s.index}</span>
              <h2 id={`cat-${s.id}`} className="display text-[1.6rem] sm:text-[1.9rem]">{t(`cat.${s.id}`)}</h2>
              <Doodle className="hidden h-12 w-12 -rotate-6 text-accent lg:mt-3 lg:block" />
              <span className="eyebrow ms-auto lg:ms-0">{s.tools.length}</span>
            </header>
            <ul className="grid gap-x-3 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
              {s.tools.map((tool) => (
                <li key={tool.id} className="reveal">
                  <Link
                    href={href(`/${tool.slug}`)}
                    data-tool={tool.id}
                    className="spot group flex h-full gap-3.5 rounded-2xl border border-transparent px-3.5 py-4 transition-[border-color,box-shadow,translate] duration-500 ease-(--ease-out) hover:-translate-y-0.5 hover:border-line hover:shadow-card"
                  >
                    <ToolIcon tool={tool} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-medium tracking-[-0.01em]">{t(`tool.${tool.id}.name`)}</span>
                        {tool.isNew && <span className="eyebrow rounded-[3px] border border-accent/40 px-1 py-px text-[10px] uppercase tracking-[0.08em] text-accent">{t("home.new")}</span>}
                        {tool.runtime === "server" && (
                          <Server size={12} className="text-muted" aria-label={t("home.serverBadge")} />
                        )}
                      </span>
                      <span className="mt-0.5 block text-pretty text-[14px] leading-snug text-muted">{t(descKey(tool))}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          );
        })
      )}
    </section>
  );
}
