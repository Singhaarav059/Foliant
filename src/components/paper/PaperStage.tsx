"use client";

// Paper in motion, sized by its parent: the 2D version (CSS, in the HTML from
// the start, so nothing shifts) with the 3D scene cross-fading over it where
// the device allows (src/lib/paper.ts wants3d). Purely decorative.

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { PaperStack } from "../Motion";
import { wants3d, type PaperAction, type PaperMode } from "@/lib/paper";

const PaperScene = dynamic(() => import("./PaperScene"), { ssr: false });

// The CSS version of an action: two sheets and a mark (cut line, seal, scan
// bar) that globals.css animates per action (.p2d-*).
export function Paper2D({ action }: { action: PaperAction }) {
  return (
    <div aria-hidden className={`p2d p2d-${action}`}>
      <span className="p2d-sheet p2d-b" />
      <span className="p2d-sheet p2d-a">
        <i /><i /><i /><i />
      </span>
      <span className="p2d-mark" />
    </div>
  );
}

export function PaperStage({ mode, className = "" }: { mode: PaperMode; className?: string }) {
  const [three, setThree] = useState(false);
  const [ready, setReady] = useState(false);
  // Decided after mount: it reads the screen, motion and WebGL settings.
  // Waits for an idle moment, so the page's own work goes first.
  useEffect(() => {
    const run = () => setThree(wants3d());
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(run, { timeout: 1500 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(run, 200);
    return () => clearTimeout(id);
  }, []);
  const onReady = useCallback(() => setReady(true), []);

  return (
    <div aria-hidden className={`relative ${className}`}>
      <div className={`absolute inset-0 grid place-items-center transition-opacity duration-700 ${ready ? "opacity-0" : "opacity-100"}`}>
        {mode === "hero" ? <PaperStack /> : <Paper2D action={mode} />}
      </div>
      {three && (
        <div className={`absolute inset-0 transition-opacity duration-700 ${ready ? "opacity-100" : "opacity-0"}`}>
          <PaperScene mode={mode} onReady={onReady} />
        </div>
      )}
    </div>
  );
}
