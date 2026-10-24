import {
  Combine, FileInput, FileOutput, Gauge, LayoutGrid, Lock, PenLine, ShieldCheck, Shrink, FileType, type LucideIcon,
} from "lucide-react";
import type { CategoryId } from "@/lib/tools";

// The studio's illustrations: a friendly file, the cloud that never gets it,
// and the coloured bubbles each family of tools lives in. All decoration
// (aria-hidden); every motion is CSS from globals.css, so it shows without
// scripts and stops with reduced motion.

export const CATEGORY_ICON: Record<CategoryId, LucideIcon> = {
  organize: LayoutGrid,
  optimize: Gauge,
  convertTo: FileInput,
  convertFrom: FileOutput,
  edit: PenLine,
  security: ShieldCheck,
};

type Mood = "happy" | "wow" | "sleepy" | "proud";

// A sheet of paper with a face: the site's guide. Its folded corner takes
// the colour of the family it stands in (--tint).
export function Friend({
  mood = "happy",
  wave = false,
  className = "",
  blinkDelay = "0s",
}: {
  mood?: Mood;
  wave?: boolean;
  className?: string;
  blinkDelay?: string;
}) {
  const eyes =
    mood === "sleepy" ? (
      <>
        <path d="M37 79q6 5 12 0" />
        <path d="M71 79q6 5 12 0" />
      </>
    ) : mood === "proud" ? (
      <>
        <path d="M37 81q6-7 12 0" />
        <path d="M71 81q6-7 12 0" />
      </>
    ) : (
      <g className="blink" style={{ "--blink-delay": blinkDelay } as React.CSSProperties}>
        <ellipse cx="43" cy="78" rx="5" ry={mood === "wow" ? 7.5 : 6.5} fill="var(--ink)" stroke="none" />
        <ellipse cx="77" cy="78" rx="5" ry={mood === "wow" ? 7.5 : 6.5} fill="var(--ink)" stroke="none" />
        <circle cx="45" cy="75.5" r="1.7" fill="var(--surface)" stroke="none" />
        <circle cx="79" cy="75.5" r="1.7" fill="var(--surface)" stroke="none" />
      </g>
    );
  const mouth =
    mood === "wow" ? <ellipse cx="60" cy="98" rx="4.5" ry="5.5" fill="var(--ink)" stroke="none" /> :
    mood === "sleepy" ? <path d="M55 96q5 3 10 0" /> :
    <path d="M51 93q9 9 18 0" />;
  return (
    <svg viewBox="-14 -4 148 160" aria-hidden className={`overflow-visible ${className}`} fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      {/* arms */}
      <path d="M8 104q-14-2-16-16" />
      <g className={wave ? "wave" : undefined}>
        <path d="M112 100q16-6 16-24" />
      </g>
      {/* feet */}
      <path d="M40 148v6M80 148v6" />
      <path d="M20 6h58l32 32v98a12 12 0 0 1-12 12H20a12 12 0 0 1-12-12V18A12 12 0 0 1 20 6z" fill="var(--surface)" />
      <path d="M78 6v22a10 10 0 0 0 10 10h22" fill="var(--tint)" />
      <path d="M26 30h28M26 42h20" stroke="var(--line-strong)" />
      {eyes}
      <circle cx="31" cy="92" r="6.5" fill="var(--blush)" stroke="none" opacity="0.75" />
      <circle cx="89" cy="92" r="6.5" fill="var(--blush)" stroke="none" opacity="0.75" />
      {mouth}
    </svg>
  );
}

// The cloud other PDF sites upload to. Here it has nothing to do, so it sleeps.
export function SleepyCloud({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 170 120" aria-hidden className={`overflow-visible ${className}`} fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path
        d="M42 100h88a28 28 0 0 0 4-55.7A36 36 0 0 0 66 34a26 26 0 0 0-26 25 21 21 0 0 0 2 41z"
        fill="var(--surface)"
      />
      <path d="M64 70q6 5 12 0M96 70q6 5 12 0" />
      <path d="M81 84q5 3 10 0" />
      <circle cx="58" cy="82" r="5.5" fill="var(--blush)" stroke="none" opacity="0.7" />
      <circle cx="114" cy="82" r="5.5" fill="var(--blush)" stroke="none" opacity="0.7" />
      <g className="zzz" stroke="var(--muted)" strokeWidth="2.5">
        <path d="M140 24h10l-10 11h10" />
        <path d="M154 8h7l-7 8h7" />
        <path d="M132 4h6l-6 7h6" />
      </g>
    </svg>
  );
}

// A four-point star.
export function Sparkle({ className = "", delay = "0s" }: { className?: string; delay?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        className="twinkle"
        style={{ "--tw": delay } as React.CSSProperties}
        d="M12 1c.6 5.6 2.4 7.6 11 11-8.6 3.4-10.4 5.4-11 11-.6-5.6-2.4-7.6-11-11 8.6-3.4 10.4-5.4 11-11z"
        fill="currentColor"
      />
    </svg>
  );
}

