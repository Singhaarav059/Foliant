// document.fonts.ready, except that WebKit can leave it pending for good once
// a face fails (seen with Carlito's Greek Extended subset in a sandboxed
// frame, and with Word's stand-in faces in WebKitGTK), so this also ends when
// no face is still loading, or after 20 s.
export function fontsSettled(doc: Document) {
  return new Promise<void>((done) => {
    const started = Date.now();
    void doc.fonts.ready.then(() => done());
    const poll = () => {
      if (![...doc.fonts].some((f) => f.status === "loading") || Date.now() - started > 20000) done();
      else setTimeout(poll, 50);
    };
    setTimeout(poll, 50);
  });
}
