"use client";

import { useEffect } from "react";
import { VENDOR_VERSION } from "@/lib/vendor";

// Registers the offline cache in production builds only, so dev reloads stay
// fresh. The vendor version in the URL makes a new install a new worker, with
// its own cache, whenever the vendored files change.
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register(`/sw.js?v=${VENDOR_VERSION}`).catch(() => {});
  }, []);
  return null;
}
