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
- [ ] 3. Browser e2e (Chromium, WebKit, Firefox)
- [ ] 4a. P2-03 No limits and batch everything
- [ ] 4b. P2-05 Folder workflows and recipe links
- [ ] 4c. P2-07 Trust-grade redaction and PDF/A check
- [ ] 4d. P2-09 Document structure tools
- [ ] 4e. P2-10 Print and scan helper tools
- [ ] 4f. P2-12 Live previews
- [ ] 4g. P2-15 Bengali, Tamil, Telugu, Marathi, Urdu, Persian
- [ ] 4h. P2-16 Read aloud and accessible PDFs
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
