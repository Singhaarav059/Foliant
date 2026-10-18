// A page of PDF links for testing the add-on by hand (extension/manual-test.md).
// It serves on port 3711. Open it as files.localhost: browsers send any
// *.localhost name to this computer, and other.localhost counts as a second
// site. (Plain localhost may not prompt: Firefox can count the add-on's
// content script on the local Nopload site as access to localhost.) It prints
// every request, so you can see that each file is fetched once, by the add-on.
//
//   node extension/test-page.mjs
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pdf = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/report.pdf"));
const page = `<!doctype html>
<meta charset="utf-8">
<title>Nopload add-on test page</title>
<style>body { font: 16px/1.6 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px } li { margin: 6px 0 } code { color: #666 }</style>
<h1>Add-on test page</h1>
<ol>
  <li><a href="/files/report.pdf">report.pdf</a> <code>a plain .pdf link</code></li>
  <li><a href="/files/Report.PDF">Report.PDF</a> <code>upper-case extension</code></li>
  <li><a href="/files/report.pdf?version=2">report.pdf?version=2</a> <code>with a query</code></li>
  <li><a href="/download?id=7">Download the report</a> <code>no .pdf in the address: no menu entry expected</code></li>
  <li><a href="/files/fake.pdf">fake.pdf</a> <code>a web page posing as a PDF</code></li>
  <li><a href="/files/gone.pdf">gone.pdf</a> <code>404</code></li>
  <li><a href="http://other.localhost:3711/files/report.pdf">report.pdf on other.localhost</a> <code>another site: asks again</code></li>
</ol>
<p>A PDF in a frame:</p>
<iframe src="/files/report.pdf" width="100%" height="400"></iframe>
`;

createServer((req, res) => {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${req.headers.host}${req.url}`);
  if (req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  if (/^\/files\/report\.pdf(\?|$)/i.test(req.url)) return res.writeHead(200, { "content-type": "application/pdf" }).end(pdf);
  if (req.url.startsWith("/download"))
    return res.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=\"Annual report 2026.pdf\"" }).end(pdf);
  if (req.url === "/files/fake.pdf") return res.writeHead(200, { "content-type": "application/pdf" }).end("<html>Please sign in</html>");
  res.writeHead(404).end();
}).listen(3711, () => console.log("Test page: http://files.localhost:3711/"));
