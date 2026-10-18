# Nopload

A free, open-source PDF toolkit that works in your browser. Most tools never upload your files: the work happens on your own device, and the site keeps working offline once installed.

## Tools

| | |
|---|---|
| **Organise** | Merge, split, extract pages, remove pages, organise (reorder, rotate, insert), scan to PDF with the camera |
| **Optimise** | Compress, repair, OCR (makes scans searchable, 26 languages) |
| **Convert to PDF** | Images, Word, PowerPoint, Excel/CSV, web pages or HTML files |
| **Convert from PDF** | Images (JPG/PNG), Word, PowerPoint, Excel, PDF/A, Markdown |
| **Edit** | Rotate, page numbers, watermark, crop, edit (text, images, shapes, drawing), fill and create forms |
| **Security** | Unlock, protect with a password, sign, redact (removes the text, not just covers it), compare two versions |

Also: saved workflows that run several tools in a row, "continue with" another tool without downloading, an installable offline app, and 26 interface languages including right-to-left Arabic.

## Two ways to run it

**Static build (free to host).** Plain files for any static host. Every tool runs in the browser. Word, Excel and PowerPoint files become a real PDF file through LibreOffice running in the browser (also the only way to open .doc, .xls, .ppt and OpenDocument files there). On phones and small devices, or with **Standard** fidelity, they are laid out in the browser and saved through its print dialog ("Save as PDF") instead, as HTML files always are. There are no accounts and nothing to run on a server.

LibreOffice downloads about 79 MB the first time (the tool asks once) and needs about 1 GB of memory, so **Automatic**, the default, uses it on computers with 4 GB or more and prints elsewhere. LibreOffice runs threads, which browsers only allow on cross-origin isolated pages: the site sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (from `security-headers.json`, written into `_headers` for Cloudflare Pages and Netlify), and on hosts that can't send headers, such as GitHub Pages, the service worker adds them: the first conversion keeps the files in IndexedDB, reloads the page once and carries on.

**Server build (self-hosted).** A Node.js app. It adds:

- Office conversion on the server, with LibreOffice if installed (best fidelity) or a built-in converter that prints through Chrome
- web page capture from a URL (needs Chrome on the server)
- accounts, with workflows that sync across devices and recent activity
- a contact form

## Quick start

Needs Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000. `npm install` also copies everything the browser loads at runtime into `public/vendor` (see `scripts/vendor.mjs`): the PDF.js worker and its font and image-decoder data, qpdf, MozJPEG (for Compress), PDFium (for Redact), LibreOffice (high-fidelity Office to PDF, in 20 MiB parts), the Tesseract OCR engine, PaddleOCR models with ONNX Runtime (high-accuracy OCR, about 36 MB, fetched only when chosen) with all 26 language files, Noto fonts for text the tools add to PDFs, and metric-compatible stand-ins (Arimo, Tinos, Cousine, Carlito, Caladea) that PDF/A conversion embeds for fonts a file names but doesn't include. The site never loads anything from another domain. The static build is about 450 MB in about 7,800 files, most of it this vendored data (LibreOffice alone is 77 MB); each visitor downloads only what the tools they use need.

## Deploying the static build

```bash
NOPLOAD_RELEASE=1 npm run build:static
```

This writes the site to `out/`, including a `_headers` file for security and caching headers, a `.nojekyll` file for GitHub Pages, `sitemap.xml`, `robots.txt` and a social card per tool in `out/og/`. The build fails if `out/` has more than 18,000 files or any file over 24 MiB, so it always fits Cloudflare Pages' free plan.

