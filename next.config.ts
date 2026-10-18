import type { NextConfig } from "next";
import securityHeaders from "./security-headers.json";
import pkg from "./package.json";
import { releaseGaps } from "./src/lib/brand";

// NOPLOAD_STATIC=1 builds the free hosted version: plain files in ./out that
// any static host can serve. Everything runs in the browser, and files named
// *.server.ts(x) (API routes, the locale proxy, account and contact pages)
// are left out; *.static.tsx pages (the language picker at "/", per-language
// 404s) are only built here.
const STATIC = process.env.NOPLOAD_STATIC === "1";

// NOPLOAD_RELEASE=1 marks a build that goes live: it stops while any site
// setting in src/lib/brand.ts is still a placeholder. Other builds, CI's
// included, run with the placeholders.
if (process.env.NOPLOAD_RELEASE === "1" && releaseGaps().length) {
  throw new Error(`Release build stopped. Set these first (see src/lib/brand.ts):\n  - ${releaseGaps().join("\n  - ")}`);
}

// Source code and issue links, from package.json unless set.
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

const nextConfig: NextConfig = {
  // Both imply partial prerendering, which static exports can't do.
  cacheComponents: !STATIC,
  partialPrefetching: !STATIC,
  // out/404.html is src/app/global-not-found.static.tsx, the language picker.
  experimental: { globalNotFound: STATIC },
  pageExtensions: STATIC ? ["tsx", "ts", "static.tsx"] : ["tsx", "ts", "server.ts", "server.tsx"],
  env: { NEXT_PUBLIC_STATIC: STATIC ? "1" : "", NEXT_PUBLIC_REPO_URL: REPO_URL },
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
        async headers() {
          return [
            { source: "/:path*", headers: securityHeaders },
            { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
          ];
        },
      }),
};

export default nextConfig;
