import type { NextConfig } from "next";
import securityHeaders from "./security-headers.json";
import { releaseGaps } from "./src/lib/brand";

// FOLIANT_STATIC=1 builds the free hosted version: plain files in ./out that
// any static host can serve. Everything runs in the browser, and files named
// *.server.ts(x) (API routes, the locale proxy, account and contact pages)
// are left out; *.static.tsx pages (the language picker at "/", per-language
// 404s) are only built here.
const STATIC = process.env.FOLIANT_STATIC === "1";

// FOLIANT_RELEASE=1 marks a build that goes live: it stops while any site
// setting in src/lib/brand.ts is still a placeholder. Other builds, CI's
// included, run with the placeholders.
if (process.env.FOLIANT_RELEASE === "1" && releaseGaps().length) {
  throw new Error(`Release build stopped. Set these first (see src/lib/brand.ts):\n  - ${releaseGaps().join("\n  - ")}`);
}

const nextConfig: NextConfig = {
  // Both imply partial prerendering, which static exports can't do.
  cacheComponents: !STATIC,
  partialPrefetching: !STATIC,
  pageExtensions: STATIC ? ["tsx", "ts", "static.tsx"] : ["tsx", "ts", "server.ts", "server.tsx"],
  env: { NEXT_PUBLIC_STATIC: STATIC ? "1" : "" },
  // Server-side conversion libraries stay as plain Node requires.
  serverExternalPackages: ["playwright-core", "mammoth", "exceljs", "jszip"],
  turbopack: {
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
        async headers() {
          return [
            { source: "/:path*", headers: securityHeaders },
            { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
          ];
        },
      }),
};

export default nextConfig;
