"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, Laptop, Server } from "lucide-react";
import { ToolIcon } from "./ToolIcon";
import { useI18n } from "./I18n";
import { CATEGORIES, TOOLS, type CategoryId } from "@/lib/tools";

export function ToolGrid() {
  const { t, href } = useI18n();
  const [cat, setCat] = useState<CategoryId | "all">("all");
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return TOOLS.filter((tool) => {
      if (cat !== "all" && tool.category !== cat) return false;
      if (!needle) return true;
      return `${t(`tool.${tool.id}.name`)} ${t(`tool.${tool.id}.desc`)} ${tool.slug} ${tool.accept.join(" ")}`
        .toLowerCase()
        .includes(needle);
    });
  }, [cat, q, t]);

  return (
    <section aria-label={t("nav.allTools")}>
      <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:px-0 lg:pb-0" role="tablist">
          {(["all", ...CATEGORIES.map((c) => c.id)] as const).map((id) => {
            const active = cat === id;
            const color = id === "all" ? "var(--ink)" : CATEGORIES.find((c) => c.id === id)!.color;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={active}
                onClick={() => setCat(id)}
                className="btn btn-sm shrink-0 border"
                style={{
                  borderColor: active ? color : "var(--line)",
                  background: active ? `color-mix(in oklab, ${color} 10%, var(--surface))` : "var(--surface)",
                  color: active ? color : "var(--ink-2)",
                }}
              >
                {id === "all" ? t("home.filterAll") : t(`cat.${id}`)}
              </button>
            );
          })}
        </div>
        <label className="relative lg:ms-auto lg:w-72">
          <span className="sr-only">{t("home.searchPlaceholder")}</span>
          <Search size={17} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("home.searchPlaceholder")}
            className="field ps-9"
          />
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="py-16 text-center text-muted">{t("home.noResults")}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((tool) => (
            <li key={tool.id}>
              <Link
                href={href(`/${tool.slug}`)}
                className="group card flex h-full flex-col gap-3 p-5 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-line-strong"
              >
                <div className="flex items-start justify-between">
                  <ToolIcon tool={tool} />
                  {tool.isNew && (
                    <span className="rounded-full bg-[color-mix(in_oklab,var(--brand)_12%,transparent)] px-2 py-0.5 text-[12px] font-semibold text-brand">
                      {t("home.new")}
                    </span>
                  )}
                </div>
                <div>
                  <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{t(`tool.${tool.id}.name`)}</h3>
                  <p className="mt-1 text-[15px] leading-snug text-muted">{t(`tool.${tool.id}.desc`)}</p>
                </div>
                <p className="mt-auto flex items-center gap-1.5 pt-1 text-[13px] text-muted">
                  {tool.runtime === "browser" ? <Laptop size={14} /> : <Server size={14} />}
                  {tool.runtime === "browser" ? t("home.privateBadge") : t("home.serverBadge")}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
