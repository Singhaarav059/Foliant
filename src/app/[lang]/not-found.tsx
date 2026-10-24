"use client";

import Link from "next/link";
import { useI18n } from "@/components/I18n";

export default function NotFound() {
  const { t, href } = useI18n();
  return (
    <div className="mx-auto max-w-[520px] px-4 py-24 text-center">
      <p className="rise text-[8rem] font-semibold leading-none tracking-[-0.06em] text-accent tabular">404</p>
      <h1 className="display mt-2 text-[3rem] sm:text-[4.5rem]">{t("nf.title")}</h1>
      <p className="mt-4 text-muted">{t("nf.body")}</p>
      <Link href={href("/")} className="btn btn-primary mt-8">{t("nf.home")}</Link>
    </div>
  );
}
