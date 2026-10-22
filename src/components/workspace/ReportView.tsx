"use client";

import { ClipboardCheck, TriangleAlert } from "lucide-react";
import { useI18n } from "../I18n";
import type { Output, PdfaCheckReport, RedactReport } from "@/lib/pdf/common";

// What a tool checked about its results (src/lib/pdf/common.ts Report): a
// redaction's verification, or the PDF/A check. A batch's redaction reports
// are added up into one.
export function ReportView({ outputs }: { outputs: Output[] }) {
  const redact = outputs.flatMap((o) => (o.report?.kind === "redact" ? [o.report] : []));
  const pdfa = outputs.flatMap((o) => (o.report?.kind === "pdfa" ? [{ name: o.name, report: o.report }] : []));
  if (!redact.length && !pdfa.length) return null;
  return (
    <>
      {redact.length > 0 && <Redaction reports={redact} />}
      {pdfa.length > 0 && <Pdfa list={pdfa} />}
    </>
  );
}

function Box({ ok, title, children }: { ok: boolean; title: string; children: React.ReactNode }) {
  return (
    <section data-report className="mx-auto mt-6 max-w-[560px] rounded-xl border border-line bg-surface p-4 text-start text-[14px]">
      <h3 className="mb-2 flex items-center gap-2 text-[15px] font-medium">
        {ok ? <ClipboardCheck size={17} className="text-success" /> : <TriangleAlert size={17} className="text-danger" />} {title}
      </h3>
      <ul className="list-disc space-y-1 ps-5 text-ink-2">{children}</ul>
    </section>
  );
}

function Redaction({ reports }: { reports: RedactReport[] }) {
  const { t } = useI18n();
  const sum = (k: "areas" | "pages" | "terms" | "ocrPages" | "annots" | "attachments") => reports.reduce((n, r) => n + r[k], 0);
  const ocrPages = sum("ocrPages");
  const ocrSkipped = reports.some((r) => r.ocrPages > 0 && r.terms > 0 && r.ocrLeft === null);
  const metadata = [...new Set(reports.flatMap((r) => r.metadata))];
  return (
    <Box ok title={t("res.reportTitle")}>
      <li>{t("res.redactAreas", { n: sum("areas"), pages: sum("pages") })}</li>
      <li>{sum("terms") ? t("res.redactTerms", { n: sum("terms") }) : t("res.redactNoTerms")}</li>
      {ocrPages > 0 && sum("terms") > 0 && <li>{ocrSkipped ? t("res.redactOcrSkipped") : t("res.redactOcr", { n: ocrPages })}</li>}
      {sum("annots") > 0 && <li>{t("res.redactAnnots", { n: sum("annots") })}</li>}
      {sum("attachments") > 0 && <li>{t("res.redactFiles", { n: sum("attachments") })}</li>}
      {metadata.length > 0 && <li>{t("res.redactMeta", { list: metadata.join(", ") })}</li>}
    </Box>
  );
}

function Pdfa({ list }: { list: { name: string; report: PdfaCheckReport }[] }) {
  const { t } = useI18n();
  const failed = list.filter((x) => x.report.issues.length);
  const issues = failed.reduce((n, x) => n + x.report.issues.length, 0);
  return (
    <Box ok={!issues} title={issues ? t("res.pdfaIssues", { n: issues }) : t("res.pdfaPassed", { n: list[0].report.checked })}>
      {failed.flatMap(({ name, report }) => report.issues.map((i, k) => (
        <li key={`${name}:${k}`}>
          {list.length > 1 && <span className="font-medium">{name}: </span>}
          {t("res.pdfaIssue", { clause: i.clause, what: t(`res.pdfaRule.${i.rule}`, { detail: i.detail ?? "" }) })}
        </li>
      )))}
      <li className="text-muted">{t("res.pdfaNote")}</li>
    </Box>
  );
}
