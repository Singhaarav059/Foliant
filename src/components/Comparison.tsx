import Link from "next/link";
import { format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import { COMPARISON, type Competitor } from "@/lib/comparison";
import { LIMITS, TOOLS } from "@/lib/tools";
import { STATIC } from "@/lib/mode";
import { BRAND } from "@/lib/brand";

// The home page's "free here, and elsewhere" table: this site's limits, then
// other sites' free tiers as their own pages state them, each with its source
// and the date it was checked (src/lib/comparison.ts). Text only, no logos.
function limitText(c: Competitor, t: Dict) {
  const l = c.limit;
  switch (l.kind) {
    case "mbFiles":
      return l.files === 1 ? format(t["vs.mbFile"], { mb: l.mb }) : format(t["vs.mbFiles"], { mb: l.mb, files: l.files });
    case "mbFilesPages":
      return format(t["vs.mbFilePages"], { mb: l.mb, pages: l.pages });
    case "pagesMbHour":
      return format(t["vs.pagesMbHour"], { pages: l.pages, mb: l.mb, tasks: l.tasks });
    case "dailyDownloads":
      return t["vs.dailyDownloads"];
    case "noLimitsAds":
      return t["vs.noLimitsAds"];
  }
}

function whereText(c: Competitor, t: Dict) {
  if (c.where.kind === "notChecked") return t["vs.notChecked"];
  return c.where.hours ? format(t["vs.serversHours"], { hours: c.where.hours }) : t["vs.servers"];
}

export function Comparison({ t, lang }: { t: Dict; lang: string }) {
  const local = TOOLS.filter((x) => x.runtime === "browser").length;
  const cell = "px-3 py-3 align-top";
  const link = "underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink";
  return (
    <section data-comparison aria-labelledby="comparison" className="mt-16 grid gap-6 border-t border-line pt-12 lg:grid-cols-[200px_1fr] lg:gap-x-12">
      <div>
        <h2 id="comparison" className="eyebrow">{t["vs.title"]}</h2>
      </div>
      <div className="min-w-0">
        <p className="max-w-[60ch] text-pretty text-[15px] leading-relaxed text-muted">{t["vs.subtitle"]}</p>
        {/* Wide on phones: the table scrolls inside its own box, not the page. */}
        <div className="mt-6 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[720px] border-collapse text-start text-[14px]">
            <thead className="bg-surface text-[13px] text-muted">
              <tr>
                {(["vs.service", "vs.tool", "vs.limit", "vs.files", "vs.source", "vs.checked"] as const).map((k) => (
                  <th key={k} scope="col" className={`${cell} text-start font-medium`}>{t[k]}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr data-own className="bg-surface">
                <th scope="row" className={`${cell} text-start font-medium`}>{BRAND.name}</th>
                <td className={cell}>{t["vs.allTools"]}</td>
                <td className={cell}>{format(t["vs.ours"], { mb: LIMITS.mb, files: LIMITS.files })}</td>
                <td className={cell}>{STATIC ? t["vs.oursDevice"] : format(t["vs.oursMostly"], { local, total: TOOLS.length })}</td>
                <td className={cell}><Link href={`/${lang}/security#check`} className={link}>{t["vs.oursCheck"]}</Link></td>
                <td className={`${cell} text-muted`}>{t["vs.live"]}</td>
              </tr>
              {COMPARISON.map((c) => (
                <tr key={`${c.service}:${c.tool ?? "all"}`} data-competitor={c.service}>
                  <th scope="row" className={`${cell} text-start font-medium`}>{c.service}</th>
                  <td className={cell}>{c.tool ? t[`tool.${c.tool}.name` as DictKey] : t["vs.allTools"]}</td>
                  <td className={cell}>{limitText(c, t)}</td>
                  <td className={`${cell} text-ink-2`}>{whereText(c, t)}</td>
                  <td className={cell}>
                    <a href={c.source} rel="noopener noreferrer nofollow" className={`${link} whitespace-nowrap`}>{new URL(c.source).hostname.replace(/^www\./, "")}</a>
                  </td>
                  <td className={`${cell} tabular whitespace-nowrap text-muted`}><time dateTime={c.checked}>{c.checked}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 max-w-[70ch] text-pretty text-[13px] leading-relaxed text-muted">{t["vs.note"]}</p>
      </div>
    </section>
  );
}