Before going live, set where the site lives and who runs it when building (in the host's build settings, or in `.env.production.local`):

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | The public address, for example `https://pdf.example.com`, with no path. Canonical links, language alternates, the sitemap and social cards use it. |
| `NEXT_PUBLIC_OPERATOR_NAME` | Who runs the site, a person or a company, as the privacy policy and terms name them. |
| `NEXT_PUBLIC_OPERATOR_COUNTRY` | Where the operator is based. Its law governs the terms. |
| `NEXT_PUBLIC_OPERATOR_CONTACT` | An email address or an `https://` page. The privacy policy, terms, About page and footer link to it. |
| `NEXT_PUBLIC_REPO_URL` | Optional. The source code, for the "Source code" and "Report a problem" (GitHub issues) links. Defaults to `repository` in `package.json`. |

Until it is set, pages use the placeholder in `src/lib/brand.ts`. `NOPLOAD_RELEASE=1` marks the build for the real deployment: it then stops if any of these settings is missing, so placeholders can't go live. Leave it out for local and CI builds, which run with the placeholders.

The PNG and ICO icons in `public/` are drawn from `public/icon.svg` and `public/icon-maskable.svg`; run `node scripts/icons.mjs` after changing either.

**Cloudflare Pages (recommended):** build command `NOPLOAD_RELEASE=1 npm run build:static`, output directory `out`, with the settings above as the project's environment variables. It reads `_headers`, so pages are cross-origin isolated from the first visit (high-fidelity Office conversion works straight away), hashed assets are cached for a year, and missing pages get the right language's 404 page. The free plan has unlimited bandwidth.

Other hosts work with limits (upload `out/` from a release build, as above):

- **GitHub Pages** ignores `_headers`: there's no long-term caching, and high-fidelity Office conversion needs a second page load (the service worker adds the isolation headers). Deploy with a GitHub Actions workflow (`actions/upload-pages-artifact`); `.nojekyll` keeps `_next/` if you push `out/` to a branch instead. Sites are limited to 1 GB and a soft 100 GB of traffic a month.
- **Netlify** reads `_headers`, but its free plan is credit-based (300 credits a month at 20 per GB, about 15 GB of traffic) and pauses the site when they run out.

The site must be served from the root of a domain (for example `nopload.example` or `username.github.io`), not from a sub-path.

### Keeping an eye on the live site

`.github/workflows/live.yml` checks the deployed site every Monday: the headers above, real 404s, 20 random pages, and the end-to-end tests run against it. Set the repository variable `SITE_URL` (Settings → Secrets and variables → Actions → Variables) to your site's address. The header checks expect a host that applies `_headers` (Cloudflare Pages or Netlify); on GitHub Pages also set the variable `HOST_HEADERS` to `none`, which keeps the page and file checks and skips the header and first-visit isolation ones. A failed run emails the repository owner. The workflow re-enables itself on each run, because GitHub switches off scheduled workflows in public repositories after 60 days without commits. To check any address by hand, run `node scripts/live-check.mjs https://your.site`, or start the workflow from the Actions tab.

Dependabot (`.github/dependabot.yml`) opens one pull request a month to update the pinned GitHub Actions.

## Running the server build

```bash
NOPLOAD_RELEASE=1 npm run build
npm start
```

The site settings above apply here too, and `NOPLOAD_RELEASE=1` checks them the same way.

| Variable | What it does |
|---|---|
| `AUTH_SECRET` | Signs session cookies. Set a long random value in production. Without it, a secret is generated in `DATA_DIR` on first run. |
| `DATA_DIR` | Where the SQLite database and generated secret live. Default `./data`. |
| `CHROME_PATH` | Chrome or Chromium binary for web page and built-in Office conversion. Common install paths are found automatically. |
| `SOFFICE_PATH` | LibreOffice binary. Common install paths are found automatically. |
| `MAX_UPLOAD_MB` | Largest file the server accepts. Default 200. |

For the most faithful Office conversions, install LibreOffice and the fonts your documents use. Microsoft's core fonts, or the metric-compatible Carlito, Caladea and Liberation fonts, fix most layout shifts.

## Privacy notes

- On-device tools never send files anywhere. Server tools (server build only) delete files as soon as the result is returned.
- Everything, including OCR and fonts, is served from your own site. Nothing is loaded from a CDN, and the static build fails if a page or stylesheet loads anything from another site.
- No analytics, ads or tracking cookies.
- The browser enforces it: every response carries a Content-Security-Policy (`security-headers.json`) that allows connections, scripts, images, fonts and frames only from the site itself (plus `blob:` and `data:`). The static build also puts a `<meta>` copy in every page for hosts that ignore `_headers`. LibreOffice's worker scripts get the same policy plus `'unsafe-eval'`, which its WebAssembly glue needs; a worker's policy comes from its own response, so pages don't get it. That rule uses Cloudflare's `! Header` syntax to replace the site-wide policy; on hosts without it, LibreOffice fails and Office files fall back to printing.
- Each tool page shows a live count of what it has sent: bytes uploaded (measured by the service worker), requests to other sites (Resource Timing) and requests the policy blocked. `/{lang}/security#check` explains how to check it yourself.

The privacy policy, terms and cookie pages in `src/lib/legal.ts` are drafts. They name the operator from the settings above; have them reviewed before going live.

## Project layout

```
src/app/[lang]/        pages, one copy per language
src/app/api/           server routes (*.server.ts, left out of static builds)
src/components/        UI, including the tool workspace
src/lib/tools.ts       every tool, its options and accepted files
src/lib/pdf/           in-browser PDF processing (pdf-lib, PDF.js, qpdf, Tesseract)
src/lib/office/        Word/Excel/PowerPoint to printable HTML, shared by both builds
src/lib/server/        accounts, database, Chrome and LibreOffice helpers
src/lib/i18n/dict/     translations; en.ts is the source of truth
```

Files named `*.server.ts(x)` exist only in the server build, and `*.static.tsx` pages only in the static build (see `next.config.ts`).

## Translations

English (`src/lib/i18n/dict/en.ts`) defines every string. Other languages override it, and missing keys fall back to English. To check coverage and placeholders:

```bash
node scripts/i18n-check.mjs
```

## Checks

```bash
npm run typecheck
npm run lint
npm run i18n:check
npm run build
npm run build:static
```

End-to-end tests drive real tools (merge, split, OCR, protect and unlock, Office print preview, workflows and more) in Chromium, Firefox and WebKit against the static build:

```bash
npm run build:static
npm run serve:static &
npx playwright-core install chromium firefox webkit
npm run test:e2e
```

Pass browser names to run only some (`npm run test:e2e -- webkit`), and set `CHROME_PATH` to use an installed Chrome. `serve:static` sends the headers from `out/_headers`, as Cloudflare Pages does. New end-to-end tests go in `tests/e2e/`, one file per area. `npm run test:e2e-office` converts Word and Excel files with the default options in a fresh browser, serving the build itself without the isolation headers, as GitHub Pages would.

The engine suites (`npm run test:tables`, `test:layout`, `test:compress`, `test:ocr`, `test:redact`, `test:office`, `test:libreoffice`, `test:ocr-accuracy`, `test:pdfa`) run in Node; `test:office` and `test:ocr-accuracy` also drive Chrome.

`npm run test:robust` generates about 50 hostile PDFs (damaged files, every kind of encryption, looped page trees, odd page boxes, unusual image codecs, decompression bombs and more; see `tests/robustness/gen.mjs`) and runs every engine on each in its own process, with a time and memory limit. Cases that fail today are listed in `tests/robustness/known-failures.json` with the backlog item that fixes them and how they fail; CI runs `npm run test:robust -- --known`, which fails on anything new, on a listed case that starts failing another way (a new problem, an error, a hang or a crash), and on a listed case that starts passing, so the list only shrinks (`-- --known --prune` updates it). `npm run test:static` checks the build's file-count and file-size guards and the local static server.

GitHub Actions (`.github/workflows/ci.yml`) runs all of this on every push to `main` and every pull request, with one end-to-end job per browser. The runner image, actions, Node version (`.node-version`) and veraPDF image are pinned.

Building in a git worktree whose `node_modules` is a link into another checkout needs `TURBOPACK_ROOT` set to a folder that contains both.

## Licence

MIT. See [LICENSE](LICENSE). The libraries Nopload uses keep their own licences: `scripts/vendor.mjs` collects their licence texts into `public/vendor/licenses/<hash>/`, and the site lists them at `/{lang}/licenses`, including where to get LibreOffice's source code (MPL-2.0).
