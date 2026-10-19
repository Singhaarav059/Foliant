// PaddleOCR off the page (see paddle.ts): reads the pages it's sent, one at a
// time, and keeps its models loaded until the page terminates it.
import { readHere } from "./paddle-engine";
import type { Gray } from "./ocrprep";

self.onmessage = async ({ data }: MessageEvent<{ id: number; image: Gray }>) => {
  try {
    self.postMessage({ id: data.id, page: await readHere(data.image) });
  } catch (e) {
    self.postMessage({ id: data.id, error: e instanceof Error ? e.message : String(e) });
  }
};
