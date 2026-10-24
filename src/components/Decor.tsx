// Decoration: paper ornaments, print-proof marks and sketched doodles.
// Purely visual (aria-hidden), inline SVG in currentColor, animated in CSS
// (src/app/globals.css: .doodle, .squiggle, .crop, .tape, .clip).

type Svg = React.SVGProps<SVGSVGElement>;

// Shared look for the sketches: a slightly uneven pen line that draws itself in.
function Sketch({ children, viewBox = "0 0 48 48", className = "", ...rest }: Svg & { children: React.ReactNode }) {
  return (
    <svg
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`doodle ${className}`}
      {...rest}
    >
      {children}
    </svg>
  );
}

export function Scissors(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M14.5 33.2c-3.6.3-6.3 2.6-6.1 5.3.2 2.6 3.2 4.4 6.7 4.1 3.5-.3 6.2-2.7 6-5.3-.2-2.5-3.1-4.4-6.6-4.1z" />
      <path pathLength={1} d="M33.6 33.4c3.6.4 6.2 2.8 5.9 5.4-.3 2.6-3.4 4.3-6.9 3.9-3.5-.4-6-2.8-5.8-5.4.3-2.5 3.3-4.2 6.8-3.9z" />
      <path pathLength={1} d="M19.6 35.2 35.8 6.1M28.5 35.4 12.6 6.3" />
      <circle pathLength={1} cx="24.1" cy="20.9" r="0.9" />
    </Sketch>
  );
}

export function Stamp(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M19.2 22.6c-.2-3.3-3.1-5.6-3-9.3.1-4.7 3.9-8 8.3-7.9 4.5.1 8 3.6 7.8 8.2-.1 3.6-3 5.8-3.3 9" />
      <path pathLength={1} d="M10.3 23.1c9.2-.6 18.4-.7 27.6-.1.9 2.2 1 4.6.4 6.9-9.5.5-19 .5-28.5-.1-.4-2.2-.2-4.5.5-6.7z" />
      <path pathLength={1} d="M9.2 35.6c9.9.7 19.9.7 29.8-.2" />
      <path pathLength={1} d="M15 40.4h3.2M21.4 40.5h3.4M28 40.4h3.6" />
    </Sketch>
  );
}

export function PenNib(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M24.3 41.8 13.1 23.4c3.3-5.5 6.8-11 11-16.6 4.1 5.5 7.6 11 10.9 16.5L24.3 41.8z" />
      <path pathLength={1} d="M24.2 41.6 24.1 26.4" />
      <circle pathLength={1} cx="24.1" cy="22.9" r="2.4" />
      <path pathLength={1} d="M38.6 40.6c-2.4.6-4.3-1.1-6.4-.5-1.6.5-2.6 2-4.4 2.3" />
    </Sketch>
  );
}

export function Squeeze(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M16.6 12.4c5-.3 10-.2 15 .2.4 7.9.3 15.8-.2 23.7-4.9.3-9.9.3-14.8-.1-.4-7.9-.4-15.9 0-23.8z" />
      <path pathLength={1} d="M20.8 19.2h6.6M20.8 23.8h6.2M20.8 28.3h4.8" />
      <path pathLength={1} d="M4.6 24.3h7.6M9 20.6l3.4 3.7-3.5 3.6M43.6 24.1h-7.7M39.3 20.4l-3.4 3.7 3.5 3.7" />
    </Sketch>
  );
}

export function Swap(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M9.6 17.2c6.8-6.8 18.6-8.4 27-2.4M33.3 9.2l3.6 5.7-6.5 1.6" />
      <path pathLength={1} d="M38.6 30.8c-6.6 7-18.4 8.9-27 3.1M14.9 39.1l-3.5-5.8 6.6-1.4" />
      <path pathLength={1} d="M19.4 20.4c3-.2 6-.2 9 0 .3 2.6.3 5.2 0 7.8-3 .2-6 .2-9 0-.3-2.6-.3-5.2 0-7.8z" />
    </Sketch>
  );
}

