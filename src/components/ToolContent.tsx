// The long-form part of a tool page, under the workspace: how to use the
// tool, what it does, why the files stay private and common questions, plus
// the same content as structured data. Server-rendered and below the fold,
// so it adds words for readers and search engines without moving anything
// people see first.
import { ShieldCheck, Server } from "lucide-react";
import { format, type Dict, type DictKey } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { BRAND } from "@/lib/brand";
import { LIMITS, type Tool } from "@/lib/tools";
import { toolJsonLd, type ToolContent as Content } from "@/lib/seo";

const VARS = { brand: BRAND.name, files: LIMITS.files, mb: LIMITS.mb };

// One of a tool's own texts (tool.{id}.{part}), with its placeholders filled.
export function toolText(t: Dict, tool: Tool, part: string) {
  return format(t[`tool.${tool.id}.${part}` as DictKey] ?? "", VARS);
}

// Texts that exist for this tool, in order: step1…, q1…
function numbered(t: Dict, tool: Tool, part: string) {
  const out: string[] = [];
  for (let n = 1; t[`tool.${tool.id}.${part}${n}` as DictKey] !== undefined; n++) out.push(toolText(t, tool, `${part}${n}`));
  return out;
}

// The written content describes the tool as the free static site runs it:
// in the browser. A tool that the server build runs on its server gets the
// general steps and the server's privacy note, and no questions, since those
// answers are about the in-browser version.
function contentOf(t: Dict, tool: Tool) {
  const name = toolText(t, tool, "name");
  const onServer = tool.runtime === "server";
  const questions = numbered(t, tool, "q");
  const answers = numbered(t, tool, "a");
  const content: Content = {
    name,
    description: toolText(t, tool, "meta"),
    howTo: format(t["tp.howTo"], { name }),
    steps: onServer ? [t["guide.step1"], t["guide.step2"], t["guide.step3"]] : numbered(t, tool, "step"),
    faq: onServer ? [] : questions.map((q, i) => ({ q, a: answers[i] ?? "" })),
  };
  return { ...content, intro: toolText(t, tool, "intro"), privacy: onServer ? t["tp.privateServer"] : toolText(t, tool, "private"), onServer };
}

export function ToolContent({ tool, t, lang }: { tool: Tool; t: Dict; lang: Locale }) {
  const c = contentOf(t, tool);
  const Badge = c.onServer ? Server : ShieldCheck;
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: toolJsonLd({ lang, slug: tool.slug, home: t["nav.allTools"], content: c }) }} />

      <h2 className="reveal mb-6 display text-[1.4rem] sm:text-[1.6rem]">{c.howTo}</h2>
      <ol className="reveal grid border-y border-line sm:grid-cols-3">
        {c.steps.map((s, i) => (
          <li key={i} className="flex flex-col gap-2 border-line py-6 not-first:border-t sm:px-6 sm:not-first:border-s sm:not-first:border-t-0 sm:first:ps-0">
            <span className="font-mono text-[1.6rem] leading-none text-accent">{String(i + 1).padStart(2, "0")}</span>
            <span className="text-pretty text-[15px] leading-relaxed text-ink-2">{s}</span>
          </li>
        ))}
      </ol>

      <div className="mt-14 grid gap-10 md:grid-cols-[3fr_2fr]">
        <section>
          <h2 className="display text-[1.4rem] sm:text-[1.6rem]">{format(t["tp.about"], { name: c.name })}</h2>
          <p className="mt-3 max-w-[64ch] text-pretty text-[16px] leading-relaxed text-ink-2">{c.intro}</p>
        </section>
        <section className="reveal fold card relative self-start p-6 shadow-card">
          <span aria-hidden className="tape -top-3 start-6 -rotate-3" />
          <h2 className="flex items-center gap-2 text-[16px] font-medium tracking-[-0.01em]">
            <Badge size={16} strokeWidth={1.75} className={c.onServer ? "text-muted" : "text-success"} aria-hidden />
            {t["tp.private"]}
          </h2>
          <p className="mt-2 text-pretty text-[15px] leading-relaxed text-ink-2">{c.privacy}</p>
        </section>
      </div>

      {c.faq.length > 0 && (
        <section className="mt-14">
          <h2 className="display text-[1.4rem] sm:text-[1.6rem]">{format(t["tp.faq"], { name: c.name })}</h2>
          <dl className="mt-4 divide-y divide-line border-y border-line">
            {c.faq.map(({ q, a }) => (
              <div key={q} className="reveal py-6">
                <dt className="text-[16px] font-medium tracking-[-0.01em]">{q}</dt>
                <dd className="mt-2 max-w-[64ch] text-pretty text-[15px] leading-relaxed text-ink-2">{a}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </>
  );
}
