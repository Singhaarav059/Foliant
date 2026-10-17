import { BRAND } from "@/lib/brand";

// A single folio: an ink sheet with a vermilion folded corner.
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M5 3.5A1.5 1.5 0 0 1 6.5 2H15l5 5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 20.5z" fill="var(--ink)" />
      <path d="M15 2v3.5A1.5 1.5 0 0 0 16.5 7H20z" fill="var(--accent)" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark />
      <span className="text-[1.05rem] font-semibold tracking-[-0.03em]">{BRAND.name}</span>
    </span>
  );
}
