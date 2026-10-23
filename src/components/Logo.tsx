import { BRAND } from "@/lib/brand";

// A single folio: an ink sheet with a vermilion folded corner. Inside a
// `group`, the corner folds a little further on hover.
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className="overflow-visible">
      <path d="M5 3.5A1.5 1.5 0 0 1 6.5 2H15l5 5v13.5a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 20.5z" fill="var(--ink)" />
      <path
        d="M15 2v3.5A1.5 1.5 0 0 0 16.5 7H20z"
        fill="var(--accent)"
        className="origin-[17.5px_4.5px] transition-transform duration-500 ease-(--ease-spring) group-hover:-translate-x-[1.5px] group-hover:translate-y-[1.5px] group-hover:scale-125"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="group inline-flex items-center gap-2">
      <LogoMark />
      <span className="serif text-[1.45rem] leading-none tracking-[-0.02em]">{BRAND.name}</span>
    </span>
  );
}
