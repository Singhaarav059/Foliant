"use client";

// The home page's "how it works" film (HowItWorks.tsx) in Remotion's Player.
// The Player and the composition load when the section comes near the
// screen; until then a box of the same shape holds the place. It plays
// muted on a loop while visible, and waits for a press with reduced motion.

import { useEffect, useRef, useState } from "react";
import type { PlayerRef } from "@remotion/player";
import { useI18n } from "../I18n";
import { onThemeChange, paperColors, reducedMotion } from "@/lib/paper";
import type { HowItWorksProps } from "./HowItWorks";

type Loaded = { Player: typeof import("@remotion/player").Player; mod: typeof import("./HowItWorks") };

function colors(): HowItWorksProps["colors"] {
  const c = paperColors();
  const success = getComputedStyle(document.documentElement).getPropertyValue("--success").trim();
  return { ...c, success };
}

export function Explainer() {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  const player = useRef<PlayerRef>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [palette, setPalette] = useState<HowItWorksProps["colors"] | null>(null);
  const [still, setStill] = useState(false);

  // Load near the screen; play while on it.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let started = false;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting && !started) {
          started = true;
          setStill(reducedMotion());
          setPalette(colors());
          void Promise.all([import("@remotion/player"), import("./HowItWorks")]).then(([p, mod]) => setLoaded({ Player: p.Player, mod }));
        }
        if (reducedMotion()) return;
        if (e.isIntersecting) player.current?.play();
        else player.current?.pause();
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(el);
    const off = onThemeChange(() => setPalette(colors()));
    return () => {
      io.disconnect();
      off();
    };
  }, []);

  const props: HowItWorksProps | null = palette && {
    steps: [t("explain.s1"), t("explain.s2"), t("explain.s3")],
    uploads: t("explain.uploads"),
    colors: palette,
  };

  return (
    <section aria-labelledby="explainer" className="mt-20">
      <h2 id="explainer" className="reveal display max-w-[20ch] text-[2rem] sm:text-[2.75rem]">{t("explain.title")}</h2>
      {/* The film says what the three steps below say; they are the text version. */}
      <div ref={box} aria-hidden className="reveal mt-8 aspect-[2/1] w-full overflow-hidden rounded-[24px] border border-line bg-bg shadow-card">
        {loaded && props && (
          <loaded.Player
            ref={player}
            component={loaded.mod.HowItWorks}
            inputProps={props}
            durationInFrames={loaded.mod.DURATION}
            fps={loaded.mod.FPS}
            compositionWidth={loaded.mod.WIDTH}
            compositionHeight={loaded.mod.HEIGHT}
            style={{ width: "100%", height: "100%" }}
            loop
            autoPlay={!still}
            controls={still}
            initiallyMuted
            // The film is silent: no shared <audio> tags, whose silent data: sources the CSP blocks.
            numberOfSharedAudioTags={0}
            acknowledgeRemotionLicense
          />
        )}
      </div>
      <ol className="mt-6 grid gap-4 sm:grid-cols-3">
        {(["explain.s1", "explain.s2", "explain.s3"] as const).map((k, i) => (
          <li key={k} className="reveal flex items-baseline gap-3">
            <span className="font-mono text-[13px] text-accent">0{i + 1}</span>
            <span className="text-[15px] text-ink-2">{t(k)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
