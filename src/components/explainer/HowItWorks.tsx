// The home page's explainer film, a Remotion composition: a file dropped
// into the browser, worked on there while nothing is uploaded, and
// downloaded. Played in the page by Remotion's Player (Explainer.tsx);
// text and colours come in as props, so it follows the language and theme.
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";

export const FPS = 30;
export const DURATION = 300;
export const WIDTH = 1200;
export const HEIGHT = 600;

export type HowItWorksProps = {
  steps: [string, string, string];
  uploads: string;
  colors: { bg: string; surface: string; surface2: string; ink: string; line: string; accent: string; success: string };
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

function Sheet({ c, fold = 0, style }: { c: HowItWorksProps["colors"]; fold?: number; style?: React.CSSProperties }) {
  return (
    <div style={{ position: "absolute", width: 120, height: 156, ...style }}>
      <div style={{ position: "absolute", inset: 0, transformOrigin: "50% 100%", transform: `scaleY(${1 - fold * 0.5})`, background: c.surface, border: `1.5px solid ${c.line}`, borderRadius: 6, boxShadow: "0 18px 40px -16px rgba(40,30,15,.35)", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 18, left: 16, width: 58, height: 9, borderRadius: 3, background: c.ink }} />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ position: "absolute", top: 40 + i * 16, left: 16, width: [86, 78, 88, 60][i], height: 6, borderRadius: 3, background: c.line }} />
        ))}
        <div style={{ position: "absolute", top: 0, right: 0, width: 26, height: 26, background: `linear-gradient(225deg, ${c.bg} 50%, ${c.accent} 50%)` }} />
      </div>
    </div>
  );
}

function Caption({ text, n, from, c }: { text: string; n: number; from: number; c: HowItWorksProps["colors"] }) {
  const frame = useCurrentFrame();
  const local = frame - from;
  const o = interpolate(local, [0, 12, 78, 90], [0, 1, 1, 0], clamp);
  const y = interpolate(local, [0, 16], [24, 0], { ...clamp, easing: Easing.out(Easing.cubic) });
  return (
    <div style={{ position: "absolute", left: 70, top: 230, width: 400, opacity: o, transform: `translateY(${y}px)` }}>
      <div style={{ fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 22, color: c.accent }}>0{n}</div>
      <div style={{ marginTop: 10, fontSize: 46, lineHeight: 1.08, fontWeight: 600, letterSpacing: "-0.04em", color: c.ink }}>{text}</div>
    </div>
  );
}

export function HowItWorks({ steps, uploads, colors: c }: HowItWorksProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // The browser window everything happens in.
  const winIn = spring({ frame, fps, config: { damping: 18 } });
  // 1: the file drops in.
  const drop = spring({ frame: frame - 14, fps, config: { damping: 11, mass: 0.8 } });
  // 2: the device works on it: it folds small, with a pulse of light.
  const fold = interpolate(frame, [110, 140, 180, 200], [0, 1, 1, 0], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const glow = interpolate(frame, [100, 120, 190, 210], [0, 1, 1, 0], clamp);
  // 3: the result rises out with a tick.
  const rise = spring({ frame: frame - 215, fps, config: { damping: 14 } });
  const tick = spring({ frame: frame - 240, fps, config: { damping: 9 } });
  const outro = interpolate(frame, [285, 300], [1, 0], clamp);

  const sheetY = interpolate(drop, [0, 1], [-260, 0]) - rise * 120;
  const cloudO = interpolate(frame, [95, 110, 200, 212], [0, 1, 1, 0], clamp);
  const cross = interpolate(frame, [118, 134], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: c.bg, fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif", opacity: outro }}>
      <Caption text={steps[0]} n={1} from={0} c={c} />
      <Caption text={steps[1]} n={2} from={96} c={c} />
      <Caption text={steps[2]} n={3} from={206} c={c} />

      {/* The browser window: your device. */}
      <div style={{ position: "absolute", left: 560, top: 110, width: 470, height: 380, borderRadius: 18, border: `1.5px solid ${c.line}`, background: c.surface, transform: `scale(${0.9 + winIn * 0.1})`, opacity: winIn, boxShadow: `0 0 ${glow * 80}px ${glow * 6}px color-mix(in oklab, ${c.accent} 22%, transparent)` }}>
        <div style={{ height: 36, borderBottom: `1.5px solid ${c.line}`, display: "flex", alignItems: "center", gap: 7, paddingLeft: 16 }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 5, background: c.line }} />)}
        </div>
        <div style={{ position: "absolute", left: 175, top: 140 + sheetY }}>
          <Sheet c={c} fold={fold} />
        </div>
        {/* The tick on the finished file. */}
        <div style={{ position: "absolute", left: 270, top: 118 - rise * 120, width: 40, height: 40, borderRadius: 20, background: c.success, transform: `scale(${tick})`, display: "grid", placeItems: "center" }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c.surface} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </div>
        {/* The download tray. */}
        <div style={{ position: "absolute", left: 195, bottom: 22, width: 80, height: 6, borderRadius: 3, background: c.line, opacity: rise }} />
      </div>

      {/* The cloud the file never goes to, and the upload count that stays at zero. */}
      <div style={{ position: "absolute", left: 1062, top: 130, opacity: cloudO, textAlign: "center" }}>
        <svg width="96" height="64" viewBox="0 0 24 16" fill="none" stroke={c.line} strokeWidth="1.2" strokeLinecap="round">
          <path d="M6 14h11a4 4 0 0 0 .5-8A6 6 0 0 0 6 7a3.5 3.5 0 0 0 0 7z" />
          <path d="M4 1 L20 15" stroke={c.accent} strokeWidth="1.6" strokeDasharray="22" strokeDashoffset={22 * (1 - cross)} />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 1032, top: 216, width: 150, height: 1.5, background: `repeating-linear-gradient(90deg, ${c.line} 0 6px, transparent 6px 12px)`, opacity: cloudO }} />
      <div style={{ position: "absolute", left: 600, top: 512, opacity: cloudO, fontFamily: "var(--font-geist-mono), ui-monospace, monospace", fontSize: 22, color: c.ink }}>
        {uploads}
      </div>
    </AbsoluteFill>
  );
}
