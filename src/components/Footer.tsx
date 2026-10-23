"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import { Logo } from "./Logo";
import { useI18n } from "./I18n";
import { BRAND, OPERATOR } from "@/lib/brand";
import { REPO_URL, STATIC } from "@/lib/mode";

const noop = () => () => {};

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export function Footer() {
  const { t, href } = useI18n();
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [hint, setHint] = useState(false);
  const year = useSyncExternalStore(noop, () => new Date().getFullYear(), () => null);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  const doInstall = async () => {
    if (install) {
      await install.prompt();
      setInstall(null);
    } else setHint(true);
  };

  // The static build has no contact form: Contact is the operator's address
  // (src/lib/brand.ts), or the repository's issues until that is set.
  const contact = STATIC ? OPERATOR.contactHref || (REPO_URL ? `${REPO_URL}/issues` : null) : "/contact";
  const company: [string, string][] = [[t("foot.about"), "/about"], [t("foot.security"), "/security"]];
  if (contact) company.push([t("foot.contact"), contact]);
  if (REPO_URL) company.push([t("foot.source"), REPO_URL]);
  const cols: { title: string; links: [string, string][] }[] = [
    { title: t("foot.product"), links: [[t("nav.allTools"), "/"], [t("nav.workflows"), "/workflows"], [t("foot.features"), "/features"]] },
    { title: t("foot.company"), links: company },
    { title: t("foot.help"), links: [[t("foot.faq"), "/faq"], [t("foot.guide"), "/guide"]] },
    { title: t("foot.legal"), links: [[t("foot.privacy"), "/privacy"], [t("foot.terms"), "/terms"], [t("foot.cookies"), "/cookies"], [t("foot.licenses"), "/licenses"]] },
  ];

  return (
    <footer className="mt-32 overflow-hidden border-t border-line">
      <div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-x-6 gap-y-10 px-4 pb-10 pt-16 sm:px-6 md:grid-cols-[1.6fr_repeat(4,1fr)]">
        <div className="col-span-2 md:col-span-1">
          <Link href={href("/")} className="inline-block rounded-md" aria-label={t("nav.home")}><Logo /></Link>
          <p className="mt-4 max-w-[280px] text-pretty font-display text-[1.35rem] leading-snug text-ink-2">{BRAND.tagline}</p>
          <button onClick={doInstall} className="btn btn-quiet btn-sm mt-6">
            <Download size={15} strokeWidth={1.75} /> {t("foot.install")}
          </button>
          {hint && <p className="rise mt-2 max-w-[260px] text-[13px] text-muted">{t("install.manual")}</p>}
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="eyebrow mb-4">{c.title}</p>
            <ul className="space-y-2.5">
              {c.links.map(([label, path]) => (
                <li key={path}>
                  {/^(https?|mailto):/.test(path) ? (
                    <a href={path} className="link-u text-[14px] text-ink-2 transition-colors hover:text-ink">{label}</a>
                  ) : (
                    <Link href={href(path)} className="link-u text-[14px] text-ink-2 transition-colors hover:text-ink">{label}</Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto flex max-w-[1240px] items-end justify-between gap-6 px-4 sm:px-6">
        <p className="eyebrow pb-6">{t("foot.rights", { year: year ?? "", brand: BRAND.name })}</p>
      </div>
      <p aria-hidden className="wordmark select-none whitespace-nowrap text-center serif text-[clamp(6rem,24vw,22rem)] leading-[0.72] tracking-[-0.04em] text-ink/[0.07]">
        {BRAND.name}
      </p>
    </footer>
  );
}
