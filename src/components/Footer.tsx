"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Download } from "lucide-react";
import { Logo } from "./Logo";
import { useI18n } from "./I18n";
import { BRAND } from "@/lib/brand";

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

  const cols: { title: string; links: [string, string][] }[] = [
    { title: t("foot.product"), links: [[t("nav.allTools"), "/"], [t("nav.workflows"), "/workflows"], [t("foot.features"), "/features"]] },
    { title: t("foot.company"), links: [[t("foot.about"), "/about"], [t("foot.security"), "/security"], [t("foot.contact"), "/contact"]] },
    { title: t("foot.help"), links: [[t("foot.faq"), "/faq"], [t("foot.guide"), "/guide"]] },
    { title: t("foot.legal"), links: [[t("foot.privacy"), "/privacy"], [t("foot.terms"), "/terms"], [t("foot.cookies"), "/cookies"]] },
  ];

  return (
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="mx-auto grid max-w-[1240px] gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.3fr_repeat(4,1fr)]">
        <div>
          <Logo />
          <p className="mt-3 max-w-[260px] text-[15px] text-muted">{BRAND.tagline}</p>
          <button onClick={doInstall} className="btn btn-quiet btn-sm mt-5">
            <Download size={16} /> {t("foot.install")}
          </button>
          {hint && <p className="mt-2 max-w-[260px] text-[13px] text-muted">{t("install.manual")}</p>}
        </div>
        {cols.map((c) => (
          <div key={c.title}>
            <p className="mb-3 text-[13px] font-semibold text-ink">{c.title}</p>
            <ul className="space-y-2">
              {c.links.map(([label, path]) => (
                <li key={path}>
                  <Link href={href(path)} className="text-[15px] text-muted hover:text-ink">{label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-[1240px] px-4 py-5 text-[13px] text-muted sm:px-6">
          {t("foot.rights", { year: year ?? "", brand: BRAND.name })}
        </p>
      </div>
    </footer>
  );
}
