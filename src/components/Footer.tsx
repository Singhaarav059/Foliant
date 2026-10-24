"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import { Logo } from "./Logo";
import { Friend } from "./Studio";
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
    <footer className="relative isolate mt-32 px-3 pb-3 sm:px-4 sm:pb-4">
      <div className="relative mx-auto max-w-[1400px] overflow-hidden rounded-[36px] bg-surface-2">
        <div className="mx-auto grid max-w-[1240px] grid-cols-2 gap-x-6 gap-y-10 px-6 pb-10 pt-16 sm:px-10 md:grid-cols-[1.6fr_repeat(4,1fr)]">
          <div className="col-span-2 md:col-span-1">
            <Link href={href("/")} className="inline-block rounded-full" aria-label={t("nav.home")}><Logo /></Link>
            <p className="mt-4 max-w-[280px] text-pretty text-[1.05rem] font-medium leading-snug tracking-[-0.01em] text-ink-2">{BRAND.tagline}</p>
            <button onClick={doInstall} className="btn btn-quiet btn-sm mt-6">
              <Download size={15} strokeWidth={1.75} /> {t("foot.install")}
            </button>
            {hint && <p className="rise mt-2 max-w-[260px] text-[13px] text-muted">{t("install.manual")}</p>}
          </div>
          {cols.map((c) => (
            <div key={c.title}>
              <p className="mb-4 text-[13px] font-semibold text-ink">{c.title}</p>
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
        <div className="mx-auto max-w-[1240px] px-6 sm:px-10">
          <p className="pb-4 text-[13px] text-ink-2">{t("foot.rights", { year: year ?? "", brand: BRAND.name })}</p>
        </div>
        {/* The wordmark, with the friend waving goodbye beside it: its own
            row, so it never sits on the links above. */}
        <div className="flex items-end justify-between gap-4 px-6 sm:px-10">
          {/* Drawn from a data attribute, so it's decoration, not faint text for contrast checks. */}
          <span
            aria-hidden
            data-text={BRAND.name}
            className="wordmark block min-w-0 select-none overflow-hidden whitespace-nowrap text-start text-[clamp(4.5rem,15vw,13rem)] font-bold leading-[0.78] tracking-[-0.07em] text-ink/[0.07] before:content-[attr(data-text)]"
          />
          <div aria-hidden data-cat="edit" className="mb-[-1.25rem] hidden w-[120px] shrink-0 md:block lg:w-[150px]">
            <Friend wave mood="happy" className="w-full" blinkDelay="-2s" />
          </div>
        </div>
      </div>
    </footer>
  );
}
