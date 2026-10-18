// "Open in Nopload": a context-menu entry on PDF links and PDF tabs, and the
// toolbar button. The add-on downloads the PDF itself, opens the site in a
// new tab and hands the bytes to that page through content.js, so the file
// never goes to any server, Nopload's included. Nothing is stored or sent
// anywhere else.
//
// scripts/build-extension.mjs fills in the site, its match pattern and the size limit.
const SITE = "__SITE_URL__";
const MAX_BYTES = __MAX_MB__ * 1024 * 1024; // the site's own limit (LIMITS.mb)
const MARK = "#nopload-extension"; // tells content.js and the page this tab is a handoff
const api = globalThis.browser ?? globalThis.chrome;

// Paths that end in .pdf. Other PDFs can still be opened from their tab with
// the toolbar button: the bytes, not the name, decide whether it's a PDF.
const PDF_URLS = ["pdf", "PDF", "Pdf"].flatMap((ext) => [`*://*/*.${ext}`, `*://*/*.${ext}?*`, `*://*/*.${ext}#*`]);

api.runtime.onInstalled.addListener(async () => {
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: "link", title: "Open in Nopload", contexts: ["link"], targetUrlPatterns: PDF_URLS });
  api.contextMenus.create({ id: "page", title: "Open in Nopload", contexts: ["page", "frame"], documentUrlPatterns: PDF_URLS });
});

api.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === "link" ? info.linkUrl : info.frameUrl || info.pageUrl;
  open(url, { after: tab });
});

api.action.onClicked.addListener((tab) => open(tab.url, { after: tab }));

// From open.html, once the user has allowed access to the file's site.
api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "open" || sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL("open.html"))) return;
  open(msg.url, { reuse: sender.tab?.id });
});

// Files waiting for their Nopload tab to load, by tab id. Kept in memory
// only, and dropped after a couple of minutes if the page never asks.
const pending = new Map();

async function open(url, { after, reuse } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return status({ error: "scheme" }, after, reuse);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return status({ error: "scheme" }, after, reuse);
  // Reading another site's file needs that site's permission, asked for one
  // site at a time on open.html (a page can ask; a menu click in Chrome's
  // service worker can't).
  const origins = [`${u.protocol}//${u.hostname}/*`];
  if (!(await api.permissions.contains({ origins }))) return status({ url: u.href }, after, reuse);
  let file;
  try {
    file = await download(u);
  } catch (e) {
    return status({ url: u.href, error: e.code ?? "network", detail: e.detail }, after, reuse);
  }
  const target = `${SITE}/${MARK}`;
  const tab = reuse != null ? await api.tabs.update(reuse, { url: target }) : await api.tabs.create({ url: target, ...near(after) });
  pending.set(tab.id, file);
  setTimeout(() => pending.get(tab.id) === file && pending.delete(tab.id), 120_000);
}

const near = (tab) => (tab && tab.index >= 0 ? { index: tab.index + 1, openerTabId: tab.id } : {});

function status(params, after, reuse) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null));
  const url = `${api.runtime.getURL("open.html")}?${query}`;
  return reuse != null ? api.tabs.update(reuse, { url }) : api.tabs.create({ url, ...near(after) });
}

const fail = (code, detail) => Object.assign(new Error(code), { code, detail });

async function download(u) {
  let res;
  try {
    // The user's cookies go along, so PDFs behind a sign-in open too.
    res = await fetch(u.href, { credentials: "include" });
  } catch {
    throw fail("network");
  }
  if (!res.ok) throw fail("http", String(res.status));
  if (Number(res.headers.get("content-length")) > MAX_BYTES) throw fail("tooBig");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw fail("tooBig");
  // "%PDF-" within the first kilobyte, as PDF readers accept.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw fail("notPdf");
  return { name: fileName(u, res.headers.get("content-disposition")), bytes };
}

function fileName(u, disposition) {
  let name = "";
  const star = disposition?.match(/filename\*\s*=\s*[\w-]+'[^']*'([^;]+)/i);
  const plain = disposition?.match(/filename\s*=\s*"?([^";]+)"?/i);
  try {
    name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : decodeURIComponent(u.pathname.split("/").pop() ?? "");
  } catch {
    name = "";
  }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 200).trim();
  if (!name) name = "document.pdf";
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

// content.js on the Nopload tab asks for its file once the page is ready.
// Extension messages carry JSON, so the bytes travel as base64 in pieces.
const CHUNK = 1024 * 1024;
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "nopload-handoff") return;
  const tabId = port.sender?.tab?.id;
  let origin = "";
  try {
    origin = new URL(port.sender?.url ?? "").origin;
  } catch {
    /* no url */
  }
  const file = origin === new URL(SITE).origin ? pending.get(tabId) : undefined;
  if (!file) {
    port.postMessage({ type: "none" });
    return port.disconnect();
  }
  pending.delete(tabId);
  port.postMessage({ type: "file", name: file.name, size: file.bytes.length });
  for (let at = 0; at < file.bytes.length; at += CHUNK) port.postMessage({ type: "chunk", data: base64(file.bytes.subarray(at, at + CHUNK)) });
  port.postMessage({ type: "end" });
});

function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// For tests/e2e/extension.mjs, which can't click a browser menu.
globalThis.openInNopload = open;
