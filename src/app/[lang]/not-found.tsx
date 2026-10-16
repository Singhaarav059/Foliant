"use client";

import Link from "next/link";
import { useI18n } from "@/components/I18n";

export default function NotFound() {
  const { t, href } = useI18n();
  return (
    <div className="mx-auto max-w-[520px] px-4 py-24 text-center">
      <p className="tabular text-[56px] font-bold tracking-[-0.04em] text-line-strong">404</p>
      <h1 className="mt-2 text-[1.6rem] font-bold">{t("nf.title")}</h1>
      <p className="mt-2 text-muted">{t("nf.body")}</p>
      <Link href={href("/")} className="btn btn-primary mt-6">{t("nf.home")}</Link>
    </div>
  );
}
