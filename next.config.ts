import type { NextConfig } from "next";
import securityHeaders from "./security-headers.json";

// FOLIANT_STATIC=1 builds the free hosted version: plain files in ./out that
// any static host can serve. Everything runs in the browser, and files named
// *.server.ts(x) (API routes, the locale proxy, account and contact pages)
// are left out; *.static.tsx pages (the language picker at "/", per-language
// 404s) are only built here.
const STATIC = process.env.FOLIANT_STATIC === "1";

const nextConfig: NextConfig = {
  // Both imply partial prerendering, which static exports can't do.
  cacheComponents: !STATIC,
  partialPrefetching: !STATIC,
  pageExtensions: STATIC ? ["tsx", "ts", "static.tsx"] : ["tsx", "ts", "server.ts", "server.tsx"],
  env: { NEXT_PUBLIC_STATIC: STATIC ? "1" : "" },
  // Server-side conversion libraries stay as plain Node requires.
  serverExternalPackages: ["playwright-core", "mammoth", "exceljs", "jszip"],
  turbopack: {
    // A git worktree whose node_modules links to the main checkout builds
    // with TURBOPACK_ROOT set to a directory that contains both.
    ...(process.env.TURBOPACK_ROOT ? { root: process.env.TURBOPACK_ROOT } : {}),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
    // qpdf's Emscripten glue mentions Node built-ins behind a runtime check.
    resolveAlias: {
      fs: { browser: "./src/lib/empty.ts" },
      path: { browser: "./src/lib/empty.ts" },
      crypto: { browser: "./src/lib/empty.ts" },
    },
  },
  ...(STATIC
    ? { output: "export" as const }
    : {
        // Browsers still request /favicon.ico on their own.
        async rewrites() {
          return [{ source: "/favicon.ico", destination: "/icon.svg" }];
        },
        async headers() {
          return [
            { source: "/:path*", headers: securityHeaders },
            { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
          ];
        },
      }),
};

export default nextConfig;
