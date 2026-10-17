# Foliant

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

**Static build (free to host).** Plain files for any static host. Every tool runs in the browser. Word, Excel, PowerPoint and HTML files are laid out in the browser and saved through its print dialog ("Save as PDF"), or, with **High fidelity**, converted by LibreOffice running in the browser into a real PDF (also the only way to open .doc, .xls, .ppt and OpenDocument files there). There are no accounts and nothing to run on a server.

High fidelity downloads about 79 MB the first time and needs about 1 GB of memory, so it's for desktops. LibreOffice runs threads, which browsers only allow on cross-origin isolated pages: the site sends `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (from `security-headers.json`, written into `_headers` for Cloudflare Pages and Netlify), and on hosts that can't send headers, such as GitHub Pages, the service worker adds them from the second page load on.

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

Open http://localhost:3000. `npm install` also copies everything the browser loads at runtime into `public/vendor` (see `scripts/vendor.mjs`): the PDF.js worker and its font and image-decoder data, qpdf, MozJPEG (for Compress), PDFium (for Redact), LibreOffice (high-fidelity Office to PDF, in 20 MiB parts), the Tesseract OCR engine, PaddleOCR models with ONNX Runtime (high-accuracy OCR, about 36 MB, fetched only when chosen) with all 26 language files, Noto fonts for text the tools add to PDFs, and metric-compatible stand-ins (Arimo, Tinos, Cousine, Carlito, Caladea) that PDF/A conversion embeds for fonts a file names but doesn't include. The site never loads anything from another domain, and the static build is about 100 MB of that, mostly OCR data.

## Deploying the static build

```bash
npm run build:static
```

This writes the site to `out/`, including a `_headers` file for security and caching headers, `sitemap.xml`, `robots.txt` and a social card per tool in `out/og/`.

Before going live, set the site's address when building (in the host's build settings, or in `.env.production.local`). Canonical links, language alternates, the sitemap and social cards use it:

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | The public address, for example `https://pdf.example.com`, with no path. |

Until it is set, pages use the placeholder in `src/lib/brand.ts`. Build with `FOLIANT_RELEASE=1` for the real deployment: the build then stops if any of these settings is missing, so placeholders can't go live. Other builds, CI's included, don't check.

The PNG and ICO icons in `public/` are drawn from `public/icon.svg` and `public/icon-maskable.svg`; run `node scripts/icons.mjs` after changing either.

**Cloudflare Pages:** build command `npm run build:static`, output directory `out`. Missing pages get the right language's 404 page.

**GitHub Pages and other static hosts:** upload `out/`. The site must be served from the root of a domain (for example `username.github.io` or a custom domain), not from a sub-path.

Set `NEXT_PUBLIC_REPO_URL` (for example `https://github.com/you/foliant`) when building to add "Source code" and "Contact" (GitHub issues) links to the footer.

## Running the server build

```bash
npm run build
npm start
```

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
- Everything, including OCR and fonts, is served from your own site. Nothing is loaded from a CDN.
- No analytics, ads or tracking cookies.

The privacy policy, terms and cookie pages in `src/lib/legal.ts` are drafts. Fill in who runs your site and have them reviewed before going live.

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

Pass browser names to run only some (`npm run test:e2e -- webkit`), and set `CHROME_PATH` to use an installed Chrome. The OCR test downloads the English language data from jsDelivr.

GitHub Actions (`.github/workflows/ci.yml`) runs all of this on every push to `main` and every pull request, with one end-to-end job per browser.

## Licence

MIT. See [LICENSE](LICENSE). The libraries Foliant uses keep their own licences.
