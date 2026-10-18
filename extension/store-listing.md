# Store listing: Open in Nopload

Copy these texts into the Chrome Web Store, Microsoft Edge Add-ons and
Firefox Add-ons (AMO) forms. Replace `https://nopload.example` with the live
site address first. The build already uses that address: it comes from
NOPLOAD_EXTENSION_SITE_URL or NEXT_PUBLIC_SITE_URL.

## Name

Open in Nopload

## Short description (132 characters at most)

Right-click a PDF link or PDF tab and open it in Nopload's free PDF tools. No uploads, no tracking.

## Category

Productivity (Chrome, Edge) · Other (Firefox)

## Description

Open any PDF in Nopload with one click. You can then merge, split, compress, convert, sign, protect or edit it.

- Right-click a link to a PDF and choose "Open in Nopload".
- Viewing a PDF? Click the Nopload button in the toolbar, or right-click the page.
- Nopload opens in a new tab with your file loaded. Pick a tool and go.

Private by design. The add-on downloads the PDF in your browser and passes it straight to the Nopload tab. Nopload's tools run on your device, so your file never goes to a server, Nopload's included.

Small permissions. The add-on asks for access to a website only when you first open a PDF from it, and only for that site.

Free and open source under the MIT licence: https://github.com/Singhaarav059/Foliant

## Privacy statement

Open in Nopload collects no data.

- It does not collect, store, sell or share any personal or usage data.
- It has no analytics, no tracking and no ads, and it makes no requests of its own to any server.
- When you choose "Open in Nopload", it downloads that one PDF from the site you are on, in your browser, and hands it to the Nopload page in a new tab. The file is not uploaded anywhere. It stays in memory until Nopload has it, then the add-on forgets it.
- It keeps no history and writes nothing to storage.

Firefox: the manifest declares `data_collection_permissions: { required: ["none"] }`.

Chrome Web Store "Privacy practices" tab: tick none of the data types. Certify that the add-on doesn't sell or transfer user data, doesn't use it for unrelated purposes, and doesn't use it to determine creditworthiness.

## Single purpose (Chrome Web Store)

Open a PDF from the web in the Nopload PDF tools website.

## Permission justifications (Chrome Web Store, Edge)

- **contextMenus**: adds the "Open in Nopload" entry for PDF links and PDF pages.
- **activeTab**: when you click the toolbar button, reads the address of the current tab, so the PDF you are viewing can be opened.
- **Optional host permissions (http and https sites)**: needed to download the PDF you chose. The add-on asks for each site separately, the first time you open a PDF from it. It never asks for all sites at once.
- **Content script on the Nopload site**: hands the downloaded PDF to the Nopload page in the tab the add-on opened. It runs only on the Nopload site.
- **Remote code**: none. All code ships in the package.

## Screenshots to make (1280×800)

1. The right-click menu on a PDF link, showing "Open in Nopload".
2. Nopload's home page with the "… is open. Pick a tool for it." bar and the tool grid.
3. A tool (for example Compress) with the file loaded.

## Test instructions for reviewers

1. Open any page that links to a PDF, for example https://www.w3.org/WAI/WCAG21/working-examples/pdf-table/table.pdf.
2. Right-click the link and choose "Open in Nopload". Allow access to that site when asked.
3. A Nopload tab opens with the file. Choose a tool.
