"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { useI18n } from "./I18n";
import { clearHandoff } from "@/lib/handoff";
import { listenForExtension } from "@/lib/extension-handoff";

// Says which file the browser add-on brought, above the tool picker, until a
// tool is picked (it then starts with the file) or the bar is closed.
export function ExtensionHandoff() {
  const { t } = useI18n();
  const pathname = usePathname();
  const [got, setGot] = useState<{ name: string; path: string } | null>(null);
  useEffect(() => listenForExtension((files) => setGot({ name: files[0].name, path: location.pathname })), []);
  if (!got || got.path !== pathname) return null;
  return (
    <div className="mx-auto max-w-[1240px] px-4 pt-4 sm:px-6">
      <div role="status" data-extension-file className="flex items-center gap-3 rounded-xl border border-line bg-surface py-2.5 pe-2 ps-4 text-[15px]">
        <span className="min-w-0 flex-1 break-words">{t("handoff.pick", { name: got.name })}</span>
        <button
          type="button"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:text-ink"
          aria-label={t("nav.close")}
          onClick={() => {
            clearHandoff();
            setGot(null);
          }}
        >
          <X size={16} aria-hidden />
        </button>
      </div>
    </div>
  );
}
