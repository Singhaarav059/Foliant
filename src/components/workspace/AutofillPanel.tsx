"use client";

import { useEffect, useState } from "react";
import { KeyRound, Lock, UserRound, Wand2 } from "lucide-react";
import { useI18n } from "../I18n";
import type { FieldInfo } from "@/lib/pdf/edit";
import type { Profile, ProfileKey } from "@/lib/autofill";

type State = "loading" | "none" | "locked" | "editing" | "unlocked";

// Fill a form from my details (P3-07): set up a profile once (kept encrypted
// on this device), unlock it with its passphrase, and fill the form's
// matching fields, which are then highlighted for review.
export function AutofillPanel({ fields, onFill }: { fields: FieldInfo[]; onFill: (values: Record<string, string>) => void }) {
  const { t } = useI18n();
  const [state, setState] = useState<State>("loading");
  const [profile, setProfile] = useState<Profile>({});
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [error, setError] = useState("");
  const [filled, setFilled] = useState<number | null>(null);
  const [mod, setMod] = useState<typeof import("@/lib/autofill") | null>(null);

  useEffect(() => {
    let live = true;
    import("@/lib/autofill").then(async (m) => {
      if (!live) return;
      setMod(m);
      setState((await m.hasProfile()) ? "locked" : "none");
    });
    return () => {
      live = false;
    };
  }, []);
  if (!mod || state === "loading") return null;

  const unlock = async () => {
    setError("");
    try {
      setProfile(await mod.loadProfile(pass));
      setState("unlocked");
    } catch {
      setError(t("af.wrongPass"));
    }
  };
  const save = async () => {
    setError("");
    if (pass.length < 8) return setError(t("af.passShort"));
    if (pass !== pass2) return setError(t("af.passMismatch"));
    await mod.saveProfile(profile, pass);
    setState("unlocked");
  };
  const fill = () => {
    const values: Record<string, string> = {};
    for (const f of fields) {
      const key = mod.matchField({ name: f.name, tooltip: f.tooltip });
      const v = key ? mod.valueFor(key, profile, f) : null;
      if (v) values[f.name] = v;
    }
    onFill(values);
    setFilled(Object.keys(values).length);
  };
  const forget = async () => {
    await mod.deleteProfile();
    setProfile({});
    setPass("");
    setPass2("");
    setState("none");
  };

  return (
    <section data-autofill={state} className="rounded-xl border border-line p-3">
      <p className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink-2"><UserRound size={15} /> {t("af.title")}</p>
      {state === "none" && (
        <>
          <p className="mb-2 text-[13px] text-muted">{t("af.intro")}</p>
          <button className="btn btn-quiet btn-sm w-full" onClick={() => setState("editing")}>{t("af.setUp")}</button>
        </>
      )}
      {state === "locked" && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
          <label className="block text-[13px] text-ink-2">{t("af.passphrase")}
            <input type="password" autoComplete="current-password" className="field mt-1" value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm flex-1"><KeyRound size={15} /> {t("af.unlock")}</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => void forget()}>{t("af.delete")}</button>
          </div>
        </form>
      )}
      {state === "editing" && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <p className="text-[13px] text-muted">{t("af.private")}</p>
          <div className="max-h-[300px] space-y-2 overflow-auto pe-1">
            {mod.PROFILE_KEYS.map((k: ProfileKey) => (
              <label key={k} className="block text-[13px] text-ink-2">{t(`af.field.${k}`)}
                <input className="field mt-1" type={k === "dob" ? "date" : k === "email" ? "email" : k === "phone" ? "tel" : "text"}
                  value={profile[k] ?? ""} onChange={(e) => setProfile((p) => ({ ...p, [k]: e.target.value }))} />
              </label>
            ))}
          </div>
          <label className="block text-[13px] text-ink-2">{t("af.newPassphrase")}
            <input type="password" autoComplete="new-password" className="field mt-1" value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
          <label className="block text-[13px] text-ink-2">{t("af.repeatPassphrase")}
            <input type="password" autoComplete="new-password" className="field mt-1" value={pass2} onChange={(e) => setPass2(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-sm w-full">{t("af.save")}</button>
        </form>
      )}
      {state === "unlocked" && (
        <div className="space-y-2">
          <button className="btn btn-primary btn-sm w-full" data-action="autofill" onClick={fill}><Wand2 size={15} /> {t("af.fill")}</button>
          {filled !== null && <p role="status" className="text-[13px] text-ink-2">{filled ? t("af.filled", { n: filled }) : t("af.noneMatched")}</p>}
          <div className="flex gap-2">
            <button className="btn btn-quiet btn-sm flex-1" onClick={() => { setPass2(pass); setState("editing"); }}>{t("af.edit")}</button>
            <button className="btn btn-quiet btn-sm" onClick={() => { setProfile({}); setPass(""); setFilled(null); setState("locked"); }}><Lock size={14} /> {t("af.lock")}</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    </section>
  );
}
