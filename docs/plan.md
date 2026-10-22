# Foliant vs iLovePDF: product plan (2026-10-17, HEAD 7e775ad)

## 0. Headline

**Foliant already wins on price, caps, privacy, ads and breadth, but it is not launchable yet.**

New evidence from this synthesis. I checked the public GitHub API today: CI is red on all 5 jobs for HEAD and for the 2 commits before it (run 39015444608).
- **Typecheck fails** with `Cannot find name 'PageProps'/'LayoutProps'` in `src/app/[lang]/page.tsx:10`, `src/app/[lang]/layout.tsx:22,43` and `src/app/[lang]/[slug]/page.tsx:29,41,49`.
- **e2e fails** in chromium, firefox and webkit.
- **The `pdf` job stops at `test:office`.** So `test:libreoffice`, `test:ocr-accuracy` and the veraPDF-backed `test:pdfa` never ran in CI.
- **The runner is about to change.** `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19.

Other blocking problems, each reproduced by an adversarial verifier:
- **Data leaks:**
  - Redaction misses text on pages with unusual page boxes.
  - Redacted files still contain the removed link URLs.
  - Phrase search misses text that is split across runs.
  - Split, extract and remove-pages keep the content of every linked page.
- **Rotate PDF returns unrotated files.**
- **Offline mode is broken.** The service worker never caches the JS chunks.
- **Word, PowerPoint and Excel to PDF** give a print preview by default, not a PDF file.
- **Excel output can be silently wrong.** Rotated pages turn 980 into 89.
- **PDF→Word drops scans that carry a stamp.**
- **SEO basics are missing:** hreflang points to the language home pages, and there is no canonical, sitemap, robots file or OG tags.

**Scorecard:** better on 10 rows, equal on 6, worse on 21, missing on 4 (41 rows). Most "worse" rows are fixable bugs or missing options, not missing engines.

**Strategy:** "Everything iLovePDF Premium does, free and unmetered, and your browser proves nothing is uploaded." Add India and mobile intents (exact-KB compression, exam-form kit, HEIC, a phone scanner that needs no app) and private on-device AI.

**Backlog:** 19 P0, 23 P1, 19 P2, 8 P3, merged from 7 recon agents. Each item has files, an approach with licences, and an acceptance test that fails today.

---

## 1. iLovePDF catalogue (behavioural, clean-room, observed from India on 2026-10-17)

"F" is the free tier. Limits are given as MB / files / pages. Evidence is the public HTML `ilovepdfConfig`, the app.js bundle and the pricing and help pages.

| Tool | Free limit | Premium | Options / notes |
|---|---|---|---|
| Merge | 100 MB / 25 | 4000 / 500 | reorder, sort, rotate files; password inputs prompt |
| Split (+ Remove, Extract) | 100 / 1 | 4000 / 1 | custom or fixed ranges, extract pages; split by size is Premium; AI "Smart" split is Premium; no split by bookmarks |
| Organize | 100 / 5 | 4000 / 20 | drag, delete, add, sort, mix |
| Scan to PDF | needs their mobile app (QR + websocket) | – | page size, margin, merge |
| Compress | 200 / 2 | 4000 / 10 | 3 presets only; no target size, DPI or greyscale |
| Repair | 100 / 1 | 4000 / 10 | no options |
| OCR | 15 / 1 / 50 pages | 4000 / 10 / 1000 | 121 languages, multi-select, math detection; language codes match Tesseract's |
| JPG→PDF | 40 / 20 | 4000 / 80 | jpg, png, tiff only; Fit/A4/Letter; 3 margin steps |
| Word / PPT / Excel → PDF | 15 / 1 | 4000 / 10 | no options |
| HTML→PDF | unknown | – | URL, upload, paste; 5 viewports; A3/A4/A5/Letter; one long page; ad and overlay blocking |
| PDF→JPG | 25 / 2 | 4000 / 10 | JPG only, 150 or 300 dpi, page or extract mode |
| PDF→Word / PPT / Excel | 15 / 1 | 4000 / 10 | OCR is Premium (25 languages); third-party engine |
| PDF→PDF/A | Premium only | 4000 / 10 | 8 conformance levels plus downgrade; no validation on the web |
| Edit | 100 / 1 | 100 / 1 | add text, images, shapes; edit existing text; z-order |
| Rotate | 100 / 20 | 4000 / 80 | whole file, 90° steps, portrait/landscape filter |
| Page numbers | 100 / 2 | 4000 / 10 | 3×3 grid, custom template with page and total tokens, 9 fonts, skip last pages |
| Watermark | 100 / 2 | 4000 / 10 | text or image, 4 opacity steps, 5 angles, mosaic, over/under |
| Crop | 100 / 1 | 4000 / 1 | drag a box; all pages or one |
| Forms | 15 / 1 | 100 / 1 | AI auto-detect; text, checkbox, radio, list |
| Unlock / Protect | 100 / 2 | 4000 / 10 / 80 | 7 permission flags; encryption algorithm unknown |
| Sign | 50 MB, 3 files | 5 files | stamp, name, date, multi-signer requests; digital (certificate) signing is Premium |
| Redact | 400 / 1 | 400 / 1 | search and presets; AI "Smart" redaction is Premium; no right-to-left; scans need OCR first |
| Compare | 400 / 2, probably login | – | text and overlay modes, scroll sync, report |
| AI Summarizer / Translate / Markdown | about 1 free task / 15 MB, 30 pages | 100k words / 500 pages | summary language fixed to the UI language; translates into 28 languages |
| Workflows | Premium plus login | – | tool chaining |

**Site-wide**
- Every file is uploaded to 93–135 worker hosts in 2 MB chunks and deleted within about 2 hours.
- First-use limit boost set by cookie.
- Ad tech on tool pages: Google Ad Manager, Criteo, OpenX, GA4.
- 26 languages; localized URL slugs only for es, de and fr; no hreflang; no JSON-LD.
- Premium costs ₹500/month or ₹2,900/year.

**User pain points:** uploads, small free caps, paywalls on OCR→Office, PDF/A, size split, digital signing and AI, ads, single-file advanced tools, and an app required for scanning.

---

## 2. Scorecard: every iLovePDF tool vs Foliant

| iLovePDF tool | Verdict | Deciding evidence | Backlog |
|---|---|---|---|
| Merge | **Equal** | Better: no account, 100 files/200 MB vs 25 files/100 MB, 320 pages in 0.63 s. Worse: drops AcroForm fields, attachments and source bookmarks (verified fields 5→0, attachments 2→0). | P1-04 |
| Split | **Better** | Better: split by size is free (Premium there), plus every-N. Worse: size mode is O(n²) (84 s for 1,500 pages), no KB unit, linked-page bloat (61×). | P0-06, P1-05 |
| Remove pages | **Worse** until P0-06 | Removed pages stay inside the file when a kept page links to them (verified privacy leak); no Shift-click ranges. | P0-06, P1-06 |
| Extract pages | **Worse** until P0-06 | Same hidden-page leak. | P0-06 |
| Organize | **Better** | Per-page rotate, duplicate, blank page; missing interleave and reset. | P1-06 |
| Scan to PDF | **Better** (access) | Any phone browser camera vs app plus QR pairing; missing edge detection, orientation and margin. | P2-11 |
| Compress | **Equal** | Same 3 presets with no caps (vs 2 files free). CMYK, 16-bit and Indexed images untouched; a 1 MB orphan-stream file costs 1.6–2.3 GB RSS. Head-to-head ratio unknown. | P1-07, P2-02 |
| Repair | **Equal** | 3 fallback stages; a truncated file with intact objects is not recovered; quality vs iLovePDF unknown. | P3-04 |
| OCR | **Worse** | 26 languages, single-select, vs 121 multi-select plus math. Better: free, no 15 MB/50-page cap, PaddleOCR mode. Bugs: high-accuracy mode has 70% CER on Greek, and Paddle returns 0 words for pages turned 90° clockwise or 180°. | P0-13, P1-16 |
| JPG→PDF | **Better** | Accepts jpg/png/webp/gif/bmp plus auto orientation. Worse: no TIFF (iLovePDF has it); HEIC is accepted but fails in every Chromium (verified on Chrome 155). | P0-12, P1-08 |
| Word→PDF | **Worse** | Static default is a print preview, not a file. High fidelity is a 79 MB download and fails on first visit without isolation headers. Better: no 15 MB/1-file cap; local. | P0-15, P1-02 |
| PowerPoint→PDF | **Worse** | Same print-preview path. | P0-15 |
| Excel→PDF | **Worse** | Same print-preview path. Better once in main: high fidelity fits sheets to the page width or one page each and exports chosen sheets, which iLovePDF lacks (P2-19, merged into launch/p1b, not yet main). | P0-15, P2-19 |
| HTML→PDF | **Worse** | Static build has no URL, paste or zip input and 2 page sizes, yet the page claims "any web page". Remote assets are blocked under COEP, or leak the user's IP elsewhere. | P1-18 |
| PDF→JPG | **Better** | JPG plus PNG at 72/150/300 dpi vs JPG only. Extract mode skips ICC, Indexed and alpha images. One oversized page fails the whole job. | P1-09 |
| PDF→Word | **Worse** | Digital PDFs: 96–98% word recall. Scans: empty docx and no OCR option (iLovePDF has OCR as Premium). A scan with a 20+ character stamp loses its images silently. | P0-09, P1-01 |
| PDF→PowerPoint | **Worse** | Page is a raster background; all text forced to #1F2937. | P1-19 |
| PDF→Excel | **Worse** | Tables rebuild well (5/5 rows on a borderless sheet), but rotated pages give wrong numbers (980→89, 1,200→21). No OCR. Crash on sheet names with `:?[]`. | P0-08, P1-01, P1-03 |
| PDF→PDF/A | **Better** (price) | Free vs Premium-only. veraPDF passed on 15 files in an earlier session (project memory, not re-run). Only level 2b (vs 8); CI veraPDF has never run. | P1-17, P2-07 |
| PDF→Markdown | **Better** | No 15 MB/30-page cap; page-break option. | – |
| Edit | **Worse** | Overlays only: cannot edit, move or delete existing text; no z-order; text-tool focus race drops keystrokes. | P1-15, P1-13 |
| Rotate | **Worse (broken)** | The main control returns an unrotated file (verified [0,0,0]). One file only. Crash on /Rotate 45. | P0-02, P1-06, P1-03 |
| Page numbers | **Worse** | 4 fixed formats, fixed margin, no font or skip-last option; labels missing on odd-box pages. | P1-11, P0-03 |
| Watermark | **Equal** | Continuous opacity is better; no font family or background; CJK mark not searchable. | P1-11 |
| Crop | **Better** | Auto-crop. | – |
| Forms | **Worse** | Text and checkbox fields only; no auto-detect (flatten exists). | P1-14, P2-17 |
| Unlock | **Equal** | Same; owner-password-only files open in other tools only after P1-03. | P1-03 |
| Protect | **Worse** | 3 permissions and no owner password. Passwords over 127 bytes give files pdf.js, qpdf and Foliant's own Unlock cannot open. Passwords starting with "-" or "@" fail. Better: AES-256, local. | P0-07, P1-12 |
| Sign | **Worse** | Signature, initials and date only; system fonts; no stamp, name, date formats or placement presets; no digital signature. Better: saved signatures, free. | P1-13, P2-08 |
| Redact | **Worse** until P0 | True content removal through PDFium. But it leaks on odd page boxes, keeps orphan link URLs, and misses phrases split across runs. | P0-03/04/05, P2-07 |
| Compare | **Worse** | No login, but one inserted page marks every page as changed, an unreadable file shows "0 changes", and there is no report export. | P0-11, P2-13 |
| AI Summarizer | **Missing** | – | P1-21, P2-06 |
| Translate PDF | **Missing** | – | P2-06 |
| Workflows | **Better** | Free, no account, export/import vs Premium plus login. | P2-05 |
| Desktop/mobile app, offline | **Worse (broken)** | Installable PWA, but offline is broken and the declared file handler drops the file. | P0-10, P2-04 |
| Cloud import | **Missing** | No Drive or Dropbox; no paste either. | P0-14, P3-06 |
| UI languages | **Equal** | 26 vs 26, all strings complete (489/489); legal pages English-only. | P0-17, P2-15 |
| SEO | **Worse** | Wrong and relative hreflang, no canonical, sitemap, robots or OG; about 90 words per tool page vs 364. | P0-16, P1-20 |
| Ads, trackers, caps | **Better** | 0 third-party requests in 186 audited runs; no ads; caps only 200 MB/100 files. | P2-01, P2-03 |
| Developer API | **Missing** (out of scope) | iLoveAPI; a server API conflicts with a free, launch-and-forget site. | – |
| Release quality gate | **Worse** | CI red on all 5 jobs at HEAD. | P0-01 |

---

## 3. Uniqueness strategy: 7 things, all zero-cost and in-browser

"Private / no upload" alone is now a commodity. HN shows 20+ browser-only PDF launches in 2025–26, most at 1–10 points, and iLovePDF keeps a 4.9 Trustpilot score despite uploading. Mass users leave because of quotas, paywalls and billing traps. So the wedge is to remove all meters, and then prove the privacy.

1. **"Premium, free, forever. Same on your 1st and 1,000th file."** Everything iLovePDF paywalls is free here: OCR→Office, PDF/A, split by size, digital signatures, workflows, offline app, AI. No caps beyond device memory, no account, no ads, no first-use boost cookies. Backlog: P1-01, P1-17, P2-03, P2-05, P2-08, P2-18.
2. **"Your browser blocks uploads. Check it yourself."** A CSP with `connect-src 'self'` makes the no-upload claim browser-enforced. A live "0 bytes left this device" chip, a step-by-step DevTools and airplane-mode check page, and a CI scan for off-origin URLs back it up. iLovePDF (uploads plus ad tech) cannot make this claim. Backlog: P2-01.
3. **Made for exam, KYC and government portals (India first).**
   - Compress to an exact size (100/200/500 KB).
   - Resize a photo and signature to exact pixels and KB.
   - HEIC and TIFF to PDF.
   - A phone-camera scanner with perspective correction and no app.
   - Hindi plus Bengali, Tamil, Telugu, Marathi and Urdu.
   Demand: "jpg to pdf" 4.8M, "word to pdf" 2.6M and "compress pdf" 1.6M (India), and portals with 200 KB caps. Backlog: P2-02, P1-08, P2-11, P2-15.
4. **Works offline, everywhere you open files.** Real offline after the service-worker fix. "Open with" and the phone share sheet go straight into a tool. Whole-folder batch workflows. Shareable recipe links kept in the URL fragment, which never reaches a server, give a free word-of-mouth loop. Backlog: P0-10, P2-04, P2-05.
5. **Private AI with no quotas.** Summarize, chat with page citations, and translate. Use Chrome's built-in Summarizer and Translator first, then small self-hosted Apache-2.0 models over WebGPU, then an extractive fallback for phones. The output language can differ from the UI language (iLovePDF locks it). Backlog: P1-21, P2-06.
6. **Security tools that prove their work.**
   - Redaction ends with a verification report: re-extract plus OCR, 0 matches left.
   - PDF/A comes with an in-browser conformance report.
   - Sign with your own .p12, and verify signatures.
   Backlog: P2-07, P2-08.
7. **Readable by everyone.** Read aloud with built-in speech, auto-tag for accessibility with alt-text suggestions, and South Asian languages. Backlog: P2-15, P2-16.

**Do not:**
- add analytics beacons, cloud pickers or CDNs that break promise 2;
- deploy the server build;
- chase tool count before the P0s are green.

**Zero-cost distribution, in order:**
1. Fix SEO (P0-16, P1-20).
2. Submit the sitemap to Google Search Console and Bing Webmaster.
3. Microsoft Store via PWABuilder (free individual account; needs the PNG icons from P0-16).
4. AlternativeTo listing under iLovePDF, Smallpdf and Adobe.
5. awesome-privacy and awesome-selfhosted PRs.
6. Show HN with one sharp, provable claim: browser-enforced privacy plus free AI.
7. Product Hunt.
8. README as a GEO document with a "Deploy your own" Cloudflare Pages path for schools and offices that block upload sites.

---

## 4. Prioritized backlog (summary; full items are in the structured `backlog`)

P0 = broken, crashing, security or launch blocker. P1 = parity gap on a high-demand tool. P2 = differentiator. P3 = polish.

| ID | Title | Effort | Depends on | Parallel-safe |
|---|---|---|---|---|
| P0-01 | Make CI green and trustworthy (red on all 5 jobs) | M | – | no |
| P0-02 | Rotate PDF returns unrotated files | S | P0-01 | no |
| P0-03 | Normalise page frame (redaction leak on odd page boxes) | S | – | no |
| P0-04 | Redaction output hygiene (orphan URLs, linked unredacted pages) | M | P0-03 | no |
| P0-05 | Redaction search across text runs | M | P0-04, P0-08 | no |
| P0-06 | Page subsets keep linked pages (privacy leak, 61× size) | M | P0-01 | no |
| P0-07 | Protect: password lockout and failures | S | P0-04, P0-12 | no |
| P0-08 | Rotated text corrupts Excel/Word/Markdown | M | – | no |
| P0-09 | PDF→Word never returns an empty or lossy document | M | – | yes |
| P0-10 | Fix offline service worker | M | P0-01 | no |
| P0-11 | Compare correctness | M | P0-12 | no |
| P0-12 | Error honesty layer (typed, localized errors) | M | P0-01 | no |
| P0-13 | OCR high-accuracy mode correctness plus test ceilings | M | P0-01 | no |
| P0-14 | File intake in every stage (drop, paste, before hydration) | M | P0-02 | no |
| P0-15 | Office→PDF gives a real PDF in one click | M | P0-01, P0-10 | no |
| P0-16 | SEO foundation (canonical, hreflang, sitemap, OG, icons) | M | P0-10, owner domain | no |
| P0-17 | Legal operator, third-party licences, contact | M | P0-16, owner | no |
| P0-18 | Launch-and-forget ops (live checks, guards, host docs) | S | P0-01, P0-16 | no |
| P0-19 | Hostile-input corpus in the repo | M | – | yes |
| P1-01 | Auto-OCR inside PDF→Word/Excel/PPT/Markdown | M | P0-09, P0-13 | no |
| P1-02 | Office→PDF on phones without the print dialog | L | P0-15 | no |
| P1-03 | Shared load pre-pass (owner-only, duplicates, cycles, /Rotate, sheet names) | M | P0-06, P0-07, P0-12, P0-19 | no |
| P1-04 | Merge keeps forms, attachments, bookmarks | M | P1-03 | no |
| P1-05 | Split parity (linear size, KB, bookmarks, smart defaults) | M | P1-04 | no |
| P1-06 | Page board parity (Shift ranges, interleave, multi-file rotate) | M | P0-02, P0-14 | no |
| P1-07 | Compress coverage (CMYK, 16-bit, Indexed, orphans) plus budgets | L | P0-19 | no |
| P1-08 | Image→PDF formats (TIFF, AVIF, HEIC) and layout | M | P0-12, owner | no |
| P1-09 | Render safety plus image export parity | L | P0-12, P1-03 | no |
| P1-10 | Cancel really stops work | M | P1-09 | no |
| P1-11 | Page numbers and watermark parity (+ Bates) | M | P0-03 | no |
| P1-12 | Protect parity (7 permissions, owner password, permissions-only) | S | P0-07 | no |
| P1-13 | Sign and editor parity (fonts, stamp, presets, mobile, focus) | L | P0-12 | no |
| P1-14 | Form field types | M | P1-13, P1-11 | no |
| P1-15 | Edit existing text and z-order (PDFium) | XL | P1-14 | no |
| P1-16 | OCR 100+ languages, multi-select | M | P0-13 | no |
| P1-17 | PDF/A levels plus PDF/A test gaps | M | P0-01 | no |
| P1-18 | HTML→PDF static parity and honest copy | M | P1-02 | no |
| P1-19 | PDF→PowerPoint colours and pictures | M | P0-08 | no |
| P1-20 | Tool-page content and JSON-LD | L | P0-16 | no |
| P1-21 | Summarize PDF, light version (no model download) | L | P0-16, P0-12 | no |
| P1-22 | e2e smoke for all 31 tools in en/ar/ja | L | P0-01 | yes |
| P1-23 | Regression net for Word, tables, layout, Office | M | P0-01 | yes |
| P2-01 | Browser-enforced privacy proof (CSP plus 0-bytes chip) | M | P0-01, P1-22 | no |
| P2-02 | Compress to target KB plus exam-form kit plus intent pages | L | P1-07, P0-16 | no |
| P2-03 | No limits plus batch everything | L | P1-10, P1-04 | no |
| P2-04 | PWA "Open with" and share target | M | P0-10, P0-16 | no |
| P2-05 | Folder workflows plus shareable recipes | M | P0-10, P2-03 | no |
| P2-06 | On-device AI tier (chat, translate, LLM summary) | XL | P1-21, P2-01 | no |
| P2-07 | Trust-grade redaction plus in-browser PDF/A check | L | P0-05, P1-17 | no |
| P2-08 | PAdES signing plus validation | L | P1-13 | no |
| P2-09 | Structure tools (metadata, bookmarks, flatten, attachments, sanitize, linearize) | L | P0-16, P1-03 | no |
| P2-10 | Print and scan helpers (N-up, booklet, blank removal, greyscale, resize) | L | P2-09 | no |
| P2-11 | Phone scanner v2 (edge detection, perspective) | M | P1-08 | no |
| P2-12 | Live previews for stamps and crop | M | P1-11 | no |
| P2-13 | Compare report export | M | P0-11 | no |
| P2-14 | Localized slugs plus intent pages | M | P1-20, P0-18 | no |
| P2-15 | South Asian and Persian UI and OCR | M | P1-16, P0-18 | no |
| P2-16 | Read aloud plus make accessible | XL | P2-06 | no |
| P2-17 | Form field auto-detect | L | P1-14 | no |
| P2-18 | Homepage promise plus cited comparison table | M | P2-01, owner | no |
| P2-19 | Office export options (LibreOffice filters) | M | P0-15 | no |
| P3-01 | Accessibility pass (contrast, radios, focus, dialog) | M | P1-13 | no |
| P3-02 | Results and console polish | S | P0-15 | no |
| P3-03 | Performance budget plus SW hygiene plus duplicate WASM | M | P0-10, P0-18 | no |
| P3-04 | Repair recovery for truncated and looped files | S | P1-07 | no |
| P3-05 | Browser add-ons (Edge, Firefox) | M | P0-16 | yes |
| P3-06 | Optional Drive/Dropbox import (owner-gated, not recommended) | M | P2-01 | no |
| P3-07 | Local form-autofill profile | M | P1-14 | no |
| P3-08 | Retire or harden the server build | S | owner | no |

**Execution lanes.** Items that share a hot file are serialized. Lanes run in parallel worktrees once P0-01 has made worktree builds work with `TURBOPACK_ROOT`.
- L1 Workspace/UX: P0-02 → P0-14 → P0-12 → P0-15 → P1-06 → P1-10.
- L2 `security.ts`: P0-04 → P0-05 → P0-07 → P1-12 → P2-07.
- L3 `organize.ts`: P0-06 → P1-03 → P1-04 → P1-05.
- L4 `edit.ts`: P0-03 → P1-11 → P1-14 → P2-12.
- L5 `text.ts`: P0-08 → (P0-05) → P1-19.
- L6 SW/build: P0-10 → P0-16 → P0-17 → P0-18.
- L7 OCR: P0-13 → P1-16 → P1-01.
- L8 tests-only: P0-19, P0-09, P1-22, P1-23. These are truly parallel.

**i18n protocol.** All 26 dictionaries are shared, so items only append namespaced keys to `en.ts`. One translation sweep per wave fills the other 25 dictionaries, and `npm run i18n:check` gates the merge.

---

## 5. Decisions only the owner can make
See `owner_decisions`: name and domain, hosting account, operator identity, licences (LGPL HEIC), AI download budget, server build, analytics, comparative claims, store accounts, translation quality bar, TSA timestamping, cloud import, and repo/CI settings.

## 6. Unknowns and the probe that closes each
See `unknowns`. The most urgent is the cause of the e2e and `test:office` CI failures, which needs an authenticated `gh run view 39015444608 --log-failed`.

---

## 7. Clean-room and licence rules for implementers

- **Behavioural facts only.** Nothing from iLovePDF goes into Foliant: no code, UI copy, slugs, icons or template tokens. Their page-number tokens are `{n}`, `{p}`, `{r}`, `{rf}`, so Foliant uses its own names (`{page}`, `{pages}`). Localized slugs come from Foliant's own translated tool names.
- **Allowed directly:** MIT, Apache-2.0, BSD, MPL-2.0, ISC and OFL code and assets. Examples: pdf-lib, pdf.js, qpdf, PDFium, tesseract.js and tessdata, PaddleOCR models, onnxruntime-web, Transformers.js, fflate, jsdiff, pkijs, harfbuzzjs, UTIF.js, OpenCV.js, axe-core, Workbox, coi-serviceworker, @fontsource OFL fonts.
- **Method reference only, never read for code:** GPL and AGPL projects such as MuPDF, Ghostscript, BentoPDF, Marker, and the GPL side of veraPDF. veraPDF runs only as an external CLI in CI.
- **Owner call:** LGPL-3.0 (libheif-js) is acceptable only as a separately loaded, replaceable WASM.
- **Ship notices:** every vendored component's licence text goes out with the build (P0-17); LibreOffice is MPL-2.0 and needs a source pointer.

## 8. Evidence index
- iLovePDF scrape: `scratchpad/ilp_html`, `scratchpad/ilp_js`.
- Verifier scripts: `/private/tmp/claude-501/foliant-verify/*`.
- Fuzz corpus: `/private/tmp/claude-501/foliant-fuzz` (to be ported by P0-19).
- UX audit: `/private/tmp/claude-501/foliant-ux`.
- CI status: `api.github.com/repos/Singhaarav059/Foliant/actions/runs` and the check-run annotations, read on 2026-10-17.
- Not readable in this session: the Next.js 16.4.2 docs under `node_modules/next/dist/docs` (permission denied). AGENTS.md requires reading them before touching metadata, routes or types.
