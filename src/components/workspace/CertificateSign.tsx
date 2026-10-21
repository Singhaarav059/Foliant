"use client";

import { useRef, useState } from "react";
import { BadgeCheck, ChevronDown, FileKey, Loader2, X } from "lucide-react";
import { useI18n } from "../I18n";
import type { CertInfo, Signer } from "@/lib/pdf/sign";

// Loads the signing code ahead of use (prepareEditor, src/lib/offline.ts).
// Opening a certificate and signing go through this too, so they get the same chunks.
export const prepareCertificate = () => Promise.all([import("@/lib/pdf/p12"), import("@/lib/pdf/sign")]);

export type CertChoice = { signer: Signer; info: CertInfo; reason: string; location: string };

const ERRORS = ["not_p12", "wrong_password", "no_key", "no_certificate", "unsupported_key"];

// Signing with your own certificate, on top of (or instead of) a drawn
// signature. The file and password live in this component's state only until
// the certificate is opened; after that only the non-extractable key is held,
// in memory, for as long as the editor is open. Nothing is stored.
export function CertificateSign({ value, onChange }: { value: CertChoice | null; onChange: (c: CertChoice | null) => void }) {
  const { t, locale } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const date = (d: Date) => d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });

  const open = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const [{ openCertificate }] = await prepareCertificate();
      const c = await openCertificate(new Uint8Array(await file.arrayBuffer()), password);
      onChange({ signer: { key: c.key, chain: c.chain }, info: c.info, reason: "", location: "" });
      setFile(null);
      setPassword("");
      if (input.current) input.current.value = "";
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      setError(t(`cert.err.${ERRORS.includes(code) ? code : "unknown"}`));
    } finally {
      setBusy(false);
    }
  };

  const now = new Date();
  return (
    // Closed by default, so the side panel stays short enough to stay in view.
    <details className="group border-t border-line pt-4">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[15px] font-semibold [&::-webkit-details-marker]:hidden">
        {t("cert.title")} <ChevronDown size={18} aria-hidden className="text-muted transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 space-y-3">
      {value ? (
        <>
          <div className="rounded-xl bg-surface-2 p-3 text-[14px]">
            <p className="flex items-center gap-2 font-medium"><BadgeCheck size={16} className="shrink-0 text-success" /> {t("cert.signingAs", { name: value.info.name })}</p>
            <p className="mt-1 text-[13px] text-muted">
              {value.info.selfSigned ? t("cert.selfSigned", { date: date(value.info.notAfter) }) : t("cert.issuedBy", { issuer: value.info.issuer, date: date(value.info.notAfter) })}
            </p>
            {(value.info.notAfter < now || value.info.notBefore > now) && (
              <p className="mt-1 text-[13px] text-danger">{t("cert.outOfDate", { from: date(value.info.notBefore), to: date(value.info.notAfter) })}</p>
            )}
            <button className="btn btn-quiet btn-sm mt-2" onClick={() => onChange(null)}><X size={15} /> {t("cert.remove")}</button>
          </div>
          <input className="field h-11" value={value.reason} aria-label={t("cert.reason")} placeholder={t("cert.reason")}
            onChange={(e) => onChange({ ...value, reason: e.target.value })} />
          <input className="field h-11" value={value.location} aria-label={t("cert.location")} placeholder={t("cert.location")}
            onChange={(e) => onChange({ ...value, location: e.target.value })} />
        </>
      ) : (
        <>
          <p className="text-[13px] text-muted">{t("cert.intro")}</p>
          <input ref={input} type="file" hidden accept=".p12,.pfx,application/x-pkcs12" aria-label={t("cert.choose")}
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} />
          <button className="btn btn-quiet w-full justify-start" onClick={() => input.current?.click()}>
            <FileKey size={18} /> <span className="min-w-0 truncate">{file ? file.name : t("cert.choose")}</span>
          </button>
          {file && (
            <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); void open(); }}>
              <input type="password" className="field h-11 min-w-0" value={password} autoComplete="off" autoFocus
                aria-label={t("cert.password")} placeholder={t("cert.password")} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn btn-quiet w-full" disabled={busy}>
                {busy && <Loader2 size={16} className="animate-spin" />} {t("cert.open")}
              </button>
            </form>
          )}
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        </>
      )}
      <p className="text-[13px] text-muted">{t("cert.private")}</p>
      <p className="text-[13px] text-muted">{t("cert.noTimestamp")}</p>
      </div>
    </details>
  );
}
