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

// The cloud AI (functions/api/ai.ts, a Cloudflare Pages Function) is the AI
// tools' default in the static build; NOPLOAD_AI_CLOUD=0 leaves it out, for
// hosts that can't run it. The page still checks it's there before using it.
const AI_CLOUD = (process.env.NOPLOAD_AI_CLOUD ?? (STATIC ? "1" : "0")) === "1";

// NOPLOAD_RELEASE=1 marks a build that goes live: it stops while any site
// setting in src/lib/brand.ts is still a placeholder. Other builds, CI's
// included, run with the placeholders.
if (process.env.NOPLOAD_RELEASE === "1" && releaseGaps().length) {
  throw new Error(`Release build stopped. Set these first (see src/lib/brand.ts):\n  - ${releaseGaps().join("\n  - ")}`);
}

// Source code and issue links, from package.json unless set.
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL || pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

// The Content-Security-Policy, allowing eval: for next dev, which runs React's
// debugging code through it, and for LibreOffice's worker scripts, whose glue
// (embind) builds functions from strings. A worker's policy comes from its
// own response, so pages stay without it (scripts/static-extras.mjs does the
// same for static hosts).
const withEval = securityHeaders.map((h) =>
  h.key === "Content-Security-Policy" ? { ...h, value: h.value.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'") } : h,
);
const evalCsp = withEval.filter((h) => h.key === "Content-Security-Policy");

// Headers only the server build sends (a static host gets its own from
// scripts/static-extras.mjs): no framing by other sites (the policy's
// frame-ancestors, and X-Frame-Options for old browsers), HTTPS from now on,
// and API answers that are never cached.
const serverHeaders = [
  ...(process.env.NODE_ENV === "development" ? withEval : securityHeaders),
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Both imply partial prerendering, which static exports can't do.
  cacheComponents: !STATIC,
  partialPrefetching: !STATIC,
  // out/404.html is src/app/global-not-found.static.tsx, the language picker.
  experimental: { globalNotFound: STATIC },
  pageExtensions: STATIC ? ["tsx", "ts", "static.tsx"] : ["tsx", "ts", "server.ts", "server.tsx"],
  env: { NEXT_PUBLIC_STATIC: STATIC ? "1" : "", NEXT_PUBLIC_AI_CLOUD: AI_CLOUD ? "1" : "", NEXT_PUBLIC_REPO_URL: REPO_URL },
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
      // Transformers.js (src/lib/ai/worker.ts) imports ONNX Runtime's build that
      // bundles its 27 MB .wasm, over the host's file limit. This build takes
      // the .wasm at run time instead, from /vendor (scripts/vendor.mjs).
      "onnxruntime-web/webgpu": "./node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs",
    },
  },
  ...(STATIC
    ? { output: "export" as const }
    : {
        async headers() {
          return [
            { source: "/:path*", headers: serverHeaders },
            { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
            // Last, so it replaces the policy above (Next keeps the last value per header).
            { source: "/vendor/:build/libreoffice/:file*", headers: evalCsp },
            { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
          ];
        },
      }),
};

export default nextConfig;
