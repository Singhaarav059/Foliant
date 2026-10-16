import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldCheck, Zap, MonitorSmartphone, ArrowRight } from "lucide-react";
import { ToolGrid } from "@/components/ToolGrid";
import { getDictionary } from "@/lib/i18n/dictionary";
import { hasLocale } from "@/lib/i18n/locales";
import { TOOLS, categoryColor } from "@/lib/tools";

export default async function Home({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const t = await getDictionary(lang);
  const chain = ["merge", "compress", "pageNumbers", "protect"].map((id) => TOOLS.find((x) => x.id === id)!);

  return (
    <div className="mx-auto max-w-[1240px] px-4 sm:px-6">
      <section className="pb-10 pt-14 text-center sm:pb-14 sm:pt-20">
        <h1 className="mx-auto max-w-[820px] text-balance text-[2.25rem] font-bold leading-[1.08] tracking-[-0.035em] sm:text-[3.4rem]">
          {t["home.title"]}
        </h1>
        <p className="mx-auto mt-5 max-w-[640px] text-pretty text-[17px] leading-relaxed text-muted sm:text-[19px]">{t["home.subtitle"]}</p>
      </section>

      <ToolGrid />

      <section className="mt-20 grid items-center gap-8 rounded-[28px] border border-line bg-surface p-6 sm:p-10 lg:grid-cols-2">
        <div>
          <h2 className="text-balance text-[1.75rem] font-bold leading-tight tracking-[-0.025em]">{t["home.workflowsTitle"]}</h2>
          <p className="mt-3 max-w-[460px] text-[16px] text-muted">{t["home.workflowsBody"]}</p>
          <Link href={`/${lang}/workflows`} className="btn btn-primary mt-6">
            {t["home.workflowsCta"]} <ArrowRight size={17} className="rtl:rotate-180" />
          </Link>
        </div>
        <ol className="flex flex-wrap items-center gap-2" aria-label={t["nav.workflows"]}>
          {chain.map((tool, i) => (
            <li key={tool.id} className="flex items-center gap-2">
              <span className="rounded-full border px-3.5 py-2 text-[15px] font-medium"
                style={{ borderColor: categoryColor(tool.category), color: categoryColor(tool.category), background: `color-mix(in oklab, ${categoryColor(tool.category)} 8%, var(--surface))` }}>
                {t[`tool.${tool.id}.name` as keyof typeof t]}
              </span>
              {i < chain.length - 1 && <ArrowRight size={16} className="text-muted rtl:rotate-180" aria-hidden />}
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-20">
        <h2 className="mb-8 text-center text-[1.75rem] font-bold tracking-[-0.025em]">{t["home.whyTitle"]}</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {([
            [ShieldCheck, "#12a37f", "home.why1Title", "home.why1Body"],
            [Zap, "#e2662b", "home.why2Title", "home.why2Body"],
            [MonitorSmartphone, "#7b4fe0", "home.why3Title", "home.why3Body"],
          ] as const).map(([Icon, color, title, body]) => (
            <div key={title} className="card p-6">
              <Icon size={26} style={{ color }} strokeWidth={1.9} />
              <h3 className="mt-4 text-[17px] font-semibold">{t[title]}</h3>
              <p className="mt-1.5 text-[15px] text-muted">{t[body]}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
