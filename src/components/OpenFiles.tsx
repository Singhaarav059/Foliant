"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Upload } from "lucide-react";
import { useI18n } from "./I18n";
import { ToolIcon } from "./ToolIcon";
import { handOffTo, stashShared, takeShared, toolsFor } from "@/lib/handoff";
import { hasLocale } from "@/lib/i18n/locales";
import { BRAND } from "@/lib/brand";
import type { Tool } from "@/lib/tools";

// What Chrome hands an installed app opened from a file ("Open with"), per
// the manifest's file_handlers.
type LaunchParams = { files: readonly FileSystemHandle[] };
declare global {
  interface Window {
    launchQueue?: { setConsumer(consumer: (params: LaunchParams) => void): void };
  }
}

const ACCEPT = ".pdf,image/*,.heic,.docx";

function lastLocale() {
  try {
    return localStorage.getItem("locale");
  } catch {
    return null;
  }
}

// /{lang}/open: files shared to the installed app (the service worker keeps
// them, see public/sw.js) or opened with it, and the tools that take them.
// Picking one hands the files over (src/lib/handoff.ts).
export function OpenFiles() {
  const { t, locale, href } = useI18n();
  const router = useRouter();
  const [files, setFiles] = useState<File[] | null>(null);
  // The language used last, read before this page remembers its own.
  const [saved] = useState(lastLocale);
  const tools = useMemo(() => toolsFor(files ?? []), [files]);

  useEffect(() => {
    let live = true;
    const arrive = async (incoming: File[]) => {
      if (!live || !incoming.length) return;
      // "Open with" always lands on /en/open: follow the visitor's language.
      if (saved && saved !== locale && hasLocale(saved)) {
        live = false;
        await stashShared(incoming);
        try {
          localStorage.setItem("locale", saved);
        } catch {
          /* storage blocked */
        }
        location.replace(`/${saved}/open`);
        return;
      }
      setFiles(incoming);
    };
    void takeShared().then((shared) => (shared.length ? arrive(shared) : live && setFiles((f) => f ?? [])));
    window.launchQueue?.setConsumer((params) => {
      const handles = params.files.filter((h): h is FileSystemFileHandle => h.kind === "file");
      void Promise.all(handles.map((h) => h.getFile())).then(arrive);
    });
    return () => {
      live = false;
    };
  }, [locale, saved]);

  const open = async (tool: Tool) => {
    if (!files) return;
    await handOffTo(tool.id, files);
    router.push(href(`/${tool.slug}`));
  };

  const size = new Intl.NumberFormat(locale, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });

  return (
    <div className="mx-auto max-w-[860px] px-4 pb-10 pt-12 sm:px-6 sm:pt-16">
      <h1 className="text-balance text-[2.4rem] font-semibold leading-[1.05] tracking-[-0.04em] sm:text-[3rem]">{t("open.title")}</h1>
      <p className="mt-4 max-w-[560px] text-pretty text-[17px] leading-relaxed text-ink-2">{t("open.subtitle")}</p>

      <div className="mt-10">
        {files?.length ? (
          <ul aria-label={t("open.files")} className="divide-y divide-line border-y border-line">
            {files.map((f, i) => (
              <li key={`${i}:${f.name}`} className="flex items-center gap-3 py-3">
                <FileText size={18} strokeWidth={1.5} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{f.name}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-muted">{size.format(f.size / 1024 / 1024)}</span>
              </li>
            ))}
          </ul>
        ) : (
          files && <p className="text-pretty text-[15px] text-ink-2">{t("open.empty", { brand: BRAND.name })}</p>
        )}
        <label className="btn btn-quiet btn-sm mt-4 inline-flex cursor-pointer">
          <Upload size={15} aria-hidden /> {t("ws.select")}
          <input
            type="file"
            multiple
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              if (picked.length) setFiles(picked);
              e.target.value = "";
            }}
          />
        </label>
      </div>

      {!!files?.length && (
        <section className="mt-12">
          <h2 className="eyebrow mb-3">{t("open.tools")}</h2>
          {tools.length ? (
            <ul aria-label={t("open.tools")} className="grid gap-2 sm:grid-cols-2">
              {tools.map((tool) => (
                <li key={tool.id}>
                  <a
                    href={href(`/${tool.slug}`)}
                    onClick={(e) => {
                      e.preventDefault();
                      void open(tool);
                    }}
                    className="group card flex items-center gap-3 p-3 transition-colors hover:border-line-strong"
                  >
                    <ToolIcon tool={tool} size={32} />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{t(`tool.${tool.id}.name`)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-pretty text-[15px] text-ink-2">{t("open.noTool")}</p>
          )}
        </section>
      )}
    </div>
  );
}
