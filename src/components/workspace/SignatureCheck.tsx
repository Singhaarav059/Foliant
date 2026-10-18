"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useI18n } from "../I18n";
import type { SignatureReport } from "@/lib/pdf/sign";

// Loads the checking code ahead of use (src/lib/offline.ts).
export const prepareCheck = () => import("@/lib/pdf/sign");

// Every signature in the file: whether the bytes it covers are unchanged and
// match the signer's certificate, who signed, and whether anything was saved
// after it. A file that can't be read goes to onError, never to "no signatures".
export function SignatureCheck({ file, onError }: { file: File; onError: (e: unknown) => void }) {
  const { t, locale } = useI18n();
  const [reports, setReports] = useState<SignatureReport[] | null>(null);
  const failed = useRef(onError);
  useEffect(() => {
    failed.current = onError;
  });

  useEffect(() => {
    let live = true;
    prepareCheck()
      .then(async ({ checkSignatures }) => checkSignatures(new Uint8Array(await file.arrayBuffer())))
      .then((r) => live && setReports(r), (e) => live && failed.current(e));
    return () => {
      live = false;
    };
  }, [file]);

  const day = (d: Date) => d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
  const time = (d: Date) => d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  if (!reports) {
    return <p className="flex items-center justify-center gap-2 text-muted"><Loader2 size={18} className="animate-spin" /> {t("check.checking")}</p>;
  }
  const note = <p className="mx-auto max-w-[640px] text-center text-[13px] text-muted">{t("check.trustNote")}</p>;
  if (!reports.length) {
    return (
      <div className="space-y-4">
        <div className="card mx-auto max-w-[640px] p-6 text-center" role="status">
          <ShieldQuestion size={28} className="mx-auto text-muted" />
          <p className="mt-2 text-[16px] font-semibold">{t("check.none")}</p>
          <p className="mt-1 text-[14px] text-muted">{t("check.noneHint")}</p>
        </div>
        {note}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[720px] space-y-4">
      <p className="text-[14px] text-muted" role="status">{t("check.found", { n: reports.length })}</p>
      {reports.map((r) => {
        const good = r.status === "valid";
        const bad = r.status === "modified" || r.status === "invalid";
        const Icon = good ? ShieldCheck : bad ? ShieldAlert : ShieldQuestion;
        const tone = good ? "text-success" : bad ? "text-danger" : "text-muted";
        const s = r.signer;
        const outOfDate = s && r.signedAt && (r.signedAt < s.notBefore || r.signedAt > s.notAfter);
        const rows: [string, React.ReactNode][] = [];
        if (s) {
          rows.push([t("check.signer"), [s.name, s.organization && s.organization !== s.name ? s.organization : "", s.email ?? ""].filter(Boolean).join(" · ")]);
          rows.push([t("check.issuer"), s.selfSigned ? t("check.selfSigned") : s.issuer]);
          rows.push([t("check.validity"), t("check.validityRange", { from: day(s.notBefore), to: day(s.notAfter) })]);
        }
        if (r.signedAt) rows.push([t("check.signedAt"), time(r.signedAt)]);
        if (r.reason) rows.push([t("check.reason"), r.reason]);
        if (r.location) rows.push([t("check.location"), r.location]);
        rows.push([t("check.format"), r.pades ? `PAdES (${r.subFilter})` : r.subFilter || "—"]);
        rows.push([t("check.timestamp"), t(r.timestamped ? "check.timestampYes" : "check.timestampNo")]);
        return (
          <article key={r.revision} className="card p-5" aria-labelledby={`sig-${r.revision}`}>
            <header className="flex items-start gap-3">
              <Icon size={24} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden />
              <div className="min-w-0">
                <h3 id={`sig-${r.revision}`} className={`text-[16px] font-semibold ${tone}`}>{t(`check.status.${r.status}`)}</h3>
                <p className="text-[13px] text-muted">
                  {t(r.kind === "timestamp" ? "check.timestampN" : "check.signatureN", { n: r.revision })}{r.field ? ` · ${r.field}` : ""}
                </p>
              </div>
            </header>
            <p className="mt-3 text-[14px] text-ink-2">{t(`check.hint.${r.status}`)}</p>
            {r.status !== "malformed" && (
              <p className={`mt-2 text-[14px] ${r.wholeFile ? "text-ink-2" : "font-medium text-danger"}`}>
                {r.wholeFile ? t("check.wholeFile") : r.laterSignatures ? t("check.laterSigned", { n: r.laterSignatures }) : t("check.changedAfter")}
              </p>
            )}
            {outOfDate && <p className="mt-2 text-[14px] text-danger">{t("check.certOutOfDate")}</p>}
            <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-1 text-[14px] sm:grid-cols-[max-content_1fr]">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="mb-1.5 min-w-0 break-words sm:mb-0">{v}</dd>
                </div>
              ))}
            </dl>
          </article>
        );
      })}
      {note}
    </div>
  );
}