// A family's icon in its pastel: tinted squircle, deeper glyph.
export function CategoryBadge({ id, size = 56, className = "" }: { id: CategoryId; size?: number; className?: string }) {
  const Icon = CATEGORY_ICON[id];
  return (
    <span
      aria-hidden
      data-cat={id}
      className={`relative inline-grid shrink-0 place-items-center bg-(--tint) text-(--tint-ink) ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.34) }}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.75} />
    </span>
  );
}

// The hero: the friend at work inside a browser window, tools floating
// round it, and above, the cloud asleep. The dotted line toward the cloud
// stops at a "no": nothing is uploaded.
const ORBIT: { id: CategoryId; Icon: LucideIcon; pos: string; d: string }[] = [
  { id: "organize", Icon: Combine, pos: "start-[2%] top-[30%]", d: "-1s" },
  { id: "optimize", Icon: Shrink, pos: "start-[6%] bottom-[14%]", d: "-3.5s" },
  { id: "convertTo", Icon: FileType, pos: "end-[1%] top-[44%]", d: "-2s" },
  { id: "edit", Icon: PenLine, pos: "end-[8%] bottom-[8%]", d: "-4.5s" },
  { id: "security", Icon: Lock, pos: "start-[34%] bottom-[0%]", d: "-0.5s" },
];

export function HeroScene({ badge }: { badge: string }) {
  return (
    <div aria-hidden className="relative mx-auto aspect-square w-full max-w-[560px] select-none">
      <div data-cat="edit" className="blob inset-[10%] bg-(--tint) opacity-90" />
      <div data-cat="convertTo" className="blob end-[0%] top-[4%] h-[38%] w-[38%] bg-(--tint) opacity-80 [animation-delay:-6s]" />
      <div data-cat="organize" className="blob bottom-[2%] start-[4%] h-[30%] w-[30%] bg-(--tint) opacity-80 [animation-delay:-11s]" />

      {/* The cloud, asleep, and the path that never reaches it. */}
      <div className="absolute end-[4%] top-[2%] w-[30%]">
        <SleepyCloud className="bob w-full [--bob-delay:-2s]" />
      </div>
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full overflow-visible rtl:-scale-x-100" fill="none">
        <path d="M54 27 C 57 24, 59 22.5, 61.5 21.5" stroke="var(--muted)" strokeWidth="0.7" strokeLinecap="round" className="flow" />
        <g transform="translate(65 20)">
          <circle r="3.4" fill="var(--surface)" stroke="var(--danger)" strokeWidth="0.8" />
          <path d="M-2.1 -2.1 L2.1 2.1" stroke="var(--danger)" strokeWidth="0.8" strokeLinecap="round" />
        </g>
      </svg>

      {/* The browser window, with the friend at work inside. */}
      <div className="hop absolute start-[17%] top-[26%] w-[62%] rounded-[26px] border border-line bg-surface shadow-lift" style={{ "--d": "250ms" } as React.CSSProperties}>
        <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff8a7a]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#ffcf66]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#6fd6a0]" />
          <span data-cat="organize" className="pill ms-auto h-6 max-w-[70%] truncate px-2.5 text-[11px]">
            <ShieldCheck size={12} strokeWidth={2} className="shrink-0" />
            <span className="truncate">{badge}</span>
          </span>
        </div>
        <div data-cat="edit" className="relative grid place-items-center px-6 pb-7 pt-6">
          <Friend wave className="bob h-auto w-[44%]" />
          <div className="mt-3 h-2 w-[70%] overflow-hidden rounded-full bg-surface-2">
            <div className="hero-progress h-full rounded-full bg-brand" />
          </div>
        </div>
      </div>

      {ORBIT.map(({ id, Icon, pos, d }) => (
        <span
          key={id}
          data-cat={id}
          className={`float absolute grid h-[13%] w-[13%] place-items-center rounded-[30%] border border-line bg-surface text-(--tint-ink) shadow-card ${pos}`}
          style={{ "--fd": d } as React.CSSProperties}
        >
          <span className="grid h-[76%] w-[76%] place-items-center rounded-[26%] bg-(--tint)">
            <Icon className="h-[52%] w-[52%]" strokeWidth={1.75} />
          </span>
        </span>
      ))}

      <Sparkle className="absolute start-[14%] top-[12%] w-[5%] text-coral" delay="-0.4s" />
      <Sparkle className="absolute end-[30%] bottom-[22%] w-[3.5%] text-brand" delay="-1.6s" />
      <Sparkle className="absolute start-[48%] top-[6%] w-[3%] text-[#f2b53c]" delay="-0.9s" />
    </div>
  );
}
