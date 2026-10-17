"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "./I18n";
import { useUser, postJson } from "./User";
import { ToolIcon } from "./ToolIcon";
import { TOOLS } from "@/lib/tools";

type Activity = { tool: string; fileName: string; createdAt: number };

export function Account() {
  const { t, href, locale } = useI18n();
  const { user, ready, setUser } = useUser();
  const router = useRouter();
  const [items, setItems] = useState<Activity[]>([]);
  const [pw, setPw] = useState<{ msg?: string; err?: string }>({});
  const [del, setDel] = useState({ open: false, text: "", password: "", err: "" });

  useEffect(() => {
    if (ready && !user) router.replace(href("/login"));
    if (user) fetch("/api/history").then((r) => r.json()).then((d) => setItems(d.items ?? [])).catch(() => {});
  }, [ready, user, router, href]);

  if (!user) return <div className="mx-auto h-64 max-w-[860px] animate-pulse px-4 pt-14" />;

  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="mx-auto max-w-[860px] space-y-6 px-4 pb-10 pt-12 sm:px-6">
      <h1 className="text-[2.25rem] font-semibold tracking-[-0.04em]">{t("acc.title")}</h1>

      <section className="card flex flex-wrap items-center gap-4 p-6">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-ink text-lg font-semibold text-bg">{(user.name || user.email)[0].toUpperCase()}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{user.name || user.email}</p>
          <p className="truncate text-[15px] text-muted">{user.email}</p>
        </div>
      </section>

      <section className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-medium tracking-[-0.01em]">{t("acc.history")}</h2>
          {items.length > 0 && (
            <button className="btn btn-quiet btn-sm" onClick={async () => { await postJson("/api/history", undefined, "DELETE"); setItems([]); }}>
              {t("acc.clearHistory")}
            </button>
          )}
        </div>
        {items.length === 0 ? <p className="text-[15px] text-muted">{t("acc.historyEmpty")}</p> : (
          <ul className="divide-y divide-line">
            {items.map((it, i) => {
              const tool = TOOLS.find((x) => x.id === it.tool);
              return (
                <li key={i} className="flex items-center gap-3 py-2.5">
                  {tool && <ToolIcon tool={tool} size={32} />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px]">{it.fileName || "—"}</p>
                    <p className="text-[13px] text-muted">{tool ? t(`tool.${tool.id}.name`) : it.tool}</p>
                  </div>
                  <time className="tabular shrink-0 text-[13px] text-muted">{fmt.format(it.createdAt)}</time>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card p-6">
        <h2 className="mb-4 text-[16px] font-medium tracking-[-0.01em]">{t("acc.changePassword")}</h2>
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]" onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            await postJson("/api/auth/password", { current: f.get("current"), next: f.get("next") });
            setPw({ msg: t("acc.saved") });
            e.currentTarget.reset();
          } catch (err) {
            const code = (err as { code?: string }).code;
            setPw({ err: code === "bad_login" ? t("auth.badLogin") : code === "weak" ? t("auth.weak") : (err as Error).message });
          }
        }}>
          <input name="current" type="password" required className="field" placeholder={t("acc.currentPassword")} aria-label={t("acc.currentPassword")} autoComplete="current-password" />
          <input name="next" type="password" required minLength={8} className="field" placeholder={t("acc.newPassword")} aria-label={t("acc.newPassword")} autoComplete="new-password" />
          <button className="btn btn-primary">{t("acc.save")}</button>
        </form>
        {pw.msg && <p className="mt-2 text-[14px] text-success">{pw.msg}</p>}
        {pw.err && <p className="mt-2 text-[14px] text-danger">{pw.err}</p>}
      </section>

      <section className="card p-6">
        {!del.open ? (
          <button className="btn btn-quiet text-danger" onClick={() => setDel((d) => ({ ...d, open: true }))}>{t("acc.delete")}</button>
        ) : (
          <form className="space-y-3" onSubmit={async (e) => {
            e.preventDefault();
            try {
              await postJson("/api/auth/delete", { password: del.password });
              setUser(null);
              router.push(href("/"));
            } catch (err) {
              setDel((d) => ({ ...d, err: (err as { code?: string }).code === "bad_login" ? t("auth.badLogin") : (err as Error).message }));
            }
          }}>
            <p className="text-[15px] text-ink-2">{t("acc.deleteConfirm")}</p>
            <input className="field" value={del.text} onChange={(e) => setDel((d) => ({ ...d, text: e.target.value }))} aria-label="DELETE" />
            <input className="field" type="password" placeholder={t("auth.password")} aria-label={t("auth.password")} value={del.password} onChange={(e) => setDel((d) => ({ ...d, password: e.target.value }))} />
            {del.err && <p className="text-[14px] text-danger">{del.err}</p>}
            <button className="btn bg-danger text-white" disabled={del.text !== "DELETE" || !del.password}>{t("acc.delete")}</button>
          </form>
        )}
      </section>
    </div>
  );
}
