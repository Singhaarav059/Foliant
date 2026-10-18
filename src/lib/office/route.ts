// Which way an Office → PDF job goes in the static build.
//
//   libreoffice  LibreOffice runs in the browser and writes the PDF file.
//   reload       The same, after one reload: the service worker adds the
//                isolation headers LibreOffice's threads need on hosts that
//                can't send them, but only to pages it loads.
//   print        The light renderer, saved through the print dialog.
//   unavailable  Only LibreOffice reads these files, and it can't run here.
//
// "auto" (the default) picks LibreOffice on computers with room for it and
// printing on phones and small devices, which LibreOffice's memory use and
// download would overwhelm, and in Safari, where LibreOffice doesn't start
// (its worker aborts while loading).

import { LIGHT_OFFICE } from "../tools";

export type OfficeRoute = "libreoffice" | "reload" | "print" | "unavailable";
export type OfficeEnv = {
  isolated: boolean; // crossOriginIsolated, SharedArrayBuffer present
  worker: boolean; // an active service worker that can isolate the page on reload
  reloaded: boolean; // this job already came back from that reload
  phone: boolean;
  webkit: boolean; // Safari's engine, which every iOS browser uses too
  memory?: number; // navigator.deviceMemory in GB, where the browser tells
};

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

export function officeRoute(fidelity: string, names: string[], env: OfficeEnv): OfficeRoute {
  const required = names.some((n) => !LIGHT_OFFICE.includes(ext(n)));
  const capable = !env.phone && !env.webkit && (env.memory ?? 8) >= 4;
  const wanted = required || fidelity === "high" || (fidelity === "auto" && capable);
  if (!wanted) return "print";
  if (env.isolated) return "libreoffice";
  if (env.worker && !env.reloaded) return "reload";
  return required || fidelity === "high" ? "unavailable" : "print";
}

export async function officeEnv(reloaded: boolean): Promise<OfficeEnv> {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  // iPads report a desktop Safari; their touch points give them away.
  const phone = nav.userAgentData?.mobile ?? (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1));
  // Chromium browsers say who they are in userAgentData; WebKit's UA names Safari and not Chrome.
  const webkit = !nav.userAgentData && /AppleWebKit/.test(nav.userAgent) && !/Chrome|Chromium|CriOS|Edg/.test(nav.userAgent);
  let worker = false;
  if ("serviceWorker" in navigator) {
    // On a first visit the worker may still be installing: give it a moment.
    const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    const wait = new Promise<false>((r) => setTimeout(() => r(false), 10_000));
    worker = Boolean(reg && (reg.active || (await Promise.race([navigator.serviceWorker.ready.then(() => true), wait]))));
  }
  return {
    isolated: typeof crossOriginIsolated !== "undefined" && crossOriginIsolated && typeof SharedArrayBuffer !== "undefined",
    worker,
    reloaded,
    phone,
    webkit,
    memory: nav.deviceMemory,
  };
}

// The 79 MB download is asked about once; after that it's just how the tool works.
const CONSENT = "nopload.officeDownload";

export function officeConsented() {
  try {
    return localStorage.getItem(CONSENT) === "yes";
  } catch {
    return false;
  }
}

export function consentToOffice() {
  try {
    localStorage.setItem(CONSENT, "yes");
  } catch {
    // Private mode: asked again next time.
  }
}
