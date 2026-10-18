// Decodes a HEIC/HEIF image to RGBA for src/lib/pdf/images.ts, off the main
// thread. scripts/vendor.mjs copies this next to libheif.js and libheif.wasm
// (libheif-js, LGPL-3.0), which it loads from its own folder, so those two
// files can be swapped for another build without touching the site's code.
//
// In:  { id, buffer }   the file's bytes
// Out: { id, width, height, data } RGBA pixels, or { id, error }
/* global libheif */
importScripts("libheif.js");

let ready = null;
const load = () =>
  (ready ??= new Promise((resolve, reject) => {
    try {
      // The callback can run before libheif() returns.
      const lib = libheif({ onRuntimeInitialized: () => queueMicrotask(() => resolve(lib)), onAbort: (e) => reject(new Error(`libheif: ${e}`)) });
    } catch (e) {
      reject(e);
    }
  }));

self.onmessage = async ({ data: { id, buffer } }) => {
  let decoder = null;
  let images = [];
  try {
    const lib = await load();
    decoder = new lib.HeifDecoder();
    images = decoder.decode(new Uint8Array(buffer));
    // The primary image; the others are alternatives (a burst, a thumbnail).
    const image = images.find((i) => i.is_primary()) ?? images[0];
    if (!image) throw new Error("libheif: no image");
    const width = image.get_width();
    const height = image.get_height();
    const pixels = await new Promise((resolve, reject) =>
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (out) =>
        out ? resolve(out) : reject(new Error("libheif: can't decode"))));
    self.postMessage({ id, width, height, data: pixels.data.buffer }, [pixels.data.buffer]);
  } catch (e) {
    self.postMessage({ id, error: String((e && e.message) || e) });
  } finally {
    for (const i of images) i.free();
    if (decoder && decoder.decoder) ready.then((lib) => lib.heif_context_free(decoder.decoder));
  }
};
