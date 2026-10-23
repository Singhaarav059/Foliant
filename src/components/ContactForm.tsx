"use client";

import { useState } from "react";
import { useI18n } from "./I18n";
import { postJson } from "@/lib/post";

export function ContactForm() {
  const { t } = useI18n();
  const [state, setState] = useState<{ sent?: boolean; err?: string; busy?: boolean }>({});
  if (state.sent) return <p className="card p-6 text-[16px]">{t("contact.sent")}</p>;
  return (
    <form className="card space-y-4 p-6" onSubmit={async (e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      setState({ busy: true });
      try {
        await postJson("/api/contact", { email: f.get("email"), message: f.get("message") });
        setState({ sent: true });
      } catch (err) {
        setState({ err: (err as Error).message });
      }
    }}>
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{t("contact.email")}</span>
        <input name="email" type="email" required className="field" autoComplete="email" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{t("contact.message")}</span>
        <textarea name="message" required minLength={5} maxLength={5000} rows={6} className="field" />
      </label>
      {state.err && <p role="alert" className="text-[14px] text-danger">{state.err}</p>}
      <button className="btn btn-primary" disabled={state.busy}>{t("contact.send")}</button>
    </form>
  );
}
