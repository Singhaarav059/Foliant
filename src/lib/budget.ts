// How much a task can comfortably hold on this device. Tools that run in the
// browser have no size or file cap (src/lib/tools.ts LIMITS is the server's);
// past this budget the workspace only warns that the device may struggle.
//
// navigator.deviceMemory is the device's RAM in GB, rounded and capped at 8
// (Chromium only). A tab gets a fraction of it, and a task holds its inputs,
// the parsed documents and the outputs at once, so the budget is a quarter of
// the RAM, at least 256 MB. Without the hint: 2 GB on a desktop, 512 MB on a
// phone, where tabs are killed sooner.

const MB = 1024 * 1024;

export type DeviceHints = { deviceMemory?: number; mobile?: boolean };

export function deviceHints(): DeviceHints {
  if (typeof navigator === "undefined") return {};
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  const mobile = nav.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
  return { deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined, mobile };
}

export function memoryBudget(h: DeviceHints = deviceHints()): number {
  if (h.deviceMemory && h.deviceMemory > 0) return Math.max(256 * MB, (h.deviceMemory * 1024 * MB) / 4);
  return h.mobile ? 512 * MB : 2048 * MB;
}

// The total size of a task's files when it is more than the device's budget, else null.
export function overBudget(files: { size: number }[], h?: DeviceHints): number | null {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  return total > memoryBudget(h) ? total : null;
}
