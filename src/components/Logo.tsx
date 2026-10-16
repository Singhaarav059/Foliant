import { BRAND } from "@/lib/brand";

// A sheet with a folded corner, stacked on a second sheet.
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="7" y="3" width="20" height="24" rx="4" fill="#d33f6a" />
      <path d="M5 9a4 4 0 0 1 4-4h10l6 6v14a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="#2f6fed" />
      <path d="M19 5v4a2 2 0 0 0 2 2h4" fill="#9dbbff" />
      <rect x="9.5" y="16" width="11" height="2.2" rx="1.1" fill="#fff" />
      <rect x="9.5" y="20.6" width="7.5" height="2.2" rx="1.1" fill="#fff" opacity=".75" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2">
      <LogoMark />
      <span className="text-[1.15rem] font-bold tracking-[-0.02em]">{BRAND.name}</span>
    </span>
  );
}
