"use client";

import Link from "next/link";
import { useCallback } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { useI18n } from "../I18n";
import { reportUrl, toPdfError, type ErrorCode } from "@/lib/pdf/errors";
import { REPO_URL, STATIC } from "@/lib/mode";

// What the user sees: a sentence in their language, the file it's about, and
// the tool that can fix it.
type Fix = "unlock" | "repair" | "ocr";
export type Problem = { text: string; file?: string; fix?: Fix; code?: ErrorCode; detail?: string };

const MESSAGES: Record<ErrorCode, [key: string, fix?: Fix]> = {
  not_pdf: ["err.notPdf"],
  damaged: ["err.damaged", "repair"],
  unrecoverable: ["err.unrecoverable"],
  encrypted: ["err.encrypted", "unlock"],
  wrong_password: ["ws.wrongPassword"],
  already_encrypted: ["err.alreadyEncrypted", "unlock"],
  password_too_long: ["err.passwordTooLong"],
  protect_unverified: ["ws.protectUnverified"],
  redaction_leak: ["ws.redactionLeak"],
  no_pages: ["err.noPages"],
  image_unsupported: ["err.imageUnsupported"],
  page_too_large: ["err.pageTooLarge"],
  out_of_memory: ["err.outOfMemory"],
  no_text: ["err.noText", "ocr"],
  no_images: ["err.noImages"],
  bad_ranges: ["err.badRanges"],
  empty_document: ["err.emptyDocument"],
  missing_image: ["err.missingImage"],
  download_failed: ["err.download"],
  office_isolation: ["ws.officeReload"],
  office_memory: ["ws.officeMemory"],
  office_stalled: ["ws.officeStalled"],
  // The server's own message is shown; this only covers one without it.
  server: ["err.unknown"],
  network: ["err.network"],
  unknown: ["err.unknown"],
};

const FIXES: Record<Fix, { path: string; tool: string }> = {
  unlock: { path: "/unlock-pdf", tool: "unlock" },
  repair: { path: "/repair-pdf", tool: "repair" },
  ocr: { path: "/ocr-pdf", tool: "ocr" },
};

// Failures that may be ours rather than the file's, so worth a report.
const REPORTABLE = new Set<ErrorCode>(["damaged", "unrecoverable", "no_pages", "page_too_large", "out_of_memory", "protect_unverified", "redaction_leak", "unknown"]);

// Turns anything thrown into a Problem.
export function useProblem() {
  const { t } = useI18n();
  return useCallback((e: unknown, fileName?: string): Problem => {
    const err = toPdfError(e, fileName);
    const [key, fix] = MESSAGES[err.code];
    // Unexpected failures keep their own text, folded away, for bug reports.
    const cause = err.cause ?? e;
    const raw = (cause as { message?: unknown })?.message ?? cause;
    // Protect's too-long password says how many characters would fit.
    const max = (e as { max?: unknown })?.max;
    const text = err.text || (err.code === "password_too_long" && typeof max === "number" ? t("ws.passwordTooLong", { max }) : t(key));
    return { text, file: err.fileName || undefined, fix, code: err.code, detail: err.code === "unknown" ? String(raw).slice(0, 400) : undefined };
  }, [t]);
}

export function ErrorBox({ problem, toolId, className = "mx-auto mb-5 max-w-[760px]" }: { problem: Problem; toolId?: string; className?: string }) {
  const { t, href } = useI18n();
  // No link to the tool the user is already in.
  const fix = problem.fix && FIXES[problem.fix].tool !== toolId ? FIXES[problem.fix] : null;
  const report = problem.code && REPORTABLE.has(problem.code)
    ? REPO_URL
      ? reportUrl(REPO_URL, { tool: toolId ?? "workflow", code: problem.code, browser: typeof navigator === "undefined" ? "" : navigator.userAgent })
      : STATIC ? null : href("/contact")
    : null;
  return (
    <div role="alert" className={`rise flex items-start gap-3 rounded-xl border border-[color-mix(in_oklab,var(--danger)_30%,var(--line))] bg-[color-mix(in_oklab,var(--danger)_5%,var(--surface))] p-4 text-[15px] ${className}`}>
      <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        {problem.file && <p className="truncate font-medium"><bdi>{problem.file}</bdi></p>}
        <p>{problem.text}</p>
        {problem.detail && (
          <details className="mt-2 text-[13px] text-muted">
            <summary className="cursor-pointer">{t("err.details")}</summary>
            <p className="mt-1 break-words font-mono">{problem.detail}</p>
          </details>
        )}
        {report && (
          <a href={report} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-[13px] text-muted underline decoration-line-strong underline-offset-4 hover:text-ink">
            {t("err.report")}
          </a>
        )}
      </div>
      {fix && (
        <Link href={href(fix.path)} className="flex shrink-0 items-center gap-1 font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          {t(`tool.${fix.tool}.name`)} <ArrowRight size={15} className="rtl:rotate-180" />
        </Link>
      )}
    </div>
  );
}
