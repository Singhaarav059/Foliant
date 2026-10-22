# Nopload: work status

Last updated: 2026-10-21. Backlog details: [backlog.json](backlog.json). Plan and iLovePDF scorecard: [plan.md](plan.md).

## The short version

All finished work is now in **one branch, `combined`**, in **one folder: `/Users/aarav/Claude/Projects/nopload-combined`**.
Nothing is on GitHub yet except `main`. Every older branch and side session is replaced by `combined`.

```
main (GitHub, P0 launch blockers)
 └─ combined  ← everything below, merged and type-checked on 2026-10-21
```

## Progress (cloud loop, branch `combined`)

Each run resumes at the first item not marked done.

- [x] 1. npm ci, build:static, fast tests (2026-10-22, Linux): all node test scripts, typecheck and lint pass. Fixed: test:server counted a killed zombie grandchild as alive. Notes: `npm ci` here needs `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` (its CUDA download from api.nuget.org gets reset); Playwright's bundled browser build doesn't match this container, so Chromium tests run with `CHROME_PATH=/opt/pw-browsers/chromium`; test:server-routes needs `npm run build` first.
- [x] 2. Robustness run (`test:robust -- --known`), Linux, 2026-10-22: 752/756 pass, 4 known failures (P3-04 cyclic tree, P0-09 Word odd boxes, P1-09 two memory cases), 0 new.
- [x] 3. Browser e2e (Chromium, WebKit, Firefox), 2026-10-22, with Playwright's own builds (Chromium 156, Firefox, WebKit) in a scratch folder: the container's preinstalled Chromium 141 is too old for pdf.js 6 (it needs `Map.prototype.getOrInsertComputed`), so page thumbnails, OCR and protect never finish there. Fixed: Word → PDF (Standard) hung in WebKit waiting for `document.fonts.ready` (now `src/lib/office/settled.ts`, shared with the drawing code); the tools smoke suite had no spec for chat, translate and verify-signature (added). Passing on every engine apart from these: `e2e-office` and `office-high` (LibreOffice) and the light-model AI test fail only when the machine is busy and pass when re-run alone; `test:e2e:tools` runs in Chromium only, as in CI. Question for the owner: users on Chrome older than about 145 (and other old engines) can't render PDFs at all with pdf.js 6's modern build; ship pdf.js's legacy build, or accept it?
- [x] 4a. P2-03 No limits and batch everything: tools that run in the browser take any size and number of files (the 200 MB / 100-file cap stays for the server build's uploads); past a device-memory budget (`src/lib/budget.ts`, navigator.deviceMemory) the workspace only warns. A batch shows each file's state while it runs. Crop (one box on every file), Redact (searches and quick marks run on every file) and OCR take several files. Copy updated in 25 languages. Tests: `test:batch`, crop/redact batch variants in `test:e2e:tools`. Not done: merge/split/rotate through qpdf for very large files (pdf-lib still parses them; it doesn't decode streams, so 2 × 300 MB fits a desktop tab).
- [x] 4b. P2-05 Folder workflows and recipe links: "Run on a folder" (Chromium desktop, File System Access API) runs the steps on every PDF in a folder and its subfolders and writes each result to a second folder, never overwriting one result with another; other browsers keep multi-select plus a ZIP. "Copy recipe link" puts the steps in the #fragment (`src/lib/recipe.ts`), never files or passwords; opening the link in a fresh profile loads them. Tests: `test:recipe`, two new cases in `tests/e2e/workflows.mjs` (recipe link in Chromium, Firefox, WebKit; 50-file folder in Chromium).
- [x] 4c. P2-07 Trust-grade redaction and PDF/A check: every redaction comes with a verification report (areas, searched texts looked for again in the result, OCR re-read of scanned pages, annotations, attachments and properties removed). New quick marks: card numbers (Luhn plus network length), IBAN (mod 97), Aadhaar (Verhoeff), PAN, US SSN and dates. Scanned pages are read with OCR before searching (Redact has an OCR language option) and redacted as images. Right-to-left lines are searched in reading order. PDF/A outputs get an in-browser check (`src/lib/pdf/pdfacheck.ts`: trailer, output intent, fonts embedded, actions, XMP and pdfaid, level-1 transparency) whose clause numbers match veraPDF's. Tests: `test:redact-trust`, new cases in `test:pdfa` (compared with veraPDF 1.30.3 when VERAPDF is set), report checks and a scanned-page variant in `test:e2e:tools`. Found, not fixed: with veraPDF 1.30.3 (CI pins 1.30.2) the PDF/A-3b output with an external file reference fails rules 6.8-3/6.8-4 (a Filespec without AFRelationship), and Arabic text drawn by our own stamps maps some shaped glyphs to nothing (pdf.js reads them as control characters; search now skips those).
- [x] 4d. P2-09 Document structure tools: six new tools (`src/lib/pdf/structure.ts`), each with a page in every language and a localized slug: Edit PDF metadata (Info + XMP, or clear everything), PDF bookmarks (an outline from the headings, nested by size, or remove), Flatten PDF (qpdf draws fields and annotations into the page), PDF attachments (add, extract, remove), Sanitize PDF (scripts, actions, links, attachments, metadata, optional form flattening; the result lists what went), Optimize PDF for web (qpdf --linearize). Tests: `test:structure` (title read back by pdf.js, a flattened form keeps its values as page text, `qpdf --check-linearization` passes), six specs in `tests/e2e/tools` (Chromium and WebKit; the tools suite can't run in Firefox here because headless Firefox can't take the fixture screenshot, and CI runs it in Chromium only). New tool names in ko/zh/th/ar/hi/id/ms/vi/sw were chosen without an existing term (e.g. "flatten", "sanitize"); a native speaker may want to adjust them.
- [x] 4e. P2-10 Print and scan helper tools: seven new tools with pages and localized slugs in every language: N-up PDF (2, 4 or 9 per sheet; `src/lib/pdf/impose.ts`), PDF booklet (saddle-stitch order, left or right binding), Remove blank pages (rendered at 50 dpi, ink share outside the margins, three sensitivities), Alternate & mix PDF (fronts and reversed backs of a scan), Resize PDF pages (A4, Letter, A3, A5, Legal; links move with the content), Grayscale PDF (`src/lib/pdf/gray.ts`: colour operators, images, palettes, shadings, annotations and form defaults; JPEG 2000 images, PostScript functions and mesh shadings are left and counted) and Add header and footer (`edit.ts`). Tests: `test:impose` (an 8-page booklet is [8,1] [2,7] [6,3] [4,5]; exactly 2 blank pages go; greyscale output has no RGB/CMYK image or colour operator), seven e2e tool specs (Chromium, WebKit). Translated tool names for N-up and header/footer were coined where no common term exists (e.g. ru "Несколько страниц на листе", ja "PDF 割り付け（N-up）"); worth a native check.
- [x] 4f. P2-12 Live previews: Add watermark, Add page numbers and Add header and footer show the first page they will draw on with the marks over it (`src/components/workspace/StampPreview.tsx`). The marks come from the tools' own drawing code (`edit.ts` `markLayer`, drawn on blank pages of the same size), so the preview matches the output within 2 pt (`test:preview`, every position, a turned and a landscape page). Opacity is applied by CSS and follows the slider in under 10 ms; other changes redraw after a 120 ms pause (`test:e2e:preview`, Chromium, Firefox, WebKit). Crop already previews its box live in the editor, so it needed no change.
- [x] 4g. P2-15 Bengali, Tamil, Telugu, Marathi, Urdu and Persian: six new UI languages (32 in all), every string machine-translated in three parts and then reviewed for consistent tool names, labels and terms; ur and fa are laid out right to left; `out/bn/merge-pdf.html` and the rest are built, with hreflang alternates for all 32 (`test:seo` now counts the dictionaries instead of a fixed 26). OCR models for all six were already vendored; `test:ocr-langs` reads a Bengali page set in Noto Sans Bengali at 0% CER (`tests/fixtures/images/bengali-scan.png`). The summarizer recognises Bengali, Tamil, Telugu, Urdu and Persian text. **Owner:** (1) the translations want a native speaker's spot-check before launch in those markets; (2) for watermarks, page numbers and headers in Bengali, Tamil and Telugu to be real text rather than a picture, add `@fontsource/noto-sans-bengali`, `@fontsource/noto-sans-tamil` and `@fontsource/noto-sans-telugu` (OFL) to package.json and commit the updated lockfile; `scripts/vendor.mjs` and `src/lib/pdf/fonts.ts` already pick them up when installed (I didn't add them, as lockfile changes are yours). Until then the e2e page-number check for Telugu is listed in `tests/e2e/tools/known-failures.json`. Marathi uses Noto Sans (Devanagari), and Urdu and Persian use Noto Sans Arabic, both already vendored.
- [ ] 4h. P2-16 Read aloud and accessible PDFs — in progress: both tools and their tests are committed (`test:pdfua`, `test:e2e:listen`); translations into the 31 other languages, slugs and the e2e run still to come.
- [ ] 4i. P3-01 Accessibility pass
- [ ] 4j. P3-02 Result messages and console output
- [ ] 4k. P3-03 Performance budget and service worker
- [ ] 4l. P3-04 Repair truncated files and looped page trees
- [ ] 4m. P3-07 Local form-autofill profile

Notes and open questions:

## What's in `combined`

| Item | What |
|---|---|
| P1-01 … P1-23 | Rounds 1 and 2 (OCR, Office, PDF/A, images, pages, PowerPoint, SEO, sign, summarize, …) |
| P1-05 | Split by size, KB, bookmarks |
| P1-09, P1-10 | Render safety, real Cancel |
| P1-14, P2-17 | More form field types, auto-detect fields |
| P1-15 | Edit a PDF's existing text |
| P2-01, P2-13, P2-18 | Privacy proof (CSP + bytes chip), Compare export, homepage promise |
| P2-02 | Compress to an exact size, exam photo kit, "compress PDF to N KB" pages |
| P2-04 | PWA share sheet and "Open with" |
| P2-06 | On-device AI (chat with citations, translate) |
| P2-08 | Digital signatures (PAdES) and a signature checker |
| P2-11 | Phone scanner v2 |
| P2-14 | Localized URLs and search hub pages |
| P2-19 | Office export options |
| P3-05 | Browser add-ons |
| P3-08 | Server hardening |
| fixes | Annotation text placement, fullwidth colons in option titles |
| translations | Tool-page help text in 18 languages (rescued from a temp folder) |

Naming note: the exact-size "compress PDF to N KB" pages are now called *landing pages* (`src/lib/landings.ts`, `LandingPage.tsx`), so they don't clash with the search *hub* pages (`src/lib/intents.ts`).

## Checked so far

- Type-check and lint: pass.
- Fast tests: seo, content, legal and static pass after the translation work (the other fast tests passed earlier).
- Browser tests (22 suites, Chromium and WebKit, plus add-on, Office and exact-size suites): all pass.
- Firefox: can't launch on this Mac (known); GitHub CI runs it.
- Bugs that combining caused, all fixed: signing (must append to the file's own bytes), HTML to PDF zips lost their CSS (security policy), and four tests that needed updating.
- Translations: all 25 languages complete (`npm run i18n:check` shows 1575/1575 each). The five new tools (exam photo kit, summarize, chat, translate, verify signature) have localized addresses and full help pages.

## Next steps (in order)

1. Commit `package-lock.json` in the combined folder (a permission rule stops Claude from touching lockfiles).
2. Robustness run (`npm run test:robust -- --known`).
3. Your go-ahead: fast-forward `main` to `combined`, push, confirm GitHub CI is green.
4. Then the last batch: P2-03, 05, 07, 09, 10, 12, 15, 16 and P3-01, 02, 03, 04, 07. (P3-06 Drive/Dropbox: not doing.)

## Owner to-do (only you can do these)

1. Buy nopload.com (or .app) after a trademark search (WIPO, USPTO, EUIPO).
2. Create a free Cloudflare account and connect the GitHub repo to Cloudflare Pages: build command `NOPLOAD_RELEASE=1 npm run build:static`, output `out`.
3. Set NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_OPERATOR_NAME, NEXT_PUBLIC_OPERATOR_COUNTRY, NEXT_PUBLIC_OPERATOR_CONTACT in Cloudflare, and the repository variable SITE_URL on GitHub.
4. Have src/lib/legal.ts reviewed.
5. Optional: Google Search Console, Bing Webmaster, Edge/Firefox add-on stores.
