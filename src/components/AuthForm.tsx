"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "./I18n";
import { useUser, postJson, type User } from "./User";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const { t, href } = useI18n();
  const { setUser } = useUser();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError(null);
    try {
      const { user } = await postJson<{ user: User }>(`/api/auth/${mode}`, data);
      setUser(user);
      router.push(href("/"));
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(code === "bad_login" ? t("auth.badLogin") : code === "taken" ? t("auth.taken") : code === "weak" ? t("auth.weak") : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[420px] px-4 pb-10 pt-14">
      <h1 className="text-center text-[2rem] font-semibold tracking-[-0.04em]">{mode === "login" ? t("auth.loginTitle") : t("auth.signupTitle")}</h1>
      <p className="mt-2 text-center text-[15px] text-muted">{t("auth.why")}</p>
      <form onSubmit={submit} className="card mt-8 space-y-4 p-6">
        {mode === "register" && (
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{t("auth.name")}</span>
            <input name="name" className="field" autoComplete="name" maxLength={80} />
          </label>
        )}
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{t("auth.email")}</span>
          <input name="email" type="email" required className="field" autoComplete="email" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{t("auth.password")}</span>
          <input name="password" type="password" required minLength={mode === "register" ? 8 : 1} className="field" autoComplete={mode === "login" ? "current-password" : "new-password"} />
          {mode === "register" && <span className="mt-1 block text-[13px] text-muted">{t("auth.passwordHint")}</span>}
        </label>
        {error && <p role="alert" className="text-[14px] text-danger">{error}</p>}
        <button className="btn btn-primary w-full" disabled={busy}>
          {busy && <Loader2 size={17} className="animate-spin" />}
          {mode === "login" ? t("auth.submitLogin") : t("auth.submitSignup")}
        </button>
      </form>
      <p className="mt-5 text-center text-[15px] text-muted">
        {mode === "login" ? t("auth.noAccount") : t("auth.haveAccount")}{" "}
        <Link href={href(mode === "login" ? "/register" : "/login")} className="font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink">
          {mode === "login" ? t("nav.signup") : t("nav.login")}
        </Link>
      </p>
    </div>
  );
}
