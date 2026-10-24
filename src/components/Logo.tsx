import { BRAND } from "@/lib/brand";

// A page that floats like a little ghost: your files leave no trace. Ink
// and paper follow the theme; the folded corner is coral. Same drawing as
// public/icon.svg. Inside a `group`, it bobs up a little on hover.
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="5 2 22 28"
      aria-hidden
      className="shrink-0 overflow-visible transition-transform duration-500 ease-(--ease-spring) group-hover:-translate-y-1 group-hover:-rotate-6"
    >
      <path d="M10 4h8l7 7v16.5l-2.75-2-2.75 2-2.75-2-2.75 2-2.75-2L7 27.5V7a3 3 0 0 1 3-3z" fill="var(--ink)" />
      <path d="M18 4v5a2 2 0 0 0 2 2h5z" fill="var(--coral)" />
      <circle cx="12.5" cy="16" r="1.7" fill="var(--bg)" className="blink" />
      <circle cx="18.5" cy="16" r="1.7" fill="var(--bg)" className="blink" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="group inline-flex items-center gap-2">
      <LogoMark />
      <span className="text-[1.15rem] font-semibold leading-none tracking-[-0.035em]">{BRAND.name}</span>
    </span>
  );
}
