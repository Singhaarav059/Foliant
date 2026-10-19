// Runs on Nopload's own pages. In a tab background.js opened for a file
// (marked by #nopload-extension), it waits until the page says it is ready,
// fetches the file from the add-on and posts it to the page, which takes it
// in with src/lib/extension-handoff.ts. Messages stay inside this tab.
(() => {
  const SITE = "__SITE_URL__";
  if (location.origin !== new URL(SITE).origin || location.hash !== "#nopload-extension") return;
  const api = globalThis.browser ?? globalThis.chrome;
  const post = (msg) => window.postMessage({ source: "nopload-extension", ...msg }, location.origin);
  let asked = false;

  function onMessage(e) {
    if (e.source !== window || e.origin !== location.origin) return;
    if (e.data?.source !== "nopload-site" || e.data.type !== "ready" || asked) return;
    asked = true;
    window.removeEventListener("message", onMessage);
    fetchFile();
  }

  function fetchFile() {
    const port = api.runtime.connect({ name: "nopload-handoff" });
    let name = "";
    let bytes = null;
    let at = 0;
    port.onMessage.addListener((msg) => {
      if (msg.type === "file") {
        name = msg.name;
        bytes = new Uint8Array(msg.size);
      } else if (msg.type === "chunk" && bytes) {
        const bin = atob(msg.data);
        for (let i = 0; i < bin.length; i++) bytes[at + i] = bin.charCodeAt(i);
        at += bin.length;
      } else if (msg.type === "end" && bytes) {
        port.disconnect();
        post({ type: "files", files: [{ name, type: "application/pdf", data: bytes.buffer }] });
      }
    });
  }

  window.addEventListener("message", onMessage);
  // The page may have said "ready" before this script ran; this asks again.
  post({ type: "hello" });
})();
