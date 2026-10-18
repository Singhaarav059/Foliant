# Testing the add-on by hand

The automated specs (`tests/e2e/extension*.mjs`) call the menu's handler
directly, because a test can't click a browser's own menus. These steps cover
what they can't: that "Open in Nopload" appears where it should, doesn't
appear where it shouldn't, and that clicking it works. Run them in Chrome,
Edge and Firefox before each store submission. Allow about 15 minutes per
browser.

## Set up (once)

Run each command from the repository root, in its own terminal.

1. Build and serve the site on port 3202:

   ```bash
   npm run build:static && npm run serve:static
   ```

2. Build the add-on for that local site:

   ```bash
   NOPLOAD_EXTENSION_SITE_URL=http://localhost:3202 npm run build:extension
   ```

3. Serve the page of test links on port 3711. Keep this terminal visible: it
   prints every request.

   ```bash
   node extension/test-page.mjs
   ```

## Load the add-on

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, click
  **Load unpacked** and choose `extension/dist/chrome`. Open the puzzle-piece
  menu in the toolbar and pin **Open in Nopload**.
- **Edge:** open `edge://extensions`, turn on **Developer mode**, click **Load
  unpacked** and choose `extension/dist/chrome`. Open the Extensions menu and
  show **Open in Nopload** in the toolbar.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load
  Temporary Add-on…** and choose `extension/dist/firefox/manifest.json`. Open
  the Extensions (puzzle-piece) menu and pin **Open in Nopload**. A temporary
  add-on is removed when Firefox quits.

After rebuilding, click the add-on's reload button on the same page.

Every add-on page should show it without errors. Chrome and Edge show an
**Errors** button when there are errors. In Firefox, click **Inspect** next to
the add-on and check its console.

## Steps

Open http://files.localhost:3711/ in a normal (not private) window. "Right-click"
means right-clicking the numbered link on that page. After each step, close
the tabs it opened.

| # | Do this | Expect |
|---|---|---|
| 1 | Right-click link 1 (`report.pdf`). | The menu has one **Open in Nopload** entry, with the add-on's icon. |
| 2 | Click **Open in Nopload**. | A new tab opens right after the current one. It shows **Open in Nopload** and asks for permission to read files from **files.localhost**. The PDF's address is shown under it. |
| 3 | Click **Allow and open**, then allow in the browser's own prompt. | The same tab goes to `http://localhost:3202/en` (or your language). A bar above the tools says **report.pdf is open. Pick a tool for it.** The address doesn't end in `#nopload-extension`. The test-page terminal shows one request for `/files/report.pdf`. |
| 4 | In that tab, click **Compress PDF**. | Compress opens with `report.pdf` already in the list. The bar is gone. |
| 5 | Back on the test page, right-click link 1 and click **Open in Nopload** again. | No permission page this time: Nopload opens straight away with the bar. |
| 6 | Right-click link 2 (`Report.PDF`) and open it. | The entry is there. Nopload opens with **Report.PDF** in the bar. |
| 7 | Right-click link 3 (`?version=2`) and open it. | The entry is there. Nopload opens with **report.pdf** in the bar. |
| 8 | Right-click link 4 (**Download the report**). | **No** Open in Nopload entry. Its address has no `.pdf`, so the add-on can't tell it's a PDF without downloading it. |
| 9 | Right-click link 5 (`fake.pdf`) and open it. | The add-on's page says **This isn't a PDF**. Nopload doesn't open. |
| 10 | Right-click link 6 (`gone.pdf`) and open it. | The add-on's page says **The file didn't download** and mentions **error 404**. |
| 11 | Right-click link 7 (other.localhost) and open it. | It asks for permission again, now for **other.localhost**. Permission is granted one site at a time. Click **Allow and open**: Nopload opens with the bar. |
| 12 | Right-click a part of the test page that isn't a link. | **No** Open in Nopload entry. |
| 13 | Right-click inside the PDF in the frame at the bottom. | Note whether the entry appears (see "Known gaps"). If it does, click it: Nopload opens with **report.pdf**. |
| 14 | Click link 1 so the PDF opens in the tab, then right-click the PDF. | Note whether the entry appears (see "Known gaps"). If it does, click it: Nopload opens with the file. |
| 15 | With the PDF from step 14 still showing, click the **Open in Nopload** toolbar button. | Nopload opens in a new tab with **report.pdf** in the bar. |
| 16 | Go to http://files.localhost:3711/ and click the toolbar button there. | The add-on's page says **This isn't a PDF**. The button works on any tab and checks the file's contents. |
| 17 | Tab to link 1 with the keyboard. Open the context menu with the Menu key or Shift+F10. Choose the entry with the arrow keys and Enter. | Same as step 5. |
| 18 | Open the test page in a private window and right-click link 1. | **No** entry. Add-ons are off in private windows unless the user allows them, and that is expected. If you turn on **Allow in Incognito** (Chrome, Edge) or **Run in Private Windows** (Firefox), it should then work like step 5. |
| 19 | Open http://localhost:3202/en directly. | No bar. A normal visit is untouched. |
| 20 | Look over the test-page terminal. | Each step that opened something added exactly one request (loading the test page adds two: the page and the PDF in its frame). The permission pages added none. Nothing arrived after a Nopload tab opened. |

Also try these on a real site: a PDF link on a page that needs you to be
signed in, if you have one, and a public PDF such as
https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf (from step
1 onward).

## Known gaps (not failures)

- **Built-in PDF viewers (steps 13 and 14):** Chrome and Edge show their own
  right-click menu inside a PDF, which may leave out add-on entries. Firefox's
  viewer usually includes them. The toolbar button (step 15) covers this case.
  Record what you see so the store listing describes it accurately.
- **Links without `.pdf` (step 8):** no entry appears, by design. Opening one
  usually downloads the file instead of showing it, so the toolbar button
  doesn't help either.
- **`file://` PDFs:** not supported. The add-on's page asks you to drop the
  file into Nopload instead.

## Troubleshooting

- **Nopload opens but no bar appears:** the add-on was probably built for a
  different address than the one the site is served at. The protocol, host
  and port must match exactly: `http://localhost:3202`, not `127.0.0.1:3202`.
  In Firefox, also check `about:addons` → Open in Nopload → **Permissions**,
  and make sure access to localhost is on.
- **files.localhost doesn't load:** use a current Chrome, Edge or Firefox; all
  of them send `*.localhost` names to your own computer.
- **The toolbar button does nothing:** check the add-on's errors (see "Load the
  add-on").

## Record

| Browser and version | Steps passed | Steps 13 and 14: entry shown? | Notes |
|---|---|---|---|
| Chrome | | | |
| Edge | | | |
| Firefox | | | |
