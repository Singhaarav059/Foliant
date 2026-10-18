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

**Server build (self-hosted).** A Node.js app for running on your own server, for example inside a school or an office, behind a reverse proxy (see [Running the server build](#running-the-server-build)). The static build is the one to host publicly. The server build adds:

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
| `MAX_UPLOAD_MB` | Largest Office file the server accepts. Default 200. HTML uploads are capped at 10 MB and JSON requests at 64 KB. |
| `TRUST_PROXY_HOPS` | How many reverse proxies sit in front of the app. Default 1. Rate limits key on the address the outermost trusted proxy appended to `X-Forwarded-For`; anything to its left is ignored. |
| `MAX_CHROME_JOBS` | Chrome pages printing at once. Default 2; eight more wait, then the server answers busy. |
| `MAX_OFFICE_JOBS` | Office conversions at once. Default 2; four more wait. |
| `MAX_SUBPROCESS_MB` | Linux only: address-space cap for LibreOffice, through `prlimit`. Off by default; LibreOffice reserves far more than it uses, so measure before setting it, or cap memory on the container. |

For the most faithful Office conversions, install LibreOffice and the fonts your documents use. Microsoft's core fonts, or the metric-compatible Carlito, Caladea and Liberation fonts, fix most layout shifts.

### Deploying it safely

- **Put a reverse proxy in front** (Caddy, nginx, a load balancer) that terminates HTTPS and appends the client's address to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, Caddy does it by default). Don't expose `next start` directly: a client talking to it directly can choose its own `X-Forwarded-For` and dodge the rate limits.
- **Serve it over HTTPS.** In production the session cookie is `__Host-session` (Secure, HttpOnly, SameSite=Lax), which browsers only store over HTTPS. The app also sends `Strict-Transport-Security`.
- **Set `AUTH_SECRET`** to a long random value and keep `DATA_DIR` out of the web root.
- **Run one instance**, or put a shared store behind `src/lib/server/limits.ts`: rate limits and the sign-in lockout live in memory.
- **Give the container no route to anything private** if you can. The app already blocks it (below); a network policy makes it a second wall.

What the server build does to protect itself:

- **Web capture can't reach your network.** Chrome's only way out is a small proxy inside the app (`src/lib/server/egress.ts`). The proxy resolves each host once, refuses private, loopback, link-local, cloud-metadata, NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), Teredo, IPv4-mapped and other non-public addresses, then connects to the address it checked, so DNS rebinding can't switch it. Redirects go through the proxy too. Chrome can't resolve names itself or open WebRTC sockets, and only http, https, data and blob URLs load. Ports below 1024 other than 80 and 443 are refused.
- **Uploads are checked before they're parsed.** Bodies over the limit are refused as soon as the declared or streamed size passes it, and a file's content must match its extension (a .docx must be a zip, a .doc an OLE file, and so on).
- **LibreOffice runs locked down**: a fresh profile per file with macros, embedded objects and linked content (files, images, URLs, `WEBSERVICE()`) turned off; its own process group, killed with all its children after two minutes or 1 MB of output; and none of the server's environment variables.
- **Accounts**: 20 sign-in attempts per address and 10 failed attempts per account per 15 minutes; password changes and account deletion are limited per account too. Every sign-in issues a new session token; signing out revokes it and changing the password ends every other session.
- **Cross-site requests can't change anything**: state-changing routes check `Sec-Fetch-Site` (or `Origin`) and JSON routes accept only `application/json`.
- **Errors say nothing about the server**: failures are logged on the server and answered with a plain message.

`npm run test:server` checks these rules in Node and `npm run test:server-routes` checks them through `next start` on a server build; CI runs both.

## Privacy notes

- On-device tools never send files anywhere. Server tools (server build only) delete files as soon as the result is returned.
- Everything, including OCR and fonts, is served from your own site. Nothing is loaded from a CDN.
- No analytics, ads or tracking cookies.

The privacy policy, terms and cookie pages in `src/lib/legal.ts` are drafts. They name the operator from the settings above; have them reviewed before going live.

## Project layout

```
src/app/[lang]/        pages, one copy per language
src/app/api/           server routes (*.server.ts, left out of static builds)
src/components/        UI, including the tool workspace
src/lib/tools.ts       every tool, its options and accepted files
src/lib/pdf/           in-browser PDF processing (pdf-lib, PDF.js, qpdf, Tesseract)
src/lib/office/        Word/Excel/PowerPoint to printable HTML, shared by both builds
src/lib/server/        accounts, database, Chrome and LibreOffice helpers, egress proxy, limits
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
