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

**Static build (free to host).** Plain files for any static host. Every tool runs in the browser. Word, Excel, PowerPoint and HTML files are laid out in the browser and saved through its print dialog ("Save as PDF"). There are no accounts and nothing to run on a server.

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

Open http://localhost:3000. `npm install` also copies the PDF.js worker and the qpdf WebAssembly file into `public/vendor`.

## Deploying the static build

```bash
npm run build:static
```

This writes the site to `out/`, including a `_headers` file for security and caching headers.

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
- OCR downloads its engine and language data from the jsDelivr CDN on first use. Your files are not sent.
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