export function Padlock(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M16.2 21.4c-.3-4.4.3-9.5 3.3-12.1 2.6-2.3 6.6-2.3 9.2-.1 3.1 2.7 3.5 7.7 3.2 12.1" />
      <path pathLength={1} d="M11.6 21.6c8.3-.5 16.6-.5 24.9.1.6 6.5.5 13-.2 19.4-8.2.5-16.4.5-24.6-.1-.6-6.5-.6-12.9-.1-19.4z" />
      <circle pathLength={1} cx="24" cy="29.6" r="2.3" />
      <path pathLength={1} d="M24 31.9v4.3" />
    </Sketch>
  );
}

export function Clip(p: Svg) {
  return (
    <Sketch viewBox="0 0 24 56" {...p}>
      <path pathLength={1} d="M7.4 16.1V41c0 3 2.1 5.3 4.7 5.3s4.6-2.4 4.6-5.3V10.4c0-4.3-3-7.6-6.5-7.6S3.6 6.1 3.6 10.4v32.3c0 5.6 3.8 10 8.4 10s8.5-4.4 8.5-10V18.9" />
    </Sketch>
  );
}

export function Bolt(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M27.6 4.8 12.4 26.9c3.6-.2 7.2-.1 10.8.2L19.8 43.4 35.7 20.3c-3.7.2-7.4.1-11-.2l2.9-15.3z" />
    </Sketch>
  );
}

export function Tray(p: Svg) {
  return (
    <Sketch {...p}>
      <path pathLength={1} d="M24.1 5.6c-.2 7.6-.1 15.3.2 22.9M16.6 21.4l7.6 7.6 7.4-7.7" />
      <path pathLength={1} d="M6.8 28.9c.3 3.6.2 7.3-.1 10.9 11.4.6 22.9.6 34.3-.1-.4-3.6-.4-7.2-.1-10.8" />
    </Sketch>
  );
}

// One sketch per tool category, beside its heading.
export const CATEGORY_DOODLE = {
  organize: Scissors,
  optimize: Squeeze,
  convertTo: Swap,
  convertFrom: Swap,
  edit: PenNib,
  security: Padlock,
} as const;

// A hand-drawn underline that draws itself under a heading.
export function Squiggle({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 12" preserveAspectRatio="none" fill="none" aria-hidden className={`squiggle ${className}`}>
      <path pathLength={1} d="M2 8.5C22 3.2 40 10.6 60 6.4s38-4.6 58 .4 40 3.8 58-1.1c8-2.2 15-2.5 22-1.4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

// A print proof's crop marks on the four corners of the parent (relative).
export function CropMarks({ inset = -12 }: { inset?: number }) {
  return (
    <span aria-hidden className="crop pointer-events-none absolute" style={{ inset }}>
      <i /><i /><i /><i />
    </span>
  );
}

// A registration target.
export function RegMark({ size = 18, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden className={`regmark ${className}`}>
      <circle cx="10" cy="10" r="5.5" />
      <path d="M10 0v20M0 10h20" />
    </svg>
  );
}

// A divider: hairlines either side of a small diamond.
export function Flourish({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`flourish flex items-center gap-3 text-line-strong ${className}`}>
      <span className="reveal-line h-px flex-1 bg-current" />
      <svg width="34" height="10" viewBox="0 0 34 10" fill="none" stroke="currentColor" strokeWidth="1">
        <circle cx="3" cy="5" r="1" fill="currentColor" />
        <path d="M17 1 21 5 17 9 13 5z" className="text-accent" stroke="var(--accent)" />
        <circle cx="31" cy="5" r="1" fill="currentColor" />
      </svg>
      <span className="reveal-line h-px flex-1 bg-current" />
    </div>
  );
}

// A strip of tape holding the corner of a card.
export function Tape({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`tape ${className}`} />;
}

// Soft warm light behind a section; the parent needs `relative` (and usually
// `overflow-hidden` or `isolate`).
export function Wash({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`wash pointer-events-none absolute -z-10 rounded-full ${className}`} />;
}
