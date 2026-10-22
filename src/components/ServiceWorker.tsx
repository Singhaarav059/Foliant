"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useI18n } from "./I18n";
import { VENDOR_VERSION } from "@/lib/vendor";

// Registers the offline cache in production builds only, so dev reloads stay
// fresh. The vendor version in the URL makes a new install a new worker, with
// its own cache, whenever the vendored files change. When the worker says
// this tab's build is gone (public/sw.js, a deploy while it was open), a bar
// offers to reload rather than letting the next tool fail.
export function ServiceWorker() {
  const { t } = useI18n();
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`/sw.js?v=${VENDOR_VERSION}`).catch(() => {});
    const onMessage = (e: MessageEvent) => e.data?.type === "nopload:stale" && setStale(true);
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  if (!stale) return null;
  return (
    <div role="alert" data-stale className="fixed inset-x-0 bottom-0 z-[70] flex flex-wrap items-center justify-center gap-3 border-t border-line bg-surface px-4 py-3 text-[15px] shadow-card">
      {t("ws.staleBuild")}
      <button className="btn btn-primary btn-sm" onClick={() => location.reload()}><RefreshCw size={15} /> {t("ws.reloadPage")}</button>
    </div>
  );
}
