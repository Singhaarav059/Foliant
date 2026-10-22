"use client";

import dynamic from "next/dynamic";

// The workspace (with its drag-and-drop and option code) in a bundle of its
// own, so pages that share a route with the tools (FAQ, privacy, landing
// pages) don't load it unless they show one (P3-03). It still renders on the
// server, so tool pages arrive with the drop zone in their HTML.
export const Workspace = dynamic(() => import("./Workspace").then((m) => m.Workspace));
