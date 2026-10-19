"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, Server, X } from "lucide-react";
import { ToolIcon } from "./ToolIcon";
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
      <div className="sticky top-16 z-20 -mx-4 bg-[color-mix(in_oklab,var(--bg)_90%,transparent)] px-4 py-3 backdrop-blur-md sm:-mx-6 sm:px-6">
        <label className="relative block">
          <span className="sr-only">{t("home.searchPlaceholder")}</span>
          <Search size={17} strokeWidth={1.75} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="field h-12 rounded-xl ps-10 pe-10 text-[16px] [&::-webkit-search-cancel-button]:hidden"
          />
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              aria-label={t("nav.close")}
              className="icon-btn absolute end-1.5 top-1/2 h-9 w-9 -translate-y-1/2"
            >
              <X size={16} />
            </button>
          )}
        </label>
      </div>

      {sections.length === 0 ? (
        <p className="py-24 text-center text-[15px] text-muted">{t("home.noResults")}</p>
      ) : (
        sections.map((s) => (
          <section
            key={s.id}
            aria-labelledby={`cat-${s.id}`}
            className="grid gap-x-12 gap-y-4 border-t border-line pb-10 pt-6 first-of-type:border-t-0 lg:grid-cols-[200px_1fr]"
          >
            <header className="flex items-baseline gap-3 lg:sticky lg:top-[140px] lg:h-max lg:flex-col lg:gap-1.5">
              <span className="eyebrow">{s.index}</span>
              <h2 id={`cat-${s.id}`} className="text-[15px] font-medium tracking-[-0.01em]">{t(`cat.${s.id}`)}</h2>
              <span className="eyebrow ms-auto lg:ms-0">{s.tools.length}</span>
            </header>
            <ul className="grid gap-x-8 sm:grid-cols-2 xl:grid-cols-3">
              {s.tools.map((tool) => (
                <li key={tool.id} className="border-t border-line first:border-t-0 sm:[&:nth-child(2)]:border-t-0 xl:[&:nth-child(3)]:border-t-0">
                  <Link
                    href={href(`/${tool.slug}`)}
                    data-tool={tool.id}
                    className="group -mx-3 flex gap-3.5 rounded-xl px-3 py-4 transition-colors duration-150 hover:bg-surface"
                  >
                    <ToolIcon tool={tool} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[15px] font-medium tracking-[-0.01em]">{t(`tool.${tool.id}.name`)}</span>
                        {tool.isNew && <span className="text-[12px] font-medium text-accent">{t("home.new")}</span>}
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
        ))
      )}
    </section>
  );
}
