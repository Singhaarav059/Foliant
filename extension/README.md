# Open in Nopload (browser add-on)

A Manifest V3 add-on for Chrome, Edge and Firefox. It adds "Open in Nopload" to
PDF links and PDF tabs, and a toolbar button. The add-on downloads the PDF
itself and passes it to the Nopload page in a new tab with `postMessage`
(`src/content.js` → `src/lib/extension-handoff.ts` on the site), so the file is
never uploaded anywhere.

```
NOPLOAD_EXTENSION_SITE_URL=https://your.domain npm run build:extension
```

This writes unpacked folders and store zips to `extension/dist/`. Load
`extension/dist/chrome` from chrome://extensions or edge://extensions (with
developer mode on, choose "Load unpacked"). For Firefox, load
`extension/dist/firefox/manifest.json` from about:debugging → This Firefox.

Tests: `npm run test:extension` checks the manifests and zips.
`npm run test:e2e:extension` loads the add-on in Chromium against the static
build, and `npm run test:e2e:extension:firefox` does the same in a release
Firefox (FIREFOX_PATH) over WebDriver BiDi. `manual-test.md` has the hand checks for the right-click menu, which tests
can't click. `store-listing.md` has the store texts and the privacy statement.
