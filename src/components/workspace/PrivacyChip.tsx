"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { useI18n } from "../I18n";
import { serverSnapshot, snapshot, subscribe } from "@/lib/egress";
import { humanSize } from "@/lib/pdf/common";

// A live count of what this page has sent off the device (src/lib/egress.ts),
// linking to how to check it yourself. The data attributes are for tests.
export function PrivacyChip() {
  const { t, href } = useI18n();
  const e = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const clean = e.sent === 0 && e.offsite === 0;
  const Icon = clean ? ShieldCheck : ShieldAlert;
  return (
    <Link href={`${href("/security")}#check`} title={t(e.worker ? "privacy.how" : "privacy.howPage")}
      data-privacy-chip data-sent={e.sent} data-offsite={e.offsite} data-blocked={e.blocked}
      className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink">
      <Icon size={14} strokeWidth={1.75} className={clean ? "text-success" : ""} aria-hidden />
      <span aria-live="polite">
        {/* Uploads are only measured with the service worker running. */}
        {!e.worker ? t("privacy.offsite", { n: e.offsite }) : e.sent === 0 ? t("privacy.zero") : t("privacy.sent", { size: humanSize(e.sent) })}
        {e.worker && e.offsite > 0 && <> · {t("privacy.offsite", { n: e.offsite })}</>}
        {e.blocked > 0 && <> · {t("privacy.blocked", { n: e.blocked })}</>}
      </span>
      <span aria-hidden className="text-line-strong">·</span>
      <span className="underline decoration-line-strong underline-offset-2">{t("privacy.check")}</span>
    </Link>
  );
}
