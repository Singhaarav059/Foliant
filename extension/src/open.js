// What background.js shows when it can't open a file straight away: asking
// for access to the file's site, or saying why the file didn't open.
const api = globalThis.browser ?? globalThis.chrome;
const params = new URLSearchParams(location.search);
const url = params.get("url") ?? "";
const error = params.get("error");
const $ = (id) => document.getElementById(id);

const ERRORS = {
  scheme: ["This can't be opened", "Nopload can open PDFs from web addresses (http and https). For a file on your computer, open Nopload and drop the file there."],
  network: ["The file didn't download", "The site couldn't be reached. Check your connection and try again."],
  http: ["The file didn't download", "The site answered with error {detail}. The link may have expired, or the file may need you to sign in."],
  notPdf: ["This isn't a PDF", "The link didn't lead to a PDF file. Open the PDF itself, then try again."],
  tooBig: ["This file is too big", "Nopload opens files up to __MAX_MB__ MB."],
};

let host = "";
try {
  host = new URL(url).hostname;
} catch {
  /* no url */
}
$("file").textContent = url;

if (error) {
  const [title, text] = ERRORS[error] ?? ERRORS.network;
  $("title").textContent = title;
  $("text").textContent = text.replace("{detail}", params.get("detail") ?? "");
} else if (host) {
  $("text").textContent = `To open this PDF, the add-on needs your permission to read files from ${host}. It asks once for each site.`;
  const allow = $("allow");
  allow.hidden = false;
  allow.addEventListener("click", () => {
    // Called straight from the click, as permission prompts require.
    api.permissions.request({ origins: [`${new URL(url).protocol}//${host}/*`] }).then((granted) => {
      if (granted) api.runtime.sendMessage({ type: "open", url });
    });
  });
}
