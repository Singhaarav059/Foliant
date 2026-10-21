// What this page has sent off the device, counted live for the privacy chip
// (src/components/workspace/PrivacyChip.tsx). Three witnesses, none of them
// this site's own code paths:
// - Resource Timing (PerformanceObserver) sees every request the page makes.
//   One to another origin counts as "offsite".
// - The service worker (public/sw.js) sees requests from the page's workers
//   too, which Resource Timing doesn't, and measures the body of any request
//   that carries one: the bytes actually uploaded. It reports to every open
//   tab of the site, so with several tabs open a tab may count another's.
// - The Content-Security-Policy: a request it stopped fires a
//   securitypolicyviolation event in the page, counted as "blocked".
// blob: and data: addresses never leave the device and aren't counted.

export type Egress = {
  /** Bytes in request bodies (uploads), measured by the service worker. */
  sent: number;
  /** Distinct addresses on other sites the page or its workers requested. */
  offsite: number;
  /** Distinct addresses the Content-Security-Policy stopped. */
  blocked: number;
  /** Whether the service worker is measuring (it isn't on a first visit). */
  worker: boolean;
};

export type EgressMessage = { type: "nopload:egress"; url: string; bytes: number };

const EMPTY: Egress = { sent: 0, offsite: 0, blocked: 0, worker: false };
let state = EMPTY;
// Addresses, so a request reported by several witnesses counts once. A
// blocked request can show up in Resource Timing too (Chrome records the
// failed load), so it counts as blocked, not as offsite.
const offsite = new Set<string>();
const blocked = new Set<string>();
const counts = () => ({ offsite: [...offsite].filter((u) => !blocked.has(u)).length, blocked: blocked.size });
const listeners = new Set<() => void>();
let started = false;

function update(patch: Partial<Egress>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const isOffsite = (url: string) => {
  try {
    const u = new URL(url, location.href);
    return (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "ws:" || u.protocol === "wss:") && u.origin !== location.origin;
  } catch {
    return false;
  }
};

function seen(url: string) {
  if (!isOffsite(url) || offsite.has(url)) return;
  offsite.add(url);
  update(counts());
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) seen(entry.name);
    });
    // buffered: the requests made before this module loaded, too.
    observer.observe({ type: "resource", buffered: true });
  } catch {
    /* no Resource Timing: the service worker still counts */
  }
  document.addEventListener("securitypolicyviolation", (e) => {
    // Only stopped requests; "eval" and "inline" checks aren't traffic. The
    // header and the meta copy of the policy each report the same request.
    if (!/^(?:https?|wss?):/i.test(e.blockedURI) || blocked.has(e.blockedURI)) return;
    blocked.add(e.blockedURI);
    update(counts());
  });
  const sw = navigator.serviceWorker;
  if (!sw) return;
  sw.addEventListener("message", (e: MessageEvent<EgressMessage>) => {
    if (e.data?.type !== "nopload:egress") return;
    seen(e.data.url);
    if (e.data.bytes > 0) update({ sent: state.sent + e.data.bytes });
  });
  sw.startMessages();
  const watching = () => update({ worker: !!sw.controller });
  sw.addEventListener("controllerchange", watching);
  watching();
}

export function subscribe(listener: () => void) {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export const snapshot = () => state;
export const serverSnapshot = () => EMPTY;
